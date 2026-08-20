import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Agentation } from "agentation";
import { CalendarHeatmap } from "./components/CalendarHeatmap";
import { AfkStrip } from "./components/AfkStrip";
import { CumulativeChart, type TodayCumulative } from "./components/CumulativeChart";
import { DayPrint } from "./components/DayPrint";
import { DayScorecard } from "./components/DayScorecard";
import {
  CategoryManager,
  type Category,
  type CategoryKind,
  type Rule,
  type RuleMatchType,
} from "./components/CategoryManager";
import { ScorePanel, type TodayScoring } from "./components/ScorePanel";
import { CategoryMark } from "./components/CategoryIcon";
import { TrendsStacked } from "./components/TrendsStacked";
import { TrendsTrend } from "./components/TrendsTrend";
import type { ProgressOverview } from "./progress";
import { formatLocalDate, type AfkDay, type DailySeriesDay } from "./trends";
import {
  renderChallengePng,
  renderDayPrintPng,
  renderWeekPng,
  savePng,
  type DayPrintData,
  type KindLabels,
  type WeekSummaryData,
} from "./share";
import { MiniView } from "./MiniView";
import { parseMiniSettings, type MiniMode, type MiniTextSize } from "./miniSettings";
import { nextRulePriority, titleRulePattern } from "./classification";
import { localizedDuration } from "./duration";
import { langNames, localeForLang, type Lang } from "./i18n";
import { I18nProvider, useI18n } from "./i18nContext";
import "./styles/tokens.css";
import "./App.css";
import "./category-manager.css";

interface Segment {
  id: number;
  ts_start: number;
  ts_end: number;
  app: string;
  window_title: string;
  domain: string;
  category_id: number;
  status: "active" | "crashed" | "away" | "paused";
}

interface TodayStats {
  useful_ms: number;
  neutral_ms: number;
  waste_ms: number;
  observed_ms: number;
}

interface AppToday {
  app: string;
  duration_ms: number;
  useful_ms: number;
  neutral_ms: number;
  waste_ms: number;
}

interface AppTimelineItem extends AppToday {
  segments: Segment[];
  sessions: DisplaySession[];
  lastSegment: Segment;
  isLive: boolean;
}

interface DisplaySession {
  id: string;
  segmentIds: number[];
  segments: Segment[];
}

interface ClassificationTarget {
  segmentId: number;
  anchor: string;
}

type ClassificationScope = "single" | "title" | "app";

interface ReclassificationSummary {
  changed_segments: number;
  changed_duration_ms: number;
}

interface ClassificationMatchStats {
  match_count: number;
  manual_count: number;
}

interface ManualRuleScope {
  matchType: RuleMatchType;
  pattern: string;
}

interface UpdateInfo {
  version: string;
}

interface UpdateProgress {
  downloaded: number;
  total: number;
}

type UpdateCheck = "unknown" | "checking" | "available" | "latest" | "error";

const EMPTY_STATS: TodayStats = {
  useful_ms: 0,
  neutral_ms: 0,
  waste_ms: 0,
  observed_ms: 0,
};

function formatTime(timestamp: number, lang: Lang): string {
  return new Intl.DateTimeFormat(localeForLang(lang), {
    hour: "2-digit",
    minute: "2-digit",
  }).format(timestamp);
}

function cleanAppName(app: string): string {
  return app.replace(/\.exe$/i, "");
}

function segmentDuration(segment: Segment, liveSegmentId: number | undefined, now: number): number {
  const end = segment.id === liveSegmentId ? now : segment.ts_end;
  return Math.max(0, end - segment.ts_start);
}

const POLLING_INTERVAL_MS = 5_000;

