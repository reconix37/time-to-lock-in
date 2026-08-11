import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { CalendarHeatmap } from "./components/CalendarHeatmap";
import { AfkStrip } from "./components/AfkStrip";
import { CumulativeChart, type TodayCumulative } from "./components/CumulativeChart";
import { DayPrint } from "./components/DayPrint";
import { DayScorecard } from "./components/DayScorecard";
import { TrendsStacked } from "./components/TrendsStacked";
import { TrendsTrend } from "./components/TrendsTrend";
import type { ProgressOverview } from "./progress";
import type { AfkDay, DailySeriesDay } from "./trends";
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
import "./styles/tokens.css";
import "./App.css";

type CategoryKind = "useful" | "neutral" | "waste";
type RuleMatchType = "exe" | "title" | "domain";

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

interface Category {
  id: number;
  name: string;
  color: string;
  icon: string;
  kind: CategoryKind;
  goal_multiplier: number;
  sort_order: number;
}

interface Rule {
  id: number;
  match_type: RuleMatchType;
  pattern: string;
  category_id: number;
  priority: number;
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
  lastSegment: Segment;
  isLive: boolean;
}

interface SegmentGroup {
  id: string;
  isMicro: boolean;
  segments: Segment[];
}

interface ClassificationTarget {
  segmentId: number;
  anchor: string;
}

interface ReclassificationSummary {
  changed_segments: number;
  changed_duration_ms: number;
}

const EMPTY_STATS: TodayStats = {
  useful_ms: 0,
  neutral_ms: 0,
  waste_ms: 0,
  observed_ms: 0,
};

const DEFAULT_KIND_LABELS: KindLabels = {
  useful: "Полезное",
  neutral: "Нейтральное",
  waste: "Потери",
  observed: "Наблюдение",
};

const CATEGORY_COLORS = ["#286983", "#ea9d34", "#b4637a", "#56949f", "#907aa9", "#9893a5"];

const RULE_TYPE_LABELS: Record<RuleMatchType, string> = {
  exe: "⚙",
  title: "T",
  domain: "◎",
};

const RULE_TYPE_PRIORITY: Record<RuleMatchType, number> = {
  exe: 1,
  title: 2,
  domain: 3,
};

function formatDuration(milliseconds: number): string {
  const totalMinutes = Math.max(0, Math.floor(milliseconds / 60_000));
  if (milliseconds > 0 && totalMinutes === 0) return "<1м";
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes}м`;
  return minutes === 0 ? `${hours}ч` : `${hours}ч ${minutes}м`;
}

function formatTime(timestamp: number): string {
  return new Intl.DateTimeFormat("ru-RU", {
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

function groupSegments(segments: Segment[], liveSegmentId: number | undefined, now: number): SegmentGroup[] {
  const groups: SegmentGroup[] = [];
  const microSegments = segments.filter((segment) =>
    segment.id !== liveSegmentId && segmentDuration(segment, liveSegmentId, now) < 60_000,
  );
  const microGroupId = microSegments.length > 1
    ? `micro-${Math.min(...microSegments.map((segment) => segment.id))}`
    : null;
  for (const segment of [...segments].reverse()) {
    const isMicro = segment.id !== liveSegmentId && segmentDuration(segment, liveSegmentId, now) < 60_000;
    if (isMicro && microGroupId) {
      const existingMicroGroup = groups.find((group) => group.id === microGroupId);
      if (existingMicroGroup) existingMicroGroup.segments.push(segment);
      else groups.push({ id: microGroupId, isMicro: true, segments: [segment] });
      continue;
    }
    groups.push({ id: `segment-${segment.id}`, isMicro, segments: [segment] });
  }
  return groups;
}

function DashboardView() {
  const [segments, setSegments] = useState<Segment[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [stats, setStats] = useState<TodayStats>(EMPTY_STATS);
  const [progress, setProgress] = useState<ProgressOverview | null>(null);
  const [cumulative, setCumulative] = useState<TodayCumulative | null>(null);
  const [dailySeries, setDailySeries] = useState<DailySeriesDay[]>([]);
  const [afkSeries, setAfkSeries] = useState<AfkDay[]>([]);
  const [dayPrint, setDayPrint] = useState<DayPrintData | null>(null);
  const [dayPrintDate, setDayPrintDate] = useState("");
  const [shareBusy, setShareBusy] = useState<"day" | "week" | "challenge" | null>(null);
  const [shareMessage, setShareMessage] = useState<string | null>(null);
  const [dashboardView, setDashboardView] = useState<"today" | "trends">("today");
  const [trendsRange, setTrendsRange] = useState<7 | 30>(7);
  const [apps, setApps] = useState<AppToday[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const [dark, setDark] = useState(false);
  const [paused, setPaused] = useState(false);
  const [expandedApps, setExpandedApps] = useState<Set<string>>(new Set());
  const [selectedApp, setSelectedApp] = useState<string | null>(null);
  const [expandedMicroGroups, setExpandedMicroGroups] = useState<Set<string>>(new Set());
  const [classificationTarget, setClassificationTarget] = useState<ClassificationTarget | null>(null);
  const [classificationCategoryId, setClassificationCategoryId] = useState(0);
  const [classificationRemember, setClassificationRemember] = useState(true);
  const [classificationSaving, setClassificationSaving] = useState(false);
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [extensionChromeId, setExtensionChromeId] = useState("");
  const [extensionEdgeId, setExtensionEdgeId] = useState("");
  const [kindLabelUseful, setKindLabelUseful] = useState(DEFAULT_KIND_LABELS.useful);
  const [kindLabelNeutral, setKindLabelNeutral] = useState(DEFAULT_KIND_LABELS.neutral);
  const [kindLabelWaste, setKindLabelWaste] = useState(DEFAULT_KIND_LABELS.waste);
  const [kindLabelObserved, setKindLabelObserved] = useState(DEFAULT_KIND_LABELS.observed);
  const [usefulGoalMin, setUsefulGoalMin] = useState("120");
  const [wasteLimitMin, setWasteLimitMin] = useState("60");
  const [observedMin, setObservedMin] = useState("60");
  const [hourlyRate, setHourlyRate] = useState("");
  const [currency, setCurrency] = useState("₴");
  const [challengeInput, setChallengeInput] = useState("");
  const [challengeError, setChallengeError] = useState<string | null>(null);
  const [challengeImported, setChallengeImported] = useState(false);
  const [dbSizeMb, setDbSizeMb] = useState<number | null>(null);
  const [tokenCopied, setTokenCopied] = useState(false);
  const [categoryManagerOpen, setCategoryManagerOpen] = useState(false);
  const [categoryManagerTab, setCategoryManagerTab] = useState<"categories" | "rules">("categories");
  const [rules, setRules] = useState<Rule[]>([]);
  const [managerLoading, setManagerLoading] = useState(false);
  const [managerSaving, setManagerSaving] = useState(false);
  const [managerError, setManagerError] = useState<string | null>(null);
  const [managerNotice, setManagerNotice] = useState<string | null>(null);
  const [categoryFormOpen, setCategoryFormOpen] = useState(false);
  const [newCategoryName, setNewCategoryName] = useState("");
  const [newCategoryColor, setNewCategoryColor] = useState(CATEGORY_COLORS[3]);
  const [newCategoryKind, setNewCategoryKind] = useState<CategoryKind>("neutral");
  const [ruleFormOpen, setRuleFormOpen] = useState(false);
  const [newRuleType, setNewRuleType] = useState<RuleMatchType>("exe");
  const [newRulePattern, setNewRulePattern] = useState("");
  const [newRuleCategoryId, setNewRuleCategoryId] = useState<number | null>(null);
  const [newRulePriority, setNewRulePriority] = useState("0");

  const loadDashboard = useCallback(async () => {
    try {
      const [nextSegments, nextCategories, nextProgress, nextCumulative, nextDailySeries, nextAfkSeries, nextApps, nextSettings, trackingPaused] =
        await Promise.all([
          invoke<Segment[]>("get_today_segments"),
          invoke<Category[]>("get_categories"),
          invoke<ProgressOverview>("get_progress_overview"),
          invoke<TodayCumulative>("get_today_cumulative"),
          invoke<DailySeriesDay[]>("get_daily_series", { days: 36 }),
          invoke<AfkDay[]>("get_afk_series", { days: 30 }),
          invoke<AppToday[]>("get_apps_today"),
          invoke<Record<string, string>>("get_settings"),
          invoke<boolean>("get_tracking_paused"),
        ]);
      setSegments(nextSegments);
      setCategories(nextCategories);
      setProgress(nextProgress);
      setCumulative(nextCumulative);
      setDailySeries(nextDailySeries);
      setAfkSeries(nextAfkSeries);
      setStats(nextProgress.today);
      setApps(nextApps);
      let targetDate = dayPrintDate;
      if (!targetDate) {
        const yesterday = nextDailySeries[nextDailySeries.length - 2];
        const newestObserved = [...nextDailySeries].reverse().find((day) => day.observed_ms > 0);
        const unseenYesterday = yesterday?.observed_ms > 0
          && nextSettings.last_day_print_seen !== yesterday.local_date;
        targetDate = unseenYesterday
          ? yesterday.local_date
          : nextProgress.today.observed_ms > 0
            ? nextProgress.today.local_date
            : newestObserved?.local_date ?? nextProgress.today.local_date;
        if (unseenYesterday) {
          await invoke<void>("set_setting", { key: "last_day_print_seen", value: yesterday.local_date });
          nextSettings.last_day_print_seen = yesterday.local_date;
        }
      }
      setSettings(nextSettings);
      setDayPrintDate(targetDate);
      setDayPrint(await invoke<DayPrintData>("get_day_print", { localDate: targetDate }));
      setDark(nextSettings.theme === "dark");
      setPaused(trackingPaused);
      setError(null);
    } catch (reason: unknown) {
      setError(typeof reason === "string" ? reason : "Не удалось прочитать локальные данные");
    } finally {
      setLoading(false);
    }
  }, [dayPrintDate]);

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
    if (!settingsOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !settingsSaving) setSettingsOpen(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [settingsOpen, settingsSaving]);

  useEffect(() => {
    if (!categoryManagerOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !managerSaving) setCategoryManagerOpen(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [categoryManagerOpen, managerSaving]);

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
  const kindLabels = useMemo<KindLabels>(() => ({
    useful: settings.kind_label_useful ?? DEFAULT_KIND_LABELS.useful,
    neutral: settings.kind_label_neutral ?? DEFAULT_KIND_LABELS.neutral,
    waste: settings.kind_label_waste ?? DEFAULT_KIND_LABELS.waste,
    observed: settings.kind_label_observed ?? DEFAULT_KIND_LABELS.observed,
  }), [settings]);
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
        lastSegment,
        isLive,
      };
    })
    .filter((app): app is AppTimelineItem => app !== null)
    .sort((left, right) => Number(right.isLive) - Number(left.isLive) || right.duration_ms - left.duration_ms),
  [apps, live, now, segments]);
  const totalRing = Math.max(stats.observed_ms, 1);
  const ringParts = [
    { kind: "useful" as const, value: stats.useful_ms },
    { kind: "neutral" as const, value: stats.neutral_ms },
    { kind: "waste" as const, value: stats.waste_ms },
  ];
  let ringOffset = 0;
  const maxAppDuration = Math.max(...apps.map((app) => app.duration_ms), 1);
  const maxTimelineAppDuration = Math.max(...appTimeline.map((app) => app.duration_ms), 1);

  async function toggleTheme() {
    const nextDark = !dark;
    setDark(nextDark);
    try {
      await invoke("set_setting", {
        key: "theme",
        value: nextDark ? "dark" : "dawn",
      });
    } catch (reason: unknown) {
      setError(typeof reason === "string" ? reason : "Не удалось сохранить тему");
    }
  }

  async function reclassifyHistory(): Promise<void> {
    const summary = await invoke<ReclassificationSummary>("reclassify_history");
    const totalMinutes = Math.floor(summary.changed_duration_ms / 60_000);
    setManagerNotice(`Переклассифицировано ${Math.floor(totalMinutes / 60)} ч ${totalMinutes % 60} мин истории`);
  }

  async function reclassify(segmentId: number, categoryId: number, remember: boolean) {
    setClassificationSaving(true);
    try {
      await invoke("set_segment_category", {
        segmentId,
        categoryId: categoryId === 0 ? null : categoryId,
        remember: categoryId === 0 ? false : remember,
      });
      if (categoryId !== 0 && remember) await reclassifyHistory();
      setClassificationTarget(null);
      await loadDashboard();
    } catch (reason: unknown) {
      setError(typeof reason === "string" ? reason : "Не удалось изменить категорию");
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
      setError(typeof reason === "string" ? reason : "Не удалось изменить состояние трекинга");
    }
  }

  async function openSettings() {
    setExtensionChromeId(settings.extension_chrome_id ?? "");
    setExtensionEdgeId(settings.extension_edge_id ?? "");
    setKindLabelUseful(settings.kind_label_useful ?? DEFAULT_KIND_LABELS.useful);
    setKindLabelNeutral(settings.kind_label_neutral ?? DEFAULT_KIND_LABELS.neutral);
    setKindLabelWaste(settings.kind_label_waste ?? DEFAULT_KIND_LABELS.waste);
    setKindLabelObserved(settings.kind_label_observed ?? DEFAULT_KIND_LABELS.observed);
    setUsefulGoalMin(settings.useful_goal_min ?? "120");
    setWasteLimitMin(settings.waste_limit_min ?? "60");
    setObservedMin(settings.observed_min ?? "60");
    setHourlyRate(settings.hourly_rate ?? "");
    setCurrency(settings.currency ?? "₴");
    setChallengeInput("");
    setChallengeError(null);
    setChallengeImported(false);
    setDbSizeMb(null);
    setTokenCopied(false);
    setSettingsError(null);
    setSettingsOpen(true);
    try {
      setDbSizeMb(await invoke<number>("get_db_size_mb"));
    } catch (reason: unknown) {
      setSettingsError(typeof reason === "string" ? reason : "Не удалось узнать размер базы данных");
    }
  }

  async function openCategoryManager() {
    setCategoryManagerTab("categories");
    setCategoryFormOpen(false);
    setRuleFormOpen(false);
    setManagerError(null);
    setManagerNotice(null);
    setCategoryManagerOpen(true);
    setManagerLoading(true);
    try {
      const [nextCategories, nextRules] = await Promise.all([
        invoke<Category[]>("get_categories"),
        invoke<Rule[]>("get_rules"),
      ]);
      setCategories(nextCategories);
      setRules(nextRules);
      setNewRuleCategoryId(nextCategories.find((category) => category.id !== 0)?.id ?? null);
    } catch (reason: unknown) {
      setManagerError(typeof reason === "string" ? reason : "Не удалось загрузить категории и правила");
    } finally {
      setManagerLoading(false);
    }
  }

  async function createCategory(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setManagerSaving(true);
    setManagerError(null);
    try {
      const category = await invoke<Category>("create_category", {
        name: newCategoryName,
        color: newCategoryColor,
        kind: newCategoryKind,
      });
      await reclassifyHistory();
      setCategories((current) => [...current, category]);
      if (newRuleCategoryId === null) setNewRuleCategoryId(category.id);
      setNewCategoryName("");
      setNewCategoryColor(CATEGORY_COLORS[3]);
      setNewCategoryKind("neutral");
      setCategoryFormOpen(false);
      setError(null);
    } catch (reason: unknown) {
      setManagerError(typeof reason === "string" ? reason : "Не удалось создать категорию");
    } finally {
      setManagerSaving(false);
    }
  }

  async function deleteCategory(category: Category) {
    if (!window.confirm(`Удалить категорию «${category.name}»? Связанные правила тоже будут удалены.`)) return;
    setManagerSaving(true);
    setManagerError(null);
    try {
      await invoke<void>("delete_category", { id: category.id });
      await reclassifyHistory();
      setCategories((current) => current.filter((item) => item.id !== category.id));
      setRules((current) => current.filter((rule) => rule.category_id !== category.id));
      if (newRuleCategoryId === category.id) {
        setNewRuleCategoryId(manageableCategories.find((item) => item.id !== category.id)?.id ?? null);
      }
      await loadDashboard();
    } catch (reason: unknown) {
      setManagerError(typeof reason === "string" ? reason : "Не удалось удалить категорию");
    } finally {
      setManagerSaving(false);
    }
  }

  async function updateCategory(category: Category) {
    setManagerSaving(true);
    setManagerError(null);
    try {
      const updated = await invoke<Category>("update_category", {
        id: category.id,
        name: category.name,
        kind: category.kind,
      });
      await reclassifyHistory();
      setCategories((current) => current.map((item) => item.id === updated.id ? updated : item));
      await loadDashboard();
    } catch (reason: unknown) {
      setManagerError(typeof reason === "string" ? reason : "Не удалось изменить категорию");
      setCategories(await invoke<Category[]>("get_categories").catch(() => categories));
    } finally {
      setManagerSaving(false);
    }
  }

  async function createRule(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (newRuleCategoryId === null) {
      setManagerError("Сначала создайте категорию");
      return;
    }
    const priority = Number(newRulePriority);
    if (!Number.isSafeInteger(priority)) {
      setManagerError("Приоритет должен быть целым числом");
      return;
    }
    setManagerSaving(true);
    setManagerError(null);
    try {
      const rule = await invoke<Rule>("create_rule", {
        matchType: newRuleType,
        pattern: newRulePattern,
        categoryId: newRuleCategoryId,
        priority,
      });
      await reclassifyHistory();
      setRules((current) => [...current, rule].sort((left, right) =>
        right.priority - left.priority
          || RULE_TYPE_PRIORITY[right.match_type] - RULE_TYPE_PRIORITY[left.match_type]
          || left.id - right.id,
      ));
      setNewRulePattern("");
      setNewRulePriority("0");
      setRuleFormOpen(false);
    } catch (reason: unknown) {
      setManagerError(typeof reason === "string" ? reason : "Не удалось создать правило");
    } finally {
      setManagerSaving(false);
    }
  }

  async function deleteRule(ruleId: number) {
    setManagerSaving(true);
    setManagerError(null);
    try {
      await invoke<void>("delete_rule", { id: ruleId });
      await reclassifyHistory();
      setRules((current) => current.filter((rule) => rule.id !== ruleId));
    } catch (reason: unknown) {
      setManagerError(typeof reason === "string" ? reason : "Не удалось удалить правило");
    } finally {
      setManagerSaving(false);
    }
  }

  async function updateRuleCategory(ruleId: number, categoryId: number) {
    setManagerSaving(true);
    setManagerError(null);
    try {
      await invoke<void>("update_rule", { id: ruleId, categoryId });
      await reclassifyHistory();
      setRules((current) => current.map((rule) =>
        rule.id === ruleId ? { ...rule, category_id: categoryId } : rule,
      ));
    } catch (reason: unknown) {
      setManagerError(typeof reason === "string" ? reason : "Не удалось изменить правило");
    } finally {
      setManagerSaving(false);
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
      setSettingsError("Не удалось скопировать токен");
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
    const groups = groupSegments(
      segments.filter((item) => item.app === segment.app),
      live?.id,
      now,
    );
    const microGroup = groups.find((group) => group.isMicro && group.segments.some((item) => item.id === segmentId));
    if (microGroup) setExpandedMicroGroups((current) => new Set(current).add(microGroup.id));
    openClassification(segment, `segment-${segment.id}`);
  }

  function openClassification(segment: Segment, anchor: string) {
    setClassificationTarget({ segmentId: segment.id, anchor });
    setClassificationCategoryId(segment.category_id || 0);
    setClassificationRemember(segment.category_id !== 0);
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
      setSettingsError("ID должен состоять из 32 символов от a до p");
      return;
    }
    if (Object.values(nextKindLabels).some((label) => label.length === 0 || [...label].length > 80)) {
      setSettingsError("Названия типов должны содержать от 1 до 80 символов");
      return;
    }
    const goals = [usefulGoalMin, wasteLimitMin, observedMin];
    if (goals.some((value) => !/^\d+$/.test(value) || Number(value) > 1440)) {
      setSettingsError("Цели должны быть целыми числами от 0 до 1440 минут");
      return;
    }
    if (hourlyRate !== "" && (!/^\d+(?:[.,]\d+)?$/.test(hourlyRate) || Number(hourlyRate.replace(",", ".")) < 0)) {
      setSettingsError("Часовая ставка должна быть положительным числом");
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
      }));
      setSettingsOpen(false);
      setError(null);
      await loadDashboard();
    } catch (reason: unknown) {
      setSettingsError(typeof reason === "string" ? reason : "Не удалось сохранить настройки");
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
      setError(typeof reason === "string" ? reason : "Не удалось собрать Печать дня");
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
        dataUrl = await renderWeekPng(week, kindLabels);
        fileName = `ttli-week-${week.days[0]?.local_date ?? dayPrint.local_date}.png`;
      } else if (kind === "challenge") {
        dataUrl = await renderChallengePng(dayPrint, kindLabels);
        fileName = `ttli-challenge-${dayPrint.local_date}.png`;
      } else {
        dataUrl = await renderDayPrintPng(dayPrint, kindLabels);
        fileName = `ttli-day-print-${dayPrint.local_date}.png`;
      }
      const saved = await savePng(dataUrl, fileName);
      if (saved) setShareMessage("PNG сохранён");
    } catch (reason: unknown) {
      setShareMessage(typeof reason === "string" ? reason : "Не удалось сохранить PNG");
    } finally {
      setShareBusy(null);
    }
  }

  async function importChallenge() {
    const code = challengeInput;
    if (!/^TF-(\d+)-(\d+)-(\d+)$/.test(code)) {
      setChallengeError("Код должен быть в формате TF-184-43-60");
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
      setChallengeError(typeof reason === "string" ? reason : "Не удалось импортировать челлендж");
      setChallengeImported(false);
    }
  }

  function renderCategoryControl(segment: Segment, anchor: string, label?: string) {
    const category = categoryById.get(segment.category_id);
    const isOpen = classificationTarget?.segmentId === segment.id && classificationTarget.anchor === anchor;
    const selectedCategory = categoryById.get(classificationCategoryId);
    return (
      <div className="category-control" data-classification-root="true">
        <button
          type="button"
          className={`category-tag category-tag-button kind-${category?.kind ?? "muted"}`}
          aria-expanded={isOpen}
          onClick={() => isOpen ? setClassificationTarget(null) : openClassification(segment, anchor)}
        >
          {label ?? category?.name ?? "Без категории"}
        </button>
        {isOpen && (
          <div className="classification-popover" role="dialog" aria-label="Выбор категории и области действия">
            <span className="classification-title">Переклассифицировать</span>
            <label className="classification-category">
              <span>Категория</span>
              <select
                autoFocus
                value={classificationCategoryId}
                onChange={(event) => {
                  const categoryId = Number(event.target.value);
                  setClassificationCategoryId(categoryId);
                  setClassificationRemember(categoryId !== 0);
                }}
              >
                <option value={0}>Без категории</option>
                {manageableCategories.map((item) => (
                  <option key={item.id} value={item.id}>{item.name}</option>
                ))}
              </select>
            </label>
            <span className="classification-scope-label">Применить</span>
            {classificationCategoryId !== 0 && (
              <label className="classification-option is-default">
                <input
                  type="radio"
                  name={`classification-scope-${anchor}`}
                  checked={classificationRemember}
                  onChange={() => setClassificationRemember(true)}
                />
                <span><strong>Всегда относить {cleanAppName(segment.app)} к {selectedCategory?.name ?? "категории"}</strong><small>Запомнить правилом приложения</small></span>
              </label>
            )}
            <label className="classification-option">
              <input
                type="radio"
                name={`classification-scope-${anchor}`}
                checked={!classificationRemember}
                onChange={() => setClassificationRemember(false)}
              />
              <span><strong>Только этот отрезок</strong><small>Остальные сегменты не изменятся</small></span>
            </label>
            <button
              type="button"
              className="classification-apply"
              disabled={classificationSaving}
              onClick={() => void reclassify(segment.id, classificationCategoryId, classificationRemember)}
            >
              {classificationSaving ? "Сохраняем…" : "Применить"}
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
        <div className={`topbar-status ${paused ? "is-paused" : ""}`}><span className="status-dot" /> {paused ? "трекинг на паузе" : "трекинг включён"}</div>
        <div className="topbar-spacer" />
        <span className="date-label">
          {new Intl.DateTimeFormat("ru-RU", {
            weekday: "long",
            day: "numeric",
            month: "long",
          }).format(now)}
        </span>
        <button className="pause-button" onClick={() => void toggleTracking()}>{paused ? "Продолжить" : "Пауза"}</button>
        <button className="mini-open-button" onClick={() => void invoke("show_mini")}>Мини-окно</button>
        <button className="manager-open-button" onClick={() => void openCategoryManager()} aria-label="Открыть категории и правила">
          <span aria-hidden="true">🗂</span><span className="manager-open-label">Категории</span>
        </button>
        <button className="icon-button" onClick={() => void openSettings()} aria-label="Открыть настройки">
          ⚙
        </button>
        <button className="icon-button" onClick={() => void toggleTheme()} aria-label="Переключить тему">
          {dark ? "☀" : "☾"}
        </button>
      </header>

      <section className={`live-panel ${live ? "is-live" : ""}`}>
        <div className="live-pulse" />
        <div className="live-copy">
          <span className="eyebrow">Сейчас</span>
          <strong>{live ? cleanAppName(live.app) : "Ждём первое активное окно"}</strong>
          <span>{live ? live.domain || live.window_title || "Без заголовка" : "Вотчер запишет его на следующем тике"}</span>
        </div>
        {live && (
          <>
            {renderCategoryControl(live, "live")}
            <div className="live-clock">
              <strong>{formatDuration(now - live.ts_start)}</strong>
              <span>с {formatTime(live.ts_start)}</span>
            </div>
          </>
        )}
      </section>

      {error && <div className="error-banner">{error}. Данные обновятся автоматически.</div>}
      {managerNotice && <div className="history-toast" role="status">{managerNotice}</div>}

      <nav className="dashboard-view-tabs" aria-label="Раздел дашборда">
        <button
          type="button"
          aria-current={dashboardView === "today" ? "page" : undefined}
          onClick={() => setDashboardView("today")}
        >
          Сегодня
        </button>
        <button
          type="button"
          aria-current={dashboardView === "trends" ? "page" : undefined}
          onClick={() => setDashboardView("trends")}
        >
          Тренды
        </button>
      </nav>

      {dashboardView === "today" ? <>
      {loading || !progress ? (
        <div className="card progress-skeleton skeleton" aria-label="Загрузка прогресса" />
      ) : (
        <DayScorecard overview={progress} formatDuration={formatDuration} kindLabels={kindLabels} observedLabel={kindLabels.observed} />
      )}

      {dayPrint && (dayPrint.observed_ms > 0 || dayPrint.afk_ms > 0) && (
        <DayPrint
          data={dayPrint}
          availableDates={dailySeries
            .filter((day) => day.observed_ms > 0 || afkSeries.some((afkDay) =>
              afkDay.local_date === day.local_date && afkDay.afk_ms > 0,
            ))
            .map((day) => day.local_date)
            .reverse()}
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

      {loading || !cumulative ? (
        <div className="card cumulative-skeleton skeleton" aria-label="Загрузка графика дня" />
      ) : (
        <CumulativeChart data={cumulative} formatDuration={formatDuration} kindLabels={kindLabels} />
      )}

      <div className="dashboard-grid">
        <section className="card timeline-card">
          <div className="card-heading">
            <div><span className="eyebrow">Хронология</span><h1>Приложения за день</h1></div>
            <span className={`mono-meta ${selectedApp ? "is-selection" : ""}`}>
              {selectedApp ? `Фокус: ${cleanAppName(selectedApp)} · Esc — сбросить` : `${appTimeline.length} приложений · ${segments.length} сегментов`}
            </span>
          </div>

          {loading ? (
            <div className="skeleton timeline-skeleton" />
          ) : segments.length === 0 ? (
            <div className="empty-state"><strong>День ещё чистый</strong><span>Переключись в рабочее окно — первый сегмент появится здесь.</span></div>
          ) : (
            <>
              <div className="day-track" aria-label="24-часовая шкала активности">
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
                          "--segment-color": category?.color ?? "var(--cat-muted)",
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
                  const groups = groupSegments(app.segments, live?.id, now);
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
                            <small>{app.isLive ? <span className="now-marker">сейчас</span> : `${app.segments.length} сегментов`}</small>
                          </span>
                          <span className="app-day-bar"><i style={{ width: `${(app.duration_ms / maxTimelineAppDuration) * 100}%`, backgroundColor: appCategory?.color ?? "var(--cat-muted)" }} /></span>
                        </button>
                        {renderCategoryControl(app.lastSegment, `app-${app.app}`)}
                        <strong className="app-day-duration">{formatDuration(app.duration_ms)}</strong>
                      </div>
                      {isExpanded && (
                        <div className="app-segment-list">
                          {groups.map((group) => {
                            const isMicroGroup = group.isMicro && group.segments.length > 1;
                            const isMicroExpanded = expandedMicroGroups.has(group.id);
                            const groupDuration = group.segments.reduce(
                              (total, segment) => total + segmentDuration(segment, live?.id, now),
                              0,
                            );
                            if (isMicroGroup) {
                              return (
                                <div className="micro-group" key={group.id}>
                                  <button
                                    type="button"
                                    className="micro-group-main"
                                    aria-expanded={isMicroExpanded}
                                    onClick={() => setExpandedMicroGroups((current) => {
                                      const next = new Set(current);
                                      if (next.has(group.id)) next.delete(group.id);
                                      else next.add(group.id);
                                      return next;
                                    })}
                                  >
                                    <span className="segment-time">за день</span>
                                    <span className="segment-app"><strong>Микросегменты · {group.segments.length}</strong><small>короче минуты · нажми, чтобы разобрать</small></span>
                                    <span className="micro-cluster-mark" aria-label="Сгруппировано">···</span>
                                    <span className="segment-duration">{formatDuration(groupDuration)}</span>
                                  </button>
                                  {isMicroExpanded && (
                                    <div className="micro-segment-list">
                                      {group.segments.map((segment) => (
                                        <div className="app-segment-row is-micro" key={segment.id}>
                                          <span className="segment-time">{formatTime(segment.ts_start)}–{formatTime(segment.ts_end)}</span>
                                          <span className="segment-app"><small>{segment.domain || segment.window_title || "Без заголовка"}</small></span>
                                          {renderCategoryControl(segment, `segment-${segment.id}`)}
                                          <span className="segment-duration">{formatDuration(segmentDuration(segment, live?.id, now))}</span>
                                        </div>
                                      ))}
                                    </div>
                                  )}
                                </div>
                              );
                            }
                            const segment = group.segments[0];
                            const segmentEnd = segment.id === live?.id ? now : segment.ts_end;
                            return (
                              <div className="app-segment-row" key={group.id}>
                                <span className="segment-time">{formatTime(segment.ts_start)}–{formatTime(segmentEnd)}</span>
                                <span className="segment-app"><small>{segment.domain || segment.window_title || "Без заголовка"}</small></span>
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

        <aside className="side-column">
          <section className="card stats-card">
            <div className="card-heading"><div><span className="eyebrow">Баланс</span><h2>Куда ушло время</h2></div></div>
            <div className="ring-layout">
              <div className="time-ring">
                <svg viewBox="0 0 120 120" aria-label={`Учтено ${formatDuration(stats.observed_ms)}`}>
                  <circle className="ring-base" cx="60" cy="60" r="48" pathLength="100" />
                  {ringParts.map((part) => {
                    const length = (part.value / totalRing) * 100;
                    const offset = ringOffset;
                    ringOffset += length;
                    return <circle key={part.kind} className={`ring-part kind-${part.kind}`} cx="60" cy="60" r="48" pathLength="100" strokeDasharray={`${length} ${100 - length}`} strokeDashoffset={-offset} />;
                  })}
                </svg>
                <div className="ring-center"><strong>{formatDuration(stats.observed_ms)}</strong><span>учтено</span></div>
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

          <section className={`card apps-card ${selectedApp ? "has-selection" : ""}`}>
            <div className="card-heading"><div><span className="eyebrow">Рейтинг</span><h2>Приложения</h2></div></div>
            {apps.length === 0 ? <p className="quiet-empty">Пока нет данных</p> : apps.slice(0, 6).map((app) => {
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
      </> : (
        <section className="trends-section" aria-label="Тренды активности">
          <div className="trends-section-heading">
            <div><span className="eyebrow">История</span><h1>Объяснить последние дни</h1></div>
            <p>Состав показывает, куда ушло время. Среднее отделяет направление от шума отдельных дней.</p>
          </div>
          {loading || dailySeries.length === 0 ? (
            <div className="card trends-skeleton skeleton" aria-label="Загрузка трендов" />
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
            </>
          )}
        </section>
      )}

      {categoryManagerOpen && (
        <div className="settings-overlay">
          <section className="settings-modal category-manager-modal" role="dialog" aria-modal="true" aria-labelledby="category-manager-title">
            <div className="settings-heading category-manager-heading">
              <div>
                <span className="eyebrow">Классификация</span>
                <h2 id="category-manager-title">Категории и правила</h2>
              </div>
            </div>

            <div className="manager-tabs" role="tablist" aria-label="Раздел менеджера">
              <button
                type="button"
                role="tab"
                aria-selected={categoryManagerTab === "categories"}
                className={categoryManagerTab === "categories" ? "is-active" : ""}
                onClick={() => setCategoryManagerTab("categories")}
              >
                Категории
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={categoryManagerTab === "rules"}
                className={categoryManagerTab === "rules" ? "is-active" : ""}
                onClick={() => setCategoryManagerTab("rules")}
              >
                Правила
              </button>
            </div>

            <div className="manager-content">
              {managerLoading ? (
                <div className="manager-loading skeleton" aria-label="Загрузка" />
              ) : categoryManagerTab === "categories" ? (
                <div role="tabpanel">
                  <div className="manager-toolbar">
                    <p>{manageableCategories.length} категорий</p>
                    <button type="button" className="manager-add-button" onClick={() => setCategoryFormOpen((open) => !open)}>
                      + Категория
                    </button>
                  </div>

                  {categoryFormOpen && (
                    <form className="manager-form category-form" onSubmit={(event) => void createCategory(event)}>
                      <label className="manager-field manager-field-wide">
                        <span>Название</span>
                        <input
                          autoFocus
                          required
                          maxLength={80}
                          value={newCategoryName}
                          onChange={(event) => setNewCategoryName(event.target.value)}
                          placeholder="Например, Учёба"
                        />
                      </label>
                      <label className="manager-field">
                        <span>Тип</span>
                        <select value={newCategoryKind} onChange={(event) => setNewCategoryKind(event.target.value as CategoryKind)}>
                          <option value="useful">{kindLabels.useful}</option>
                          <option value="neutral">{kindLabels.neutral}</option>
                          <option value="waste">{kindLabels.waste}</option>
                        </select>
                      </label>
                      <div className="manager-field manager-color-field">
                        <span>Цвет</span>
                        <div>
                          <input
                            type="color"
                            value={newCategoryColor}
                            onChange={(event) => setNewCategoryColor(event.target.value)}
                            aria-label="Свой цвет категории"
                          />
                          <div className="color-presets" aria-label="Цвета Rosé Pine">
                            {CATEGORY_COLORS.map((color) => (
                              <button
                                key={color}
                                type="button"
                                className={newCategoryColor === color ? "is-selected" : ""}
                                style={{ backgroundColor: color }}
                                aria-label={`Выбрать цвет ${color}`}
                                aria-pressed={newCategoryColor === color}
                                onClick={() => setNewCategoryColor(color)}
                              />
                            ))}
                          </div>
                        </div>
                      </div>
                      <div className="manager-form-actions">
                        <button type="button" className="manager-cancel-button" onClick={() => setCategoryFormOpen(false)}>Отмена</button>
                        <button type="submit" className="manager-submit-button" disabled={managerSaving}>
                          {managerSaving ? "Создаём…" : "Создать"}
                        </button>
                      </div>
                    </form>
                  )}

                  <div className="manager-list">
                    {manageableCategories.length === 0 ? (
                      <p className="manager-empty">Категорий пока нет. Создайте первую.</p>
                    ) : manageableCategories.map((category) => (
                      <div className="category-manager-row" key={category.id}>
                        <span className="manager-color-dot" style={{ backgroundColor: category.color }} />
                        <input
                          className="category-name-input"
                          aria-label={`Название категории ${category.name}`}
                          disabled={managerSaving}
                          maxLength={80}
                          value={category.name}
                          onChange={(event) => setCategories((current) => current.map((item) =>
                            item.id === category.id ? { ...item, name: event.target.value } : item,
                          ))}
                          onBlur={() => void updateCategory(category)}
                          onKeyDown={(event) => {
                            if (event.key === "Enter") event.currentTarget.blur();
                          }}
                        />
                        <select
                          className={`manager-kind kind-${category.kind}`}
                          aria-label={`Тип категории ${category.name}`}
                          disabled={managerSaving}
                          value={category.kind}
                          onChange={(event) => {
                            const next = { ...category, kind: event.target.value as CategoryKind };
                            setCategories((current) => current.map((item) => item.id === category.id ? next : item));
                            void updateCategory(next);
                          }}
                        >
                          <option value="useful">{kindLabels.useful}</option>
                          <option value="neutral">{kindLabels.neutral}</option>
                          <option value="waste">{kindLabels.waste}</option>
                        </select>
                        <button
                          type="button"
                          className="manager-delete-button"
                          disabled={managerSaving}
                          onClick={() => void deleteCategory(category)}
                          aria-label={`Удалить категорию ${category.name}`}
                          title="Удалить категорию"
                        >
                          🗑
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                <div role="tabpanel">
                  <div className="manager-toolbar">
                    <p>{rules.length} правил</p>
                    <button
                      type="button"
                      className="manager-add-button"
                      disabled={manageableCategories.length === 0}
                      onClick={() => {
                        setRuleFormOpen((open) => !open);
                        if (newRuleCategoryId === null) setNewRuleCategoryId(manageableCategories[0]?.id ?? null);
                      }}
                    >
                      + Правило
                    </button>
                  </div>

                  {ruleFormOpen && (
                    <form className="manager-form rule-form" onSubmit={(event) => void createRule(event)}>
                      <label className="manager-field">
                        <span>Тип</span>
                        <select value={newRuleType} onChange={(event) => setNewRuleType(event.target.value as RuleMatchType)}>
                          <option value="exe">exe</option>
                          <option value="title">title</option>
                          <option value="domain">domain</option>
                        </select>
                      </label>
                      <label className="manager-field manager-field-wide">
                        <span>Паттерн</span>
                        <input
                          autoFocus
                          required
                          maxLength={500}
                          value={newRulePattern}
                          onChange={(event) => setNewRulePattern(event.target.value)}
                          placeholder={newRuleType === "exe" ? "Code.exe" : "youtube"}
                        />
                      </label>
                      <label className="manager-field">
                        <span>Категория</span>
                        <select
                          required
                          value={newRuleCategoryId ?? ""}
                          onChange={(event) => setNewRuleCategoryId(Number(event.target.value))}
                        >
                          {manageableCategories.map((category) => (
                            <option key={category.id} value={category.id}>{category.name}</option>
                          ))}
                        </select>
                      </label>
                      <label className="manager-field manager-priority-field">
                        <span>Приоритет</span>
                        <input
                          type="number"
                          step="1"
                          value={newRulePriority}
                          onChange={(event) => setNewRulePriority(event.target.value)}
                        />
                      </label>
                      <p className="manager-form-hint">exe: название процесса (Code.exe), title/domain: подстрока (youtube)</p>
                      <div className="manager-form-actions">
                        <button type="button" className="manager-cancel-button" onClick={() => setRuleFormOpen(false)}>Отмена</button>
                        <button type="submit" className="manager-submit-button" disabled={managerSaving}>
                          {managerSaving ? "Создаём…" : "Создать"}
                        </button>
                      </div>
                    </form>
                  )}

                  <div className="manager-list rule-list">
                    {rules.length === 0 ? (
                      <p className="manager-empty">Правил пока нет. Добавьте первое правило классификации.</p>
                    ) : rules.map((rule) => {
                      const category = categoryById.get(rule.category_id);
                      return (
                        <div className="rule-manager-row" key={rule.id}>
                          <span className="rule-type-icon" title={`${rule.match_type}, приоритет ${rule.priority}`}>
                            {RULE_TYPE_LABELS[rule.match_type]}
                          </span>
                          <span className="rule-pattern"><small>{rule.match_type}</small><strong>{rule.pattern}</strong></span>
                          <span className="rule-arrow">→</span>
                          <label className="rule-category">
                            <span className="manager-color-dot" style={{ backgroundColor: category?.color ?? "var(--cat-muted)" }} />
                            <select
                              value={rule.category_id}
                              disabled={managerSaving}
                              aria-label={`Категория правила ${rule.pattern}`}
                              onChange={(event) => void updateRuleCategory(rule.id, Number(event.target.value))}
                            >
                              {manageableCategories.map((item) => (
                                <option key={item.id} value={item.id}>{item.name}</option>
                              ))}
                            </select>
                          </label>
                          <button
                            type="button"
                            className="manager-delete-button"
                            disabled={managerSaving}
                            onClick={() => void deleteRule(rule.id)}
                            aria-label={`Удалить правило ${rule.pattern}`}
                            title="Удалить правило"
                          >
                            🗑
                          </button>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>

            {managerError && <p className="settings-error manager-error">{managerError}</p>}
            <div className="settings-actions manager-done-actions">
              <button className="settings-done" disabled={managerSaving} onClick={() => setCategoryManagerOpen(false)}>
                Готово
              </button>
            </div>
          </section>
        </div>
      )}

      {settingsOpen && (
        <div className="settings-overlay">
          <section className="settings-modal" role="dialog" aria-modal="true" aria-labelledby="settings-title">
            <div className="settings-heading">
              <span className="eyebrow">Система</span>
              <h2 id="settings-title">Настройки</h2>
            </div>
            <div className="settings-scroll">
              <section className="settings-section" aria-labelledby="goal-settings-title">
                <div className="settings-section-heading">
                  <h3 id="goal-settings-title">Зачёт дня</h3>
                  <span>Новые значения действуют с сегодняшней даты</span>
                </div>
                <div className="goal-settings-grid">
                  <label className="settings-field"><span>{kindLabelUseful} · цель, мин</span><input type="number" min="0" max="1440" step="1" value={usefulGoalMin} onChange={(event) => setUsefulGoalMin(event.target.value)} /></label>
                  <label className="settings-field"><span>{kindLabelWaste} · лимит, мин</span><input type="number" min="0" max="1440" step="1" value={wasteLimitMin} onChange={(event) => setWasteLimitMin(event.target.value)} /></label>
                  <label className="settings-field"><span>{kindLabelObserved} · минимум, мин</span><input type="number" min="0" max="1440" step="1" value={observedMin} onChange={(event) => setObservedMin(event.target.value)} /></label>
                </div>
                <div className="money-settings-grid">
                  <label className="settings-field">
                    <span>Часовая ставка · необязательно</span>
                    <input type="text" inputMode="decimal" placeholder="Не показывать сожжённые деньги" value={hourlyRate} onChange={(event) => setHourlyRate(event.target.value)} />
                  </label>
                  <label className="settings-field">
                    <span>Валюта</span>
                    <select value={currency} onChange={(event) => setCurrency(event.target.value)}>
                      {["₴", "$", "€", "₽"].map((symbol) => <option key={symbol} value={symbol}>{symbol}</option>)}
                    </select>
                  </label>
                </div>
              </section>

              <section className="settings-section" aria-labelledby="challenge-settings-title">
                <div className="settings-section-heading">
                  <h3 id="challenge-settings-title">Челлендж «Побей мой день»</h3>
                  <span>Код меняет локальные цели с сегодняшней даты</span>
                </div>
                <div className="challenge-import-row">
                  <label className="settings-field">
                    <span>Код челленджа</span>
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
                  <button type="button" onClick={() => void importChallenge()}>Принять вызов</button>
                </div>
                {challengeError && <p className="settings-error" id="challenge-import-error">{challengeError}</p>}
                {challengeImported && <p className="challenge-imported" role="status">Челлендж принят. Цели сохранены локально.</p>}
              </section>

              <section className="settings-section" aria-labelledby="kind-labels-title">
                <div className="settings-section-heading">
                  <h3 id="kind-labels-title">Названия типов времени</h3>
                  <span>Отображаются в балансе и категориях</span>
                </div>
                <div className="kind-label-grid">
                  <label className="settings-field">
                    <span>Название {DEFAULT_KIND_LABELS.useful}</span>
                    <input autoFocus required maxLength={80} value={kindLabelUseful} onChange={(event) => setKindLabelUseful(event.target.value)} />
                  </label>
                  <label className="settings-field">
                    <span>Название {DEFAULT_KIND_LABELS.neutral}</span>
                    <input required maxLength={80} value={kindLabelNeutral} onChange={(event) => setKindLabelNeutral(event.target.value)} />
                  </label>
                  <label className="settings-field">
                    <span>Название {DEFAULT_KIND_LABELS.waste}</span>
                    <input required maxLength={80} value={kindLabelWaste} onChange={(event) => setKindLabelWaste(event.target.value)} />
                  </label>
                  <label className="settings-field">
                    <span>Название {DEFAULT_KIND_LABELS.observed}</span>
                    <input required maxLength={80} value={kindLabelObserved} onChange={(event) => setKindLabelObserved(event.target.value)} />
                  </label>
                </div>
              </section>

              <section className="settings-section" aria-labelledby="browser-settings-title">
                <div className="settings-section-heading">
                  <h3 id="browser-settings-title">Браузер</h3>
                  <span>Локальное расширение Chrome / Edge</span>
                </div>
                <label className="settings-field">
                  <span>ID расширения Chrome</span>
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
                  <span>ID расширения Edge</span>
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
                  ID подхватывается автоматически при первом контакте расширения — достаточно вставить токен. Поля ниже заполняются сами; вручную править нужно только если что-то пошло не так (ID виден в chrome://extensions → TTLI Tracker → ID).
                </p>
                <p className="settings-hint">Мини-окно: клик по иконке TTLI в трее или кнопка &quot;Мини-окно&quot; на дашборде</p>
                <div className="settings-token">
                  <span>Токен расширения</span>
                  <div>
                    <code>{settings.extension_token || "—"}</code>
                    <button
                      disabled={!settings.extension_token}
                      onClick={() => void copyExtensionToken()}
                    >
                      {tokenCopied ? "Скопировано" : "Скопировать"}
                    </button>
                  </div>
                  <p>Вставляется в расширение TTLI Tracker (поп-ап расширения).</p>
                </div>
              </section>

              <div className="database-size">
                <span>Размер базы данных</span>
                <strong>{dbSizeMb === null ? "…" : `${dbSizeMb.toFixed(1)} МБ`}</strong>
              </div>
            </div>
            {settingsError && <p className="settings-error" id="settings-error">{settingsError}</p>}
            <div className="settings-actions">
              <button className="settings-done" disabled={settingsSaving} onClick={() => void saveSettings()}>
                {settingsSaving ? "Сохраняем…" : "Готово"}
              </button>
            </div>
          </section>
        </div>
      )}
    </main>
  );
}

function App() {
  return getCurrentWindow().label === "mini" ? <MiniView /> : <DashboardView />;
}

export default App;