function normalizeVisibleTitle(title: string): string {
  return title.trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

function canJoinDisplaySession(previous: Segment, next: Segment): boolean {
  const gap = next.ts_start - previous.ts_end;
  return previous.status === "active"
    && next.status === "active"
    && gap >= 0
    && gap <= POLLING_INTERVAL_MS
    && previous.app === next.app
    && normalizeVisibleTitle(previous.window_title) === normalizeVisibleTitle(next.window_title)
    && previous.domain === next.domain
    && previous.category_id === next.category_id;
}

function groupSegments(segments: Segment[]): DisplaySession[] {
  const sessions: DisplaySession[] = [];
  const chronological = [...segments].sort((left, right) => left.ts_start - right.ts_start || left.id - right.id);

  for (const segment of chronological) {
    const current = sessions[sessions.length - 1];
    const previous = current?.segments[current.segments.length - 1];
    if (previous && canJoinDisplaySession(previous, segment)) {
      current.segmentIds.push(segment.id);
      current.segments.push(segment);
    } else {
      sessions.push({
        id: `session-${segment.id}`,
        segmentIds: [segment.id],
        segments: [segment],
      });
    }
  }

  return sessions.reverse();
}

function DashboardView() {
  const { lang, setLang, t } = useI18n();
  const formatDuration = useCallback((milliseconds: number) => localizedDuration(milliseconds, t), [t]);
  const defaultKindLabels: KindLabels = {
    useful: t("mini.defaultUseful"),
    neutral: t("mini.defaultNeutral"),
    waste: t("mini.defaultWaste"),
    observed: t("common.accounted"),
  };
  const [segments, setSegments] = useState<Segment[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [stats, setStats] = useState<TodayStats>(EMPTY_STATS);
  const [progress, setProgress] = useState<ProgressOverview | null>(null);
  const [cumulative, setCumulative] = useState<TodayCumulative | null>(null);
  const [dailySeries, setDailySeries] = useState<DailySeriesDay[]>([]);
  const [dayCumulativeDate, setDayCumulativeDate] = useState<string>("");
  const [dayCumulative, setDayCumulative] = useState<TodayCumulative | null>(null);
  const [dayCumulativeLoading, setDayCumulativeLoading] = useState(false);
  const [afkSeries, setAfkSeries] = useState<AfkDay[]>([]);
  const [dayPrint, setDayPrint] = useState<DayPrintData | null>(null);
  const [dayPrintDates, setDayPrintDates] = useState<string[]>([]);
  const [dayPrintDate, setDayPrintDate] = useState("");
  const [shareBusy, setShareBusy] = useState<"day" | "week" | "challenge" | null>(null);
  const [shareMessage, setShareMessage] = useState<string | null>(null);
  const [dashboardView, setDashboardView] = useState<"today" | "trends">("today");
  const [trendsRange, setTrendsRange] = useState<7 | 30>(7);
  const [apps, setApps] = useState<AppToday[]>([]);
  const [scoring, setScoring] = useState<TodayScoring | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const [dark, setDark] = useState(false);
  const [paused, setPaused] = useState(false);
  const [autostart, setAutostart] = useState(false);
  const [expandedApps, setExpandedApps] = useState<Set<string>>(new Set());
  const [selectedApp, setSelectedApp] = useState<string | null>(null);
  const [expandedSessions, setExpandedSessions] = useState<Set<string>>(new Set());
  const [classificationTarget, setClassificationTarget] = useState<ClassificationTarget | null>(null);
  const [classificationCategoryId, setClassificationCategoryId] = useState(0);
  const [classificationScope, setClassificationScope] = useState<ClassificationScope>("single");
  const [classificationSaving, setClassificationSaving] = useState(false);
  const [classificationMatchStats, setClassificationMatchStats] = useState<ClassificationMatchStats | null>(null);
  const [overwriteManual, setOverwriteManual] = useState(false);
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [categoryManagerOpen, setCategoryManagerOpen] = useState(false);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [updateCheck, setUpdateCheck] = useState<UpdateCheck>("unknown");
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const [updateDownloading, setUpdateDownloading] = useState(false);
  const [updateProgress, setUpdateProgress] = useState<UpdateProgress | null>(null);
  const [updateInstallError, setUpdateInstallError] = useState<string | null>(null);
  const [installedVersion, setInstalledVersion] = useState<string | null>(null);
  const startupUpdateCheckStarted = useRef(false);
  const [extensionChromeId, setExtensionChromeId] = useState("");
  const [extensionEdgeId, setExtensionEdgeId] = useState("");
  const [kindLabelUseful, setKindLabelUseful] = useState(defaultKindLabels.useful);
  const [kindLabelNeutral, setKindLabelNeutral] = useState(defaultKindLabels.neutral);
  const [kindLabelWaste, setKindLabelWaste] = useState(defaultKindLabels.waste);
  const [kindLabelObserved, setKindLabelObserved] = useState(defaultKindLabels.observed);
  const [usefulGoalMin, setUsefulGoalMin] = useState("120");
  const [wasteLimitMin, setWasteLimitMin] = useState("60");
  const [observedMin, setObservedMin] = useState("60");
  const [hourlyRate, setHourlyRate] = useState("");
  const [currency, setCurrency] = useState("₴");
  const [miniMode, setMiniMode] = useState<MiniMode>("auto");
  const [miniTextSize, setMiniTextSize] = useState<MiniTextSize>("normal");
  const [miniPrivacyNow, setMiniPrivacyNow] = useState(false);
  const [showMiniAtLaunch, setShowMiniAtLaunch] = useState(false);
  const [miniOpacity, setMiniOpacity] = useState(100);
  const [miniClickThrough, setMiniClickThrough] = useState(false);
  const [miniCornerPinned, setMiniCornerPinned] = useState(false);
  const [challengeInput, setChallengeInput] = useState("");
  const [challengeError, setChallengeError] = useState<string | null>(null);
  const [challengeImported, setChallengeImported] = useState(false);
  const [dbSizeMb, setDbSizeMb] = useState<number | null>(null);
  const [tokenCopied, setTokenCopied] = useState(false);
  const [tokenRevealed, setTokenRevealed] = useState(false);
  const [managerNotice, setManagerNotice] = useState<string | null>(null);

  const loadDashboard = useCallback(async () => {
    try {
      const [nextSegments, nextCategories, nextProgress, nextCumulative, nextDailySeries, nextAfkSeries, nextApps, nextScoring, nextSettings, trackingPaused, nextAutostart, nextDayPrintDates] =
        await Promise.all([
          invoke<Segment[]>("get_today_segments"),
          invoke<Category[]>("get_categories"),
          invoke<ProgressOverview>("get_progress_overview"),
          invoke<TodayCumulative>("get_today_cumulative"),
          invoke<DailySeriesDay[]>("get_daily_series", { days: 36 }),
          invoke<AfkDay[]>("get_afk_series", { days: 30 }),
          invoke<AppToday[]>("get_apps_today"),
          invoke<TodayScoring>("get_today_scoring"),
          invoke<Record<string, string>>("get_settings"),
          invoke<boolean>("get_tracking_paused"),
          invoke<boolean>("get_autostart"),
          invoke<string[]>("get_day_print_dates"),
        ]);
      setSegments(nextSegments);
      setCategories(nextCategories);
      setProgress(nextProgress);
      setCumulative(nextCumulative);
      setDailySeries(nextDailySeries);
      setDayCumulativeDate((current) => current || (nextDailySeries.length > 0 ? nextDailySeries[nextDailySeries.length - 1].local_date : ""));
      setAfkSeries(nextAfkSeries);
      setStats(nextProgress.today);
      setApps(nextApps);
      setScoring(nextScoring);
      setDayPrintDates(nextDayPrintDates);
      const targetDate = dayPrintDate || nextProgress.today.local_date;
      setSettings(nextSettings);
      setDayPrintDate(targetDate);
      setDayPrint(await invoke<DayPrintData>("get_day_print", { localDate: targetDate }));
      setDark(nextSettings.theme === "dark");
      setPaused(trackingPaused);
      setAutostart(nextAutostart);
      setError(null);
    } catch (reason: unknown) {
      setError(typeof reason === "string" ? reason : t("error.loadData"));
    } finally {
      setLoading(false);
    }
  }, [dayPrintDate, t]);

  useEffect(() => {
    if (dayCumulativeDate === "") return;
    setDayCumulativeLoading(true);
    let active = true;
    void invoke<TodayCumulative>("get_day_cumulative", { localDate: dayCumulativeDate })
      .then((data) => {
        if (active) {
          setDayCumulative(data);
          setDayCumulativeLoading(false);
        }
      })
      .catch(() => {
        if (active) {
          setDayCumulative(null);
          setDayCumulativeLoading(false);
        }
      });
    return () => {
      active = false;
    };
  }, [dayCumulativeDate]);

  useEffect(() => {
    void loadDashboard();
    const refresh = window.setInterval(() => void loadDashboard(), 5_000);
    const clock = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => {
      window.clearInterval(refresh);
      window.clearInterval(clock);
    };
  }, [loadDashboard]);

  useEffect(() => {
    if (loading || startupUpdateCheckStarted.current) return;
    startupUpdateCheckStarted.current = true;
    void checkForUpdates(true);
  }, [loading]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;
    void listen<UpdateProgress>("update://progress", (event) => {
      if (!disposed) setUpdateProgress(event.payload);
    }).then((stopListening) => {
      if (disposed) stopListening();
      else unlisten = stopListening;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = dark ? "dark" : "";
  }, [dark]);

  useEffect(() => {
    if (!managerNotice) return;
    const timeout = window.setTimeout(() => setManagerNotice(null), 5_000);
    return () => window.clearTimeout(timeout);
  }, [managerNotice]);

  useEffect(() => {
    if (selectedApp === null) return;
    const clearSelection = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSelectedApp(null);
    };
    window.addEventListener("keydown", clearSelection);
    return () => window.removeEventListener("keydown", clearSelection);
  }, [selectedApp]);

  useEffect(() => {
    if (!settingsOpen) return;
    setExtensionChromeId(settings.extension_chrome_id ?? "");
    setExtensionEdgeId(settings.extension_edge_id ?? "");
  }, [settings.extension_chrome_id, settings.extension_edge_id, settingsOpen]);

  useEffect(() => {
    if (settingsOpen) return;
    setTokenRevealed(false);
    setTokenCopied(false);
  }, [settingsOpen]);

  useEffect(() => {
    if (!settingsOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !settingsSaving && !updateDownloading) setSettingsOpen(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [settingsOpen, settingsSaving, updateDownloading]);

  useEffect(() => {
    if (!classificationTarget) return;
    const closeMenu = (event: PointerEvent) => {
      const element = event.target instanceof Element ? event.target : null;
      if (!element?.closest('[data-classification-root="true"]')) setClassificationTarget(null);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !classificationSaving) setClassificationTarget(null);
    };
    window.addEventListener("pointerdown", closeMenu);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("pointerdown", closeMenu);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [classificationTarget, classificationSaving]);

  const classificationSegment = classificationTarget
    ? segments.find((item) => item.id === classificationTarget.segmentId)
    : undefined;
  const classificationMatchType = classificationScope === "title"
    ? "title"
    : classificationScope === "app" ? "exe" : null;
  const classificationPattern = classificationSegment && classificationMatchType
    ? classificationMatchType === "title"
      ? titleRulePattern(classificationSegment.window_title)
      : classificationSegment.app
    : "";

  useEffect(() => {
    if (!classificationTarget || !classificationMatchType || !classificationPattern) {
      setClassificationMatchStats(null);
      return;
    }
    let active = true;
    setClassificationMatchStats(null);
    void invoke<ClassificationMatchStats>("get_classification_match_stats", {
      matchType: classificationMatchType,
      pattern: classificationPattern,
      matchMode: "legacy",
      caseInsensitive: true,
    })
      .then((stats) => {
        if (active) setClassificationMatchStats(stats);
      })
      .catch((reason: unknown) => {
        if (active) setError(typeof reason === "string" ? reason : t("error.loadData"));
      });
    return () => {
      active = false;
    };
  }, [classificationMatchType, classificationPattern, classificationTarget, t]);

  const categoryById = useMemo(
    () => new Map(categories.map((category) => [category.id, category])),
    [categories],
  );
  const manageableCategories = useMemo(
    () => categories.filter((category) => category.id !== 0),
    [categories],
  );
  const latestSegment = segments[segments.length - 1];
  const live = !paused && latestSegment?.status === "active" && now - latestSegment.ts_end <= 10_000
    ? latestSegment
    : undefined;
  const displaySessions = useMemo(() => groupSegments(segments), [segments]);
  const kindLabels = useMemo<KindLabels>(() => ({
    useful: settings.kind_label_useful ?? defaultKindLabels.useful,
    neutral: settings.kind_label_neutral ?? defaultKindLabels.neutral,
    waste: settings.kind_label_waste ?? defaultKindLabels.waste,
    observed: settings.kind_label_observed ?? defaultKindLabels.observed,
  }), [settings, t]);
  const appTimeline = useMemo<AppTimelineItem[]>(() => apps
    .map((app) => {
      const appSegments = segments.filter((segment) =>
        segment.app === app.app,
      );
      const lastSegment = appSegments[appSegments.length - 1];
      if (!lastSegment) return null;
      const isLive = live?.app === app.app;
      return {
        ...app,
        duration_ms: app.duration_ms + (isLive ? Math.max(0, now - live.ts_end) : 0),
        segments: appSegments,
        sessions: displaySessions.filter((session) => session.segments[0]?.app === app.app),
        lastSegment,
        isLive,
      };
    })
    .filter((app): app is AppTimelineItem => app !== null)
    .sort((left, right) => Number(right.isLive) - Number(left.isLive) || right.duration_ms - left.duration_ms),
  [apps, displaySessions, live, now, segments]);
  const totalRing = Math.max(stats.observed_ms, 1);
  const ringParts = [
    { kind: "useful" as const, value: stats.useful_ms },
    { kind: "neutral" as const, value: stats.neutral_ms },
    { kind: "waste" as const, value: stats.waste_ms },
  ];
  let ringOffset = 0;
  const maxAppDuration = Math.max(...apps.map((app) => app.duration_ms), 1);
  const maxTimelineAppDuration = Math.max(...appTimeline.map((app) => app.duration_ms), 1);

  async function setTheme(nextDark: boolean) {
    setDark(nextDark);
    try {
      await invoke("set_setting", {
        key: "theme",
        value: nextDark ? "dark" : "dawn",
      });
    } catch (reason: unknown) {
      setError(typeof reason === "string" ? reason : t("error.saveTheme"));
    }
  }

  async function changeLanguage(nextLang: Lang) {
    try {
      await setLang(nextLang);
      setSettings((current) => ({ ...current, language: nextLang }));
    } catch (reason: unknown) {
      setError(typeof reason === "string" ? reason : t("error.saveSettings"));
    }
  }

  async function reclassifyHistory(
    overwriteManualCategories: boolean,
    manualRuleScope?: ManualRuleScope,
  ): Promise<void> {
    const summary = await invoke<ReclassificationSummary>("reclassify_history", {
      overwriteManual: overwriteManualCategories,
      manualMatchType: manualRuleScope?.matchType ?? null,
      manualPattern: manualRuleScope?.pattern ?? null,
      confirmed: true,
    });
    const totalMinutes = Math.floor(summary.changed_duration_ms / 60_000);
    setManagerNotice(t("toast.history", { hours: Math.floor(totalMinutes / 60), minutes: totalMinutes % 60 }));
  }

  async function reclassify(segment: Segment, categoryId: number, scope: ClassificationScope) {
    setClassificationSaving(true);
    try {
      const createsRule = categoryId !== 0 && scope !== "single";
      const priority = createsRule
        ? nextRulePriority(await invoke<Rule[]>("get_rules"))
        : null;
      await invoke("set_segment_category", {
        segmentId: segment.id,
        categoryId: categoryId === 0 ? null : categoryId,
        remember: categoryId !== 0 && scope === "app",
        rulePriority: priority,
      });
      if (categoryId !== 0 && scope === "title") {
        await invoke<Rule>("create_rule", {
          matchType: "title",
          pattern: titleRulePattern(segment.window_title),
          categoryId,
          priority,
          matchMode: "legacy",
          caseInsensitive: true,
        });
      }
      if (categoryId !== 0 && scope !== "single") {
        const manualRuleScope: ManualRuleScope | undefined = overwriteManual ? {
          matchType: scope === "title" ? "title" : "exe",
          pattern: scope === "title" ? titleRulePattern(segment.window_title) : segment.app,
        } : undefined;
        await reclassifyHistory(overwriteManual, manualRuleScope);
      }
      setClassificationTarget(null);
      await loadDashboard();
    } catch (reason: unknown) {
      setError(typeof reason === "string" ? reason : t("error.changeCategory"));
    } finally {
      setClassificationSaving(false);
    }
  }

  async function toggleTracking() {
    const nextPaused = !paused;
    setPaused(nextPaused);
    try {
      await invoke("set_tracking_paused", { paused: nextPaused });
      await loadDashboard();
    } catch (reason: unknown) {
      setPaused(!nextPaused);
      setError(typeof reason === "string" ? reason : t("error.changeTracking"));
    }
  }

  async function toggleAutostart(enabled: boolean) {
    setAutostart(enabled);
    try {
      await invoke<void>("set_autostart", { enabled });
    } catch (reason: unknown) {
      setAutostart(!enabled);
      setSettingsError(typeof reason === "string" ? reason : t("error.changeAutostart"));
    }
  }

  async function checkForUpdates(silent = false) {
    setUpdateCheck("checking");
    setUpdateInfo(null);
    setUpdateError(null);
    setUpdateInstallError(null);
    try {
      const info = await invoke<UpdateInfo | null>("check_for_updates");
      if (info) {
        setUpdateInfo(info);
        setUpdateCheck("available");
      } else {
        setUpdateCheck("latest");
      }
    } catch (reason: unknown) {
      const message = reason instanceof Error ? reason.message : String(reason);
      if (silent) {
        setUpdateCheck("unknown");
      } else {
        setUpdateError(message);
        setUpdateCheck("error");
      }
    }
  }

  async function installUpdate() {
    if (!updateInfo) return;
    setUpdateDownloading(true);
    setUpdateProgress({ downloaded: 0, total: 0 });
    setUpdateInstallError(null);
    try {
      await invoke<void>("download_and_install_update", { version: updateInfo.version });
      setUpdateDownloading(false);
    } catch (reason: unknown) {
      const message = reason instanceof Error ? reason.message : String(reason);
      setUpdateInstallError(message);
      setUpdateDownloading(false);
    }
  }

  async function openSettings() {
    setExtensionChromeId(settings.extension_chrome_id ?? "");
    setExtensionEdgeId(settings.extension_edge_id ?? "");
    setKindLabelUseful(settings.kind_label_useful ?? defaultKindLabels.useful);
    setKindLabelNeutral(settings.kind_label_neutral ?? defaultKindLabels.neutral);
    setKindLabelWaste(settings.kind_label_waste ?? defaultKindLabels.waste);
    setKindLabelObserved(settings.kind_label_observed ?? defaultKindLabels.observed);
    setUsefulGoalMin(settings.useful_goal_min ?? "120");
    setWasteLimitMin(settings.waste_limit_min ?? "60");
    setObservedMin(settings.observed_min ?? "60");
    setHourlyRate(settings.hourly_rate ?? "");
    setCurrency(settings.currency ?? "₴");
    const miniSettings = parseMiniSettings(settings);
    setMiniMode(miniSettings.mode);
    setMiniTextSize(miniSettings.textSize);
    setMiniPrivacyNow(miniSettings.privacyNow);
    setShowMiniAtLaunch(miniSettings.showAtLaunch);
    setMiniOpacity(miniSettings.opacity);
    setMiniClickThrough(miniSettings.clickThrough);
    setMiniCornerPinned(miniSettings.cornerPinned);
    setChallengeInput("");
    setChallengeError(null);
    setChallengeImported(false);
    setDbSizeMb(null);
    setTokenCopied(false);
    setTokenRevealed(false);
    setSettingsError(null);
    setSettingsOpen(true);
    setInstalledVersion(null);
    void getVersion().then(setInstalledVersion).catch(() => setInstalledVersion(null));
    try {
      setDbSizeMb(await invoke<number>("get_db_size_mb"));
    } catch (reason: unknown) {
      setSettingsError(typeof reason === "string" ? reason : t("error.dbSize"));
    }
  }

  async function copyExtensionToken() {
    const token = settings.extension_token ?? "";
    if (!token) return;
    try {
      await navigator.clipboard.writeText(token);
      setTokenCopied(true);
      setSettingsError(null);
    } catch {
      setSettingsError(t("error.copyToken"));
    }
  }

  function toggleApp(app: string) {
    setExpandedApps((current) => {
      const next = new Set(current);
      if (next.has(app)) next.delete(app);
      else next.add(app);
      return next;
    });
  }

  function selectTimelineSegment(segmentId: number) {
    const segment = segments.find((item) => item.id === segmentId);
    if (!segment) return;
    setExpandedApps((current) => new Set(current).add(segment.app));
    const session = displaySessions.find((item) => item.segmentIds.includes(segmentId));
    if (session && session.segmentIds.length > 1) {
      setExpandedSessions((current) => new Set(current).add(session.id));
    }
    openClassification(segment, `segment-${segment.id}`);
  }

  function openClassification(segment: Segment, anchor: string) {
    setClassificationTarget({ segmentId: segment.id, anchor });
    setClassificationCategoryId(segment.category_id || 0);
    setClassificationScope("single");
    setClassificationMatchStats(null);
    setOverwriteManual(false);
  }

  async function saveSettings() {
    const chromeId = extensionChromeId.trim();
    const edgeId = extensionEdgeId.trim();
    const nextKindLabels: KindLabels = {
      useful: kindLabelUseful.trim(),
      neutral: kindLabelNeutral.trim(),
      waste: kindLabelWaste.trim(),
      observed: kindLabelObserved.trim(),
    };
    const isValidId = (value: string) => value === "" || /^[a-p]{32}$/.test(value);
    if (!isValidId(chromeId) || !isValidId(edgeId)) {
      setSettingsError(t("validation.extensionId"));
      return;
    }
    if (Object.values(nextKindLabels).some((label) => label.length === 0 || [...label].length > 80)) {
      setSettingsError(t("validation.kindLabels"));
      return;
    }
    const goals = [usefulGoalMin, wasteLimitMin, observedMin];
    if (goals.some((value) => !/^\d+$/.test(value) || Number(value) > 1440)) {
      setSettingsError(t("validation.goals"));
      return;
    }
    if (hourlyRate !== "" && (!/^\d+(?:[.,]\d+)?$/.test(hourlyRate) || Number(hourlyRate.replace(",", ".")) < 0)) {
      setSettingsError(t("validation.hourlyRate"));
      return;
    }
    setSettingsSaving(true);
    setSettingsError(null);
    try {
      // Последовательная запись сохраняет целостный снимок целей на текущую дату.
      await invoke<void>("set_setting", { key: "useful_goal_min", value: usefulGoalMin });
      await invoke<void>("set_setting", { key: "waste_limit_min", value: wasteLimitMin });
      await invoke<void>("set_setting", { key: "observed_min", value: observedMin });
      await invoke<void>("set_setting", { key: "hourly_rate", value: hourlyRate.replace(",", ".") });
      await invoke<void>("set_setting", { key: "currency", value: currency });
      await Promise.all([
        invoke<void>("set_setting", { key: "extension_chrome_id", value: chromeId }),
        invoke<void>("set_setting", { key: "extension_edge_id", value: edgeId }),
        invoke<void>("set_setting", { key: "kind_label_useful", value: nextKindLabels.useful }),
        invoke<void>("set_setting", { key: "kind_label_neutral", value: nextKindLabels.neutral }),
        invoke<void>("set_setting", { key: "kind_label_waste", value: nextKindLabels.waste }),
        invoke<void>("set_setting", { key: "kind_label_observed", value: nextKindLabels.observed }),
        invoke<void>("set_setting", { key: "mini_mode", value: miniMode }),
        invoke<void>("set_setting", { key: "mini_text_size", value: miniTextSize }),
        invoke<void>("set_setting", { key: "mini_privacy_now", value: miniPrivacyNow ? "1" : "0" }),
        invoke<void>("set_setting", { key: "tray_only", value: showMiniAtLaunch ? "0" : "1" }),
        invoke<void>("set_setting", { key: "mini_opacity", value: String(miniOpacity) }),
        invoke<void>("set_setting", { key: "mini_click_through", value: miniClickThrough ? "1" : "0" }),
      ]);
      setSettings((current) => ({
        ...current,
        extension_chrome_id: chromeId,
        extension_edge_id: edgeId,
        kind_label_useful: nextKindLabels.useful,
        kind_label_neutral: nextKindLabels.neutral,
        kind_label_waste: nextKindLabels.waste,
        kind_label_observed: nextKindLabels.observed,
        useful_goal_min: usefulGoalMin,
        waste_limit_min: wasteLimitMin,
        observed_min: observedMin,
        hourly_rate: hourlyRate.replace(",", "."),
        currency,
        mini_mode: miniMode,
        mini_text_size: miniTextSize,
        mini_privacy_now: miniPrivacyNow ? "1" : "0",
        tray_only: showMiniAtLaunch ? "0" : "1",
        mini_opacity: String(miniOpacity),
        mini_click_through: miniClickThrough ? "1" : "0",
      }));
      setSettingsOpen(false);
      setError(null);
      await loadDashboard();
    } catch (reason: unknown) {
      setSettingsError(typeof reason === "string" ? reason : t("error.saveSettings"));
    } finally {
      setSettingsSaving(false);
    }
  }

  async function selectDayPrint(localDate: string) {
    setDayPrintDate(localDate);
    setShareMessage(null);
    try {
      setDayPrint(await invoke<DayPrintData>("get_day_print", { localDate }));
    } catch (reason: unknown) {
      setError(typeof reason === "string" ? reason : t("error.dayPrint"));
    }
  }

  async function shareArtifact(kind: "day" | "week" | "challenge") {
    if (!dayPrint) return;
    setShareBusy(kind);
    setShareMessage(null);
    try {
      let dataUrl: string;
      let fileName: string;
      if (kind === "week") {
        const week = await invoke<WeekSummaryData>("get_week_summary");
        dataUrl = await renderWeekPng(week, kindLabels, lang);
        fileName = `ttli-week-${week.days[0]?.local_date ?? dayPrint.local_date}.png`;
      } else if (kind === "challenge") {
        dataUrl = await renderChallengePng(dayPrint, kindLabels, lang);
        fileName = `ttli-challenge-${dayPrint.local_date}.png`;
      } else {
        dataUrl = await renderDayPrintPng(dayPrint, kindLabels, lang);
        fileName = `ttli-day-print-${dayPrint.local_date}.png`;
      }
      const saved = await savePng(dataUrl, fileName);
      if (saved) setShareMessage(t("toast.pngSaved"));
    } catch (reason: unknown) {
      setShareMessage(typeof reason === "string" ? reason : t("error.savePng"));
    } finally {
      setShareBusy(null);
    }
  }

  async function importChallenge() {
    const code = challengeInput;
    if (!/^TF-(\d+)-(\d+)-(\d+)$/.test(code)) {
      setChallengeError(t("validation.challengeCode"));
      setChallengeImported(false);
      return;
    }
    setChallengeError(null);
    try {
      const imported = await invoke<{
        code: string;
        useful_goal_min: number;
        waste_limit_min: number;
        observed_min: number;
      }>("import_challenge", { code });
      setUsefulGoalMin(String(imported.useful_goal_min));
      setWasteLimitMin(String(imported.waste_limit_min));
      setObservedMin(String(imported.observed_min));
      setSettings((current) => ({
        ...current,
        useful_goal_min: String(imported.useful_goal_min),
        waste_limit_min: String(imported.waste_limit_min),
        observed_min: String(imported.observed_min),
      }));
      setChallengeImported(true);
      await loadDashboard();
    } catch (reason: unknown) {
      setChallengeError(typeof reason === "string" ? reason : t("error.importChallenge"));
      setChallengeImported(false);
    }
  }

  function renderCategoryControl(segment: Segment, anchor: string, label?: string) {
    const category = categoryById.get(segment.category_id);
    const isOpen = classificationTarget?.segmentId === segment.id && classificationTarget.anchor === anchor;
    const selectedCategory = categoryById.get(classificationCategoryId);
    const appName = cleanAppName(segment.app);
    const titlePattern = titleRulePattern(segment.window_title);
    const matchCount = classificationMatchStats?.match_count;
    const manualCount = classificationMatchStats?.manual_count ?? 0;
    const manualOverrideControl = manualCount > 0 ? (
      <div className="classification-manual">
        <small>{t("classification.manualNote", { count: manualCount })}</small>
        <label>
          <input
            type="checkbox"
            checked={overwriteManual}
            onChange={(event) => setOverwriteManual(event.target.checked)}
          />
          <span>{t("classification.overwriteManual")}</span>
        </label>
        <small className="classification-warning">
          {overwriteManual
            ? t("classification.manualWillRepaint", { count: manualCount })
            : t("classification.manualWontRepaint", { count: manualCount })}
        </small>
      </div>
    ) : null;
    return (
      <div className="category-control" data-classification-root="true">
        <button
          type="button"
          className={`category-tag category-tag-button kind-${category?.kind ?? "muted"}`}
          aria-expanded={isOpen}
          onClick={() => isOpen ? setClassificationTarget(null) : openClassification(segment, anchor)}
        >
          {label ?? (segment.category_id === 0 ? t("common.uncategorized") : category?.full_path) ?? t("common.uncategorized")}
        </button>
        {isOpen && (
          <div className="classification-popover" role="dialog" aria-label={t("classification.dialog")}>
            <span className="classification-title">{t("classification.reclassify")}</span>
            <label className="classification-category">
              <span>{t("classification.category")}</span>
              <select
                className="with-chevron"
                autoFocus
                value={classificationCategoryId}
                onChange={(event) => {
                  const categoryId = Number(event.target.value);
                  setClassificationCategoryId(categoryId);
                  setClassificationScope("single");
                  setClassificationMatchStats(null);
                  setOverwriteManual(false);
                }}
              >
                <option value={0}>{t("common.uncategorized")}</option>
                {manageableCategories.map((item) => (
                    <option key={item.id} value={item.id}>{item.full_path}</option>
                ))}
              </select>
            </label>
            <span className="classification-scope-label">{t("classification.applyTo")}</span>
            <label className="classification-option is-default">
              <input
                type="radio"
                name={`classification-scope-${anchor}`}
                checked={classificationScope === "single"}
                onChange={() => setClassificationScope("single")}
              />
              <span><strong>{t("classification.onlySegment")}</strong><small>{t("classification.onlySegmentHint")}</small></span>
            </label>
            {classificationCategoryId !== 0 && (
              <>
                <label className="classification-option">
                  <input
                    type="radio"
                    name={`classification-scope-${anchor}`}
                    checked={classificationScope === "title"}
                    disabled={!titlePattern}
                    onChange={() => {
                      setClassificationScope("title");
                      setClassificationMatchStats(null);
                      setOverwriteManual(false);
                    }}
                  />
                  <span>
                    <strong>{t("classification.titleAlways", { category: selectedCategory?.full_path ?? t("classification.categoryFallback") })}</strong>
                    <small>{t("classification.titleHint")}</small>
                    {classificationScope === "title" && (
                      <>
                        <small className="classification-pattern">
                          {t("classification.titlePattern")}: <code>{titlePattern}</code>
                        </small>
                        {matchCount === undefined ? (
                          <small>{t("common.loading")}</small>
                        ) : (
                          <>
                            <small>{t("classification.titleMatchCount", { count: matchCount })}</small>
                            <small className="classification-warning">
                              {t("classification.titleHistoryWarning", { count: matchCount })}
                            </small>
                          </>
                        )}
                      </>
                    )}
                  </span>
                </label>
                {classificationScope === "title" && manualOverrideControl}
                <label className="classification-option">
                  <input
                    type="radio"
                    name={`classification-scope-${anchor}`}
                    checked={classificationScope === "app"}
                    onChange={() => {
                      setClassificationScope("app");
                      setClassificationMatchStats(null);
                      setOverwriteManual(false);
                    }}
                  />
                  <span>
                    <strong>{t("classification.always", { app: appName, category: selectedCategory?.full_path ?? t("classification.categoryFallback") })}</strong>
                    <small>{t("classification.remember")}</small>
                    {classificationScope === "app" && (matchCount === undefined ? (
                      <small>{t("common.loading")}</small>
                    ) : (
                      <small className="classification-warning">
                        {t("classification.historyWarning", { app: appName, count: matchCount })}
                      </small>
                    ))}
                  </span>
                </label>
                {classificationScope === "app" && manualOverrideControl}
              </>
            )}
            {classificationCategoryId !== 0 && classificationScope !== "single" && (
              <small className="classification-highest-priority">{t("classification.highestPriority")}</small>
            )}
            <button
              type="button"
              className="classification-apply"
              disabled={classificationSaving || (classificationScope !== "single" && matchCount === undefined)}
              onClick={() => void reclassify(segment, classificationCategoryId, classificationScope)}
            >
              {classificationSaving ? t("common.saving") : t("common.apply")}
            </button>
          </div>
        )}
      </div>
    );
  }

  return (
    <main className="dashboard-shell">
      <header className="topbar">
        <div className="brand"><span className="brand-mark" />TTLI</div>
        <div className={`topbar-status ${paused ? "is-paused" : ""}`}><span className="status-dot" /> {paused ? t("dashboard.trackingStopped") : t("dashboard.trackingOn")}</div>
        <div className="topbar-spacer" />
        <span className="date-label">
          {new Intl.DateTimeFormat(localeForLang(lang), {
            weekday: "long",
            day: "numeric",
            month: "long",
          }).format(now)}
        </span>
        <button
          type="button"
          className="pause-button"
          title={t("dashboard.trackingStoppedHint")}
          onClick={() => void toggleTracking()}
        >
          {paused ? (
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 2.75v10.5L13 8 4 2.75Z" /></svg>
          ) : (
            <svg viewBox="0 0 16 16" aria-hidden="true"><rect x="3.5" y="3.5" width="9" height="9" rx="1" /></svg>
          )}
          <span>{paused ? t("dashboard.continue") : t("dashboard.pause")}</span>
        </button>
        <button className="mini-open-button" onClick={() => void invoke("show_mini")}>{t("dashboard.mini")}</button>
        <button className="icon-button" onClick={() => void openSettings()} aria-label={t("dashboard.openSettings")}>
          ⚙
        </button>
      </header>

      <section className={`live-panel ${live ? "is-live" : ""} ${paused ? "is-paused" : ""}`}>
        <div className="live-pulse" />
        <div className={`live-copy ${live ? "is-live" : "is-empty"}`}>
          <span className="eyebrow">{t("dashboard.current")}</span>
          <strong title={live ? cleanAppName(live.app) : undefined}>{paused ? t("dashboard.trackingStopped") : live ? cleanAppName(live.app) : t("dashboard.waitingWindow")}</strong>
          {!paused && <span title={live ? live.domain || live.window_title || t("common.noTitle") : undefined}>{live ? live.domain || live.window_title || t("common.noTitle") : t("dashboard.nextTick")}</span>}
        </div>
        {live && (
          <>
            {renderCategoryControl(live, "live")}
            <div className="live-clock">
              <strong>{formatDuration(now - live.ts_start)}</strong>
              <span>{t("dashboard.since", { time: formatTime(live.ts_start, lang) })}</span>
            </div>
          </>
        )}
      </section>

      {error && <div className="error-banner">{error}. {t("dashboard.autoRefresh")}</div>}
      {managerNotice && <div className="history-toast" role="status">{managerNotice}</div>}

      <nav className="dashboard-view-tabs" aria-label={t("dashboard.sections")}>
        <button
          type="button"
          aria-current={dashboardView === "today" ? "page" : undefined}
          onClick={() => setDashboardView("today")}
        >
          {t("common.today")}
        </button>
        <button
          type="button"
          aria-current={dashboardView === "trends" ? "page" : undefined}
          onClick={() => setDashboardView("trends")}
        >
          {t("dashboard.trends")}
        </button>
      </nav>

      {dashboardView === "today" ? <>
      {loading || !progress ? (
        <div className="card progress-skeleton skeleton" aria-label={t("dashboard.progressLoading")} />
      ) : (
        <DayScorecard overview={progress} formatDuration={formatDuration} kindLabels={kindLabels} observedLabel={kindLabels.observed} />
      )}

      <div className="dashboard-grid">
        {loading || !cumulative ? (
          <div className="card cumulative-skeleton skeleton" aria-label={t("dashboard.chartLoading")} />
        ) : (
          <CumulativeChart data={cumulative} formatDuration={formatDuration} kindLabels={kindLabels} />
        )}

        <section className={`card apps-card ${selectedApp ? "has-selection" : ""}`}>
          <div className="card-heading"><div><span className="eyebrow">{t("dashboard.rating")}</span><h2>{t("dashboard.apps")}</h2></div></div>
          {apps.length === 0 ? <p className="quiet-empty">{t("dashboard.noData")}</p> : apps.slice(0, 6).map((app) => {
            const dominant: CategoryKind = app.useful_ms >= app.neutral_ms && app.useful_ms >= app.waste_ms ? "useful" : app.waste_ms >= app.neutral_ms ? "waste" : "neutral";
            return (
              <button
                type="button"
                className={`app-row ${selectedApp === app.app ? "is-selected" : ""}`}
                key={app.app}
                aria-pressed={selectedApp === app.app}
                onClick={() => setSelectedApp((current) => current === app.app ? null : app.app)}
              >
                <span className="app-rank">{String(apps.indexOf(app) + 1).padStart(2, "0")}</span>
                <span className="app-name">{cleanAppName(app.app)}</span>
                <span className="app-bar"><i className={`kind-${dominant}`} style={{ width: `${(app.duration_ms / maxAppDuration) * 100}%` }} /></span>
                <strong>{formatDuration(app.duration_ms)}</strong>
              </button>
            );
          })}
        </section>

        <section className="card timeline-card">
          <div className="card-heading">
            <div><span className="eyebrow">{t("dashboard.timelineEyebrow")}</span><h1>{t("dashboard.timelineTitle")}</h1></div>
            <span className={`mono-meta ${selectedApp ? "is-selection" : ""}`}>
              {selectedApp ? t("dashboard.focus", { app: cleanAppName(selectedApp) }) : t("dashboard.appSessionCount", { apps: appTimeline.length, sessions: displaySessions.length })}
            </span>
          </div>

          {loading ? (
            <div className="skeleton timeline-skeleton" />
          ) : segments.length === 0 ? (
            <div className="empty-state"><strong>{t("dashboard.emptyTitle")}</strong><span>{t("dashboard.emptyBody")}</span></div>
          ) : (
            <>
              <div className="day-track" aria-label={t("dashboard.dayScale")}>
                {[0, 6, 12, 18, 24].map((hour) => <span key={hour} style={{ left: `${(hour / 24) * 100}%` }}>{String(hour).padStart(2, "0")}</span>)}
                <div className="track-rail">
                  {segments.map((segment) => {
                    const start = new Date(segment.ts_start);
                    const startMinute = start.getHours() * 60 + start.getMinutes();
                    const duration = Math.max(segment.ts_end - segment.ts_start, 60_000);
                    const category = categoryById.get(segment.category_id ?? -1);
                    return (
                      <button
                        key={segment.id}
                        className={`track-segment ${segment.status === "away" ? "is-away" : ""} ${selectedApp && segment.app !== selectedApp ? "is-dimmed" : ""} ${selectedApp === segment.app ? "is-highlighted" : ""}`}
                        style={{
                          left: `${(startMinute / 1440) * 100}%`,
                          width: `${Math.max((duration / 86_400_000) * 100, 0.18)}%`,
                          "--segment-color": category?.effective_color ?? "var(--cat-muted)",
                        } as React.CSSProperties}
                        onClick={() => selectTimelineSegment(segment.id)}
                        title={`${cleanAppName(segment.app)} · ${formatDuration(duration)}`}
                      />
                    );
                  })}
                </div>
              </div>

              <div className="app-day-list">
                {appTimeline.map((app) => {
                  const isExpanded = expandedApps.has(app.app);
                  const appCategory = categoryById.get(app.lastSegment.category_id);
                  return (
                    <div className={`app-day-item ${app.isLive ? "is-current" : ""} ${selectedApp && app.app !== selectedApp ? "is-dimmed" : ""} ${selectedApp === app.app ? "is-highlighted" : ""}`} key={app.app}>
                      <div className="app-day-main">
                        <button
                          type="button"
                          className="app-expand-button"
                          aria-expanded={isExpanded}
                          onClick={() => toggleApp(app.app)}
                        >
                          <span className="app-chevron" aria-hidden="true">›</span>
                          <span className="app-day-name">
                            <strong>{cleanAppName(app.app)}</strong>
                            <small>{app.isLive ? <span className="now-marker">{t("common.now")}</span> : t("dashboard.sessionCount", { count: app.sessions.length })}</small>
                          </span>
                          <span className="app-day-bar"><i style={{ width: `${(app.duration_ms / maxTimelineAppDuration) * 100}%`, backgroundColor: appCategory?.effective_color ?? "var(--cat-muted)" }} /></span>
                        </button>
                        {renderCategoryControl(app.lastSegment, `app-${app.app}`)}
                        <strong className="app-day-duration">{formatDuration(app.duration_ms)}</strong>
                      </div>
                      {isExpanded && (
                        <div className="app-segment-list">
                          {app.sessions.map((session) => {
                            const isGroupedSession = session.segmentIds.length > 1;
                            const isSessionExpanded = expandedSessions.has(session.id);
                            const groupDuration = session.segments.reduce(
                              (total, segment) => total + segmentDuration(segment, live?.id, now),
                              0,
                            );
                            if (isGroupedSession) {
                              const firstSegment = session.segments[0];
                              const lastSegment = session.segments[session.segments.length - 1];
                              const sessionEnd = lastSegment.id === live?.id ? now : lastSegment.ts_end;
                              return (
                                <div className="micro-group" key={session.id}>
                                  <button
                                    type="button"
                                    className="micro-group-main"
                                    aria-expanded={isSessionExpanded}
                                    onClick={() => setExpandedSessions((current) => {
                                      const next = new Set(current);
                                      if (next.has(session.id)) next.delete(session.id);
                                      else next.add(session.id);
                                      return next;
                                    })}
                                  >
                                    <span className="segment-time">{formatTime(firstSegment.ts_start, lang)}–{formatTime(sessionEnd, lang)}</span>
                                    <span className="segment-app"><strong>{firstSegment.domain || firstSegment.window_title || t("common.noTitle")}</strong><small>{isSessionExpanded ? t("dashboard.sessionDetails", { count: session.segmentIds.length }) : t("dashboard.sessionExpandHint")}</small></span>
                                    <span className="micro-cluster-mark" aria-label={t("dashboard.grouped")}>···</span>
                                    <span className="segment-duration">{formatDuration(groupDuration)}</span>
                                  </button>
                                  {isSessionExpanded && (
                                    <div className="micro-segment-list">
                                      {session.segments.map((segment) => (
                                        <div className="app-segment-row is-micro" key={segment.id}>
                                          <span className="segment-time">{formatTime(segment.ts_start, lang)}–{formatTime(segment.ts_end, lang)}</span>
                                          <span className="segment-app"><small>{segment.domain || segment.window_title || t("common.noTitle")}</small></span>
                                          {renderCategoryControl(segment, `segment-${segment.id}`)}
                                          <span className="segment-duration">{formatDuration(segmentDuration(segment, live?.id, now))}</span>
                                        </div>
                                      ))}
                                    </div>
                                  )}
                                </div>
                              );
                            }
                            const segment = session.segments[0];
                            const segmentEnd = segment.id === live?.id ? now : segment.ts_end;
                            return (
                              <div className="app-segment-row" key={session.id}>
                                <span className="segment-time">{formatTime(segment.ts_start, lang)}–{formatTime(segmentEnd, lang)}</span>
                                <span className="segment-app"><small>{segment.domain || segment.window_title || t("common.noTitle")}</small></span>
                                {renderCategoryControl(segment, `segment-${segment.id}`)}
                                <span className="segment-duration">{formatDuration(segmentDuration(segment, live?.id, now))}</span>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </section>

        <aside className="dashboard-stack">
          {scoring && <ScorePanel data={scoring} />}

          {scoring && (
            <section className="card top-categories-card">
              <div className="card-heading"><div><span className="eyebrow">{t("score.topCategories")}</span><h2>{t("dashboard.categories")}</h2></div></div>
              <div className="top-category-list">
                {scoring.top_categories.map((category) => (
                  <div className="top-category-row" key={category.category_id} title={category.full_path}>
                    <CategoryMark icon={category.icon} color={category.effective_color} />
                    <span>{category.full_path}</span>
                    <strong>{formatDuration(category.duration_ms)}</strong>
                  </div>
                ))}
              </div>
            </section>
          )}

          <section className="card stats-card">
            <div className="card-heading"><div><span className="eyebrow">{t("dashboard.balance")}</span><h2>{t("dashboard.whereTimeWent")}</h2></div></div>
            <div className="ring-layout">
              <div className="time-ring">
                <svg viewBox="0 0 120 120" aria-label={t("dashboard.accountedDuration", { duration: formatDuration(stats.observed_ms) })}>
                  <circle className="ring-base" cx="60" cy="60" r="48" pathLength="100" />
                  {ringParts.map((part) => {
                    const length = (part.value / totalRing) * 100;
                    const offset = ringOffset;
                    ringOffset += length;
                    return <circle key={part.kind} className={`ring-part kind-${part.kind}`} cx="60" cy="60" r="48" pathLength="100" strokeDasharray={`${length} ${100 - length}`} strokeDashoffset={-offset} />;
                  })}
                </svg>
                <div className="ring-center"><strong>{formatDuration(stats.observed_ms)}</strong><span>{t("dashboard.accounted")}</span></div>
              </div>
              <div className="stats-list">
                {ringParts.map((part) => (
                  <div className="stats-row" key={part.kind}>
                    <span className={`legend-dot kind-${part.kind}`} />
                    <span>{kindLabels[part.kind]}</span>
                    <strong>{formatDuration(part.value)}</strong>
                  </div>
                ))}
              </div>
            </div>
            <div className="category-bars">
              {ringParts.map((part) => (
                <div className="category-bar" key={part.kind}>
                  <div><span>{kindLabels[part.kind]}</span><strong>{stats.observed_ms ? Math.round((part.value / stats.observed_ms) * 100) : 0}%</strong></div>
                  <span className="bar-rail"><i className={`kind-${part.kind}`} style={{ width: `${stats.observed_ms ? (part.value / stats.observed_ms) * 100 : 0}%` }} /></span>
                </div>
              ))}
            </div>
          </section>

        </aside>
      </div>

      {progress && (
        <CalendarHeatmap
          days={progress.calendar}
          todayDate={progress.today.local_date}
          formatDuration={formatDuration}
          kindLabels={kindLabels}
        />
      )}

      {dayPrint && (
        <DayPrint
          data={dayPrint}
          availableDates={Array.from(new Set([
            progress?.today.local_date ?? dayPrint.local_date,
            ...dayPrintDates,
          ]))}
          selectedDate={dayPrintDate}
          busyAction={shareBusy}
          message={shareMessage}
          formatDuration={formatDuration}
          kindLabels={kindLabels}
          observedLabel={kindLabels.observed}
          onDateChange={(localDate) => void selectDayPrint(localDate)}
          onShareDay={() => void shareArtifact("day")}
          onShareWeek={() => void shareArtifact("week")}
          onShareChallenge={() => void shareArtifact("challenge")}
        />
      )}
      </> : (
        <section className="trends-section" aria-label={t("dashboard.trendsActivity")}>
          <div className="trends-section-heading">
            <div><span className="eyebrow">{t("dashboard.history")}</span><h1>{t("dashboard.explainDays")}</h1></div>
            <p>{t("dashboard.trendsIntro")}</p>
          </div>
          {loading || dailySeries.length === 0 ? (
            <div className="card trends-skeleton skeleton" aria-label={t("dashboard.trendsLoading")} />
          ) : (
            <>
              <TrendsStacked
                days={dailySeries}
                range={trendsRange}
                onRangeChange={setTrendsRange}
                formatDuration={formatDuration}
                kindLabels={kindLabels}
              />
              <AfkStrip days={afkSeries} formatDuration={formatDuration} />
              <TrendsTrend sourceDays={dailySeries} formatDuration={formatDuration} kindLabels={kindLabels} />
              <div className="card trends-day-card">
                <div className="card-heading trends-heading">
                  <div><span className="eyebrow">{t("trends.dayEyebrow")}</span><h2>{t("trends.dayTitle")}</h2></div>
                </div>
                <div className="trends-day-picker" aria-label={t("trends.dayPickerLabel")}>
                  <button type="button" onClick={() => setDayCumulativeDate((date) => shiftLocalDate(date, -1))} aria-label={t("trends.prevDay")} title={t("trends.prevDay")}>‹</button>
                  <span className="mono-meta">{dayCumulativeDate ? formatLocalDate(dayCumulativeDate, { weekday: "long", day: "numeric", month: "long" }) : "—"}</span>
                  <button type="button" onClick={() => setDayCumulativeDate((date) => shiftLocalDate(date, 1))} aria-label={t("trends.nextDay")} title={t("trends.nextDay")}>›</button>
                </div>
                {dayCumulativeLoading ? (
                  <div className="card trends-skeleton skeleton" aria-label={t("dashboard.trendsLoading")} />
                ) : dayCumulative ? (
                  <CumulativeChart data={dayCumulative} formatDuration={formatDuration} kindLabels={kindLabels} fullDay={dayCumulativeDate !== todayLocalDate} />
                ) : null}
              </div>
            </>
          )}
        </section>
      )}

      {settingsOpen && (
        <div className="settings-overlay">
          <section className="settings-modal" role="dialog" aria-modal="true" aria-labelledby="settings-title">
            <div className="settings-heading">
              <span className="eyebrow">{t("settings.eyebrow")}</span>
              <h2 id="settings-title">{t("settings.title")}</h2>
            </div>
            <div className="settings-layout">
              <nav className="settings-nav" aria-label={t("settings.sections")}>
                <a href="#appearance-settings">{t("settings.appearance")}</a>
                <a href="#tracking-settings">{t("settings.tracking")}</a>
                <a href="#classification-settings">{t("settings.categoriesRules")}</a>
                <a href="#goal-settings">{t("settings.dayScore")}</a>
                <a href="#mini-settings">{t("settings.miniWindow")}</a>
                <a href="#browser-settings">{t("settings.browserExtension")}</a>
                <a href="#challenge-settings">{t("settings.challenge")}</a>
                <a href="#labels-settings">{t("settings.kindLabels")}</a>
                <a href="#startup-settings">{t("settings.startup")}</a>
                <a href="#about-settings">{t("settings.about")}</a>
              </nav>
              <div className="settings-scroll">
              <section id="appearance-settings" className="settings-section" aria-labelledby="appearance-settings-title">
                <div className="settings-section-heading">
                  <h3 id="appearance-settings-title">{t("settings.appearance")}</h3>
                  <span>{t("settings.appearanceHint")}</span>
                </div>
                <div className="appearance-settings-grid">
                  <label className="settings-field">
                    <span>{t("settings.language")}</span>
                    <select className="with-chevron" value={lang} onChange={(event) => void changeLanguage(event.target.value as Lang)}>
                      {(["ru", "ua", "en"] as const).map((option) => <option key={option} value={option}>{langNames[option]}</option>)}
                    </select>
                  </label>
                  <label className="settings-field">
                    <span>{t("settings.theme")}</span>
                    <select className="with-chevron" value={dark ? "dark" : "dawn"} onChange={(event) => void setTheme(event.target.value === "dark")}>
                      <option value="dawn">{t("settings.themeLight")}</option>
                      <option value="dark">{t("settings.themeDark")}</option>
                    </select>
                  </label>
                </div>
              </section>

              <section id="tracking-settings" className="settings-section" aria-labelledby="tracking-settings-title">
                <div className="settings-section-heading">
                  <h3 id="tracking-settings-title">{t("settings.tracking")}</h3>
                  <span>{t("settings.trackingHint")}</span>
                </div>
                <label className="settings-toggle settings-toggle-explained">
                  <input type="checkbox" checked={!paused} onChange={() => void toggleTracking()} />
                  <span><strong>{t("settings.trackingEnabled")}</strong><small>{t("dashboard.trackingStoppedHint")}</small></span>
                </label>
              </section>

              <section id="classification-settings" className="settings-section settings-classification-section" aria-labelledby="classification-settings-title">
                <div className="settings-section-heading">
                  <h3 id="classification-settings-title">{t("settings.categoriesRules")}</h3>
                  <span>{t("settings.categoriesRulesHint")}</span>
                </div>
                <button type="button" className="settings-manager-button" onClick={() => { setSettingsOpen(false); setCategoryManagerOpen(true); }}>{t("manager.open")}</button>
              </section>

              <section id="goal-settings" className="settings-section" aria-labelledby="goal-settings-title">
                <div className="settings-section-heading">
                  <h3 id="goal-settings-title">{t("settings.dayScore")}</h3>
                  <span>{t("settings.effectiveToday")}</span>
                </div>
                <div className="goal-settings-grid">
                  <label className="settings-field"><span>{t("settings.goalMinutes", { label: kindLabelUseful })}</span><input type="number" min="0" max="1440" step="1" value={usefulGoalMin} onChange={(event) => setUsefulGoalMin(event.target.value)} /></label>
                  <label className="settings-field"><span>{t("settings.limitMinutes", { label: kindLabelWaste })}</span><input type="number" min="0" max="1440" step="1" value={wasteLimitMin} onChange={(event) => setWasteLimitMin(event.target.value)} /></label>
                  <label className="settings-field"><span>{t("settings.minimumMinutes", { label: kindLabelObserved })}</span><input type="number" min="0" max="1440" step="1" value={observedMin} onChange={(event) => setObservedMin(event.target.value)} /></label>
                </div>
                <div className="money-settings-grid">
                  <label className="settings-field">
                    <span>{t("settings.hourlyRate")}</span>
                    <input type="text" inputMode="decimal" placeholder={t("settings.hideBurned")} value={hourlyRate} onChange={(event) => setHourlyRate(event.target.value)} />
                  </label>
                  <label className="settings-field">
                    <span>{t("settings.currency")}</span>
                    <select className="with-chevron" value={currency} onChange={(event) => setCurrency(event.target.value)}>
                      {["₴", "$", "€", "₽"].map((symbol) => <option key={symbol} value={symbol}>{symbol}</option>)}
                    </select>
                  </label>
                </div>
              </section>

              <section id="mini-settings" className="settings-section" aria-labelledby="mini-settings-title">
                <div className="settings-section-heading">
                  <h3 id="mini-settings-title">{t("settings.miniWindow")}</h3>
                  <span>{t("settings.miniWindowHint")}</span>
                </div>
                <div className="mini-settings-grid">
                  <label className="settings-field">
                    <span>{t("mini.settingsMode")}</span>
                    <select className="with-chevron" value={miniMode} onChange={(event) => setMiniMode(event.target.value as MiniMode)}>
                      <option value="auto">{t("mini.settingsModeAuto")}</option>
                      <option value="compact">{t("mini.settingsModeCompact")}</option>
                      <option value="detailed">{t("mini.settingsModeDetailed")}</option>
                    </select>
                  </label>
                  <label className="settings-field">
                    <span>{t("mini.settingsText")}</span>
                    <select className="with-chevron" value={miniTextSize} onChange={(event) => setMiniTextSize(event.target.value as MiniTextSize)}>
                      <option value="normal">{t("mini.settingsTextNormal")}</option>
                      <option value="large">{t("mini.settingsTextLargeGrows")}</option>
                    </select>
                  </label>
                </div>
                <label className="settings-toggle"><input type="checkbox" checked={miniPrivacyNow} onChange={(event) => setMiniPrivacyNow(event.target.checked)} /><span>{t("mini.settingsPrivacy")}</span></label>
                <label className="settings-toggle"><input type="checkbox" checked={showMiniAtLaunch || miniCornerPinned} disabled={miniCornerPinned} onChange={(event) => setShowMiniAtLaunch(event.target.checked)} /><span>{miniCornerPinned ? t("mini.settingsLaunchCorner") : t("mini.settingsLaunch")}</span></label>
                <label className="settings-field mini-opacity-field">
                  <span>{t("mini.settingsOpacity")} · {miniOpacity}%</span>
                  <input type="range" min="60" max="100" step="5" value={miniOpacity} onChange={(event) => setMiniOpacity(Number(event.target.value))} />
                </label>
                <label className="settings-toggle" title={t("mini.clickThroughHint")}><input type="checkbox" checked={miniClickThrough} onChange={(event) => setMiniClickThrough(event.target.checked)} /><span>{t("mini.clickThrough")}</span></label>
                <div className="mini-settings-actions">
                  <button type="button" onClick={() => void invoke("show_mini")}>{t("settings.miniShow")}</button>
                  <button type="button" onClick={() => void invoke("minimize_mini")}>{t("mini.minimize")}</button>
                  <button type="button" onClick={() => void invoke("hide_mini")}>{t("mini.hideToTray")}</button>
                </div>
                <p className="settings-hint">{t("settings.miniHelp")}</p>
              </section>

              <section id="challenge-settings" className="settings-section" aria-labelledby="challenge-settings-title">
                <div className="settings-section-heading">
                  <h3 id="challenge-settings-title">{t("settings.challenge")}</h3>
                  <span>{t("settings.challengeEffect")}</span>
                </div>
                <div className="challenge-import-row">
                  <label className="settings-field">
                    <span>{t("settings.challengeCode")}</span>
                    <input
                      autoComplete="off"
                      spellCheck={false}
                      placeholder="TF-184-43-60"
                      value={challengeInput}
                      aria-invalid={challengeError !== null}
                      aria-describedby={challengeError ? "challenge-import-error" : undefined}
                      onChange={(event) => {
                        setChallengeInput(event.target.value);
                        setChallengeError(null);
                        setChallengeImported(false);
                      }}
                    />
                  </label>
                  <button type="button" onClick={() => void importChallenge()}>{t("settings.acceptChallenge")}</button>
                </div>
                {challengeError && <p className="settings-error" id="challenge-import-error">{challengeError}</p>}
                {challengeImported && <p className="challenge-imported" role="status">{t("settings.challengeAccepted")}</p>}
              </section>

              <section id="labels-settings" className="settings-section" aria-labelledby="kind-labels-title">
                <div className="settings-section-heading">
                  <h3 id="kind-labels-title">{t("settings.kindLabels")}</h3>
                  <span>{t("settings.kindLabelsHint")}</span>
                </div>
                <div className="kind-label-grid">
                  <label className="settings-field">
                    <span>{t("settings.kindLabelName", { label: defaultKindLabels.useful })}</span>
                    <input autoFocus required maxLength={80} value={kindLabelUseful} onChange={(event) => setKindLabelUseful(event.target.value)} />
                  </label>
                  <label className="settings-field">
                    <span>{t("settings.kindLabelName", { label: defaultKindLabels.neutral })}</span>
                    <input required maxLength={80} value={kindLabelNeutral} onChange={(event) => setKindLabelNeutral(event.target.value)} />
                  </label>
                  <label className="settings-field">
                    <span>{t("settings.kindLabelName", { label: defaultKindLabels.waste })}</span>
                    <input required maxLength={80} value={kindLabelWaste} onChange={(event) => setKindLabelWaste(event.target.value)} />
                  </label>
                  <label className="settings-field">
                    <span>{t("settings.kindLabelName", { label: defaultKindLabels.observed })}</span>
                    <input required maxLength={80} value={kindLabelObserved} onChange={(event) => setKindLabelObserved(event.target.value)} />
                  </label>
                </div>
              </section>

              <section id="browser-settings" className="settings-section" aria-labelledby="browser-settings-title">
                <div className="settings-section-heading">
                  <h3 id="browser-settings-title">{t("settings.browser")}</h3>
                  <span>{t("settings.browserHint")}</span>
                </div>
                <label className="settings-field">
                  <span>{t("settings.chromeId")}</span>
                  <input
                    autoComplete="off"
                    spellCheck={false}
                    aria-invalid={settingsError !== null}
                    aria-describedby="settings-hint settings-error"
                    value={extensionChromeId}
                    onChange={(event) => setExtensionChromeId(event.target.value)}
                  />
                </label>
                <label className="settings-field">
                  <span>{t("settings.edgeId")}</span>
                  <input
                    autoComplete="off"
                    spellCheck={false}
                    aria-invalid={settingsError !== null}
                    aria-describedby="settings-hint settings-error"
                    value={extensionEdgeId}
                    onChange={(event) => setExtensionEdgeId(event.target.value)}
                  />
                </label>
                <p className="settings-hint" id="settings-hint">
                  {t("settings.browserHelp")}
                </p>
                <details
                  className="settings-token"
                  onToggle={(event) => {
                    if (!event.currentTarget.open) setTokenRevealed(false);
                  }}
                >
                  <summary>{t("settings.advanced")}</summary>
                  <div className="settings-token-content">
                    <span>{t("settings.extensionToken")}</span>
                    <div className="settings-token-row">
                      <code>
                        {settings.extension_token
                          ? tokenRevealed
                            ? settings.extension_token
                            : `••••••••${settings.extension_token.slice(-4)}`
                          : "—"}
                      </code>
                      <button
                        type="button"
                        disabled={!settings.extension_token}
                        onClick={() => setTokenRevealed((current) => !current)}
                        onBlur={() => setTokenRevealed(false)}
                      >
                        {tokenRevealed ? t("settings.hideToken") : t("settings.revealToken")}
                      </button>
                      <button
                        type="button"
                        disabled={!settings.extension_token}
                        onClick={() => void copyExtensionToken()}
                      >
                        {tokenCopied ? t("common.copied") : t("settings.copyConnectionToken")}
                      </button>
                    </div>
                    <p>{t("settings.tokenHelp")}</p>
                  </div>
                </details>
              </section>

              <section id="startup-settings" className="settings-section" aria-labelledby="startup-settings-title">
                <div className="settings-section-heading">
                  <h3 id="startup-settings-title">{t("settings.startup")}</h3>
                  <span>{t("settings.appliesNow")}</span>
                </div>
                <label className="settings-toggle">
                  <input
                    type="checkbox"
                    checked={autostart}
                    disabled={settingsSaving}
                    onChange={(event) => void toggleAutostart(event.target.checked)}
                  />
                  <span>{t("settings.autostart")}</span>
                </label>
              </section>

              <section id="about-settings" className="settings-section" aria-labelledby="about-settings-title">
                <div className="settings-section-heading">
                  <h3 id="about-settings-title">{t("settings.about")}</h3>
                  <span>{t("updates.autoCheckNote")}</span>
                </div>
                {installedVersion && (
                  <div className="update-status">
                    <span>{t("settings.installedVersion", { version: installedVersion })}</span>
                  </div>
                )}
                {updateCheck === "available" && updateInfo && (
                  <div className="update-available">
                    <span>{t("updates.available", { version: updateInfo.version })}</span>
                    <button
                      type="button"
                      className="update-install-button"
                      disabled={updateDownloading}
                      onClick={() => void installUpdate()}
                    >
                      {t("updates.installNow")}
                    </button>
                  </div>
                )}
                {updateDownloading && updateProgress && (() => {
                  const percent = updateProgress.total > 0
                    ? Math.min(100, Math.floor((updateProgress.downloaded / updateProgress.total) * 100))
                    : 0;
                  return (
                    <div className="update-download" aria-live="polite">
                      <div
                        className="update-progress"
                        role="progressbar"
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={percent}
                      >
                        <span style={{ width: `${percent}%` }} />
                      </div>
                      <span>{t("updates.downloading", { percent })}</span>
                    </div>
                  );
                })()}
                <button
                  type="button"
                  className="update-check-button"
                  disabled={updateCheck === "checking" || updateDownloading}
                  onClick={() => void checkForUpdates()}
                >
                  {updateCheck === "checking" ? t("updates.checking") : t("updates.check")}
                </button>
                <div className="update-status" aria-live="polite">
                  {updateCheck === "latest" && t("updates.latest")}
                  {updateCheck === "error" && updateError && (
                    <span className="is-error">{t("updates.error", { message: updateError })}</span>
                  )}
                  {updateInstallError && (
                    <span className="is-error">{t("updates.installError", { message: updateInstallError })}</span>
                  )}
                </div>
              </section>

              <div className="database-size">
                <span>{t("settings.databaseSize")}</span>
                <strong>{dbSizeMb === null ? "…" : t("settings.megabytes", { size: dbSizeMb.toFixed(1) })}</strong>
              </div>
              </div>
            </div>
            {settingsError && <p className="settings-error" id="settings-error">{settingsError}</p>}
            <div className="settings-actions">
              <button className="settings-done" disabled={settingsSaving || updateDownloading} onClick={() => void saveSettings()}>
                {settingsSaving ? t("common.saving") : t("common.done")}
              </button>
            </div>
          </section>
        </div>
      )}
      <CategoryManager
        open={categoryManagerOpen}
        categories={categories}
        kindLabels={kindLabels}
        formatDuration={formatDuration}
        observedMs={stats.observed_ms}
        appCount={apps.length}
        uncategorizedMs={segments.filter((segment) => segment.category_id === 0 && (segment.status === "active" || segment.status === "crashed")).reduce((total, segment) => total + Math.max(0, segment.ts_end - segment.ts_start), 0)}
        onClose={() => { setCategoryManagerOpen(false); setSettingsOpen(true); }}
        onCategoriesChange={setCategories}
        onDashboardRefresh={loadDashboard}
      />
    </main>
  );
}

function shiftLocalDate(localDate: string, delta: number): string {
  const [year, month, day] = localDate.split("-").map(Number);
  const date = new Date(year, month - 1, day + delta);
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${mm}-${dd}`;
}
const todayLocalDate = (() => {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
})();

function App() {
  return (
    <I18nProvider>
      {getCurrentWindow().label === "mini" ? <MiniView /> : <DashboardView />}
      {import.meta.env.DEV && <Agentation />}
    </I18nProvider>
  );
}

export default App;
