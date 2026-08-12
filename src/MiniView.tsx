import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { ProgressOverview } from "./progress";
import { localeForLang } from "./i18n";
import { useI18n } from "./i18nContext";
import { formatCompactMinutes, formatObservedClock, getMiniVerdict } from "./miniVerdict";

type CategoryKind = "useful" | "neutral" | "waste";

interface LiveSegment {
  id: number;
  ts_start: number;
  ts_end: number;
  app: string;
  window_title: string;
  domain: string;
  status: "active" | "away";
  category_name: string;
  category_kind: CategoryKind;
  is_uncategorized: boolean;
}

interface MiniHourlyBucket {
  hour_ts: number;
  useful_ms: number;
  neutral_ms: number;
  waste_ms: number;
}

type ContextIdentity = Pick<LiveSegment, "app" | "window_title" | "domain">;
type MiniMode = "auto" | "compact" | "detailed";
type MiniTextSize = "normal" | "large";
type MiniCorner = "tl" | "tr" | "bl" | "br";

type BulletBarProps = {
  kind: "useful" | "neutral" | "waste";
  label: string;
  valueMs: number;
} & ({ threshold: { minutes: number; label: string } } | { threshold?: undefined });

function cleanAppName(app: string): string {
  return app.replace(/\.exe$/i, "");
}

function sameContext(previous: ContextIdentity, next: ContextIdentity): boolean {
  return previous.app === next.app
    && previous.window_title === next.window_title
    && previous.domain === next.domain;
}

function BulletBar({ kind, label, valueMs, threshold }: BulletBarProps) {
  const thresholdMs = threshold === undefined ? null : threshold.minutes * 60_000;
  const scaleMs = thresholdMs === null ? Math.max(valueMs, 1) : Math.max(thresholdMs * 1.25, valueMs, 1);
  const overflowedWaste = kind === "waste" && thresholdMs !== null && valueMs > thresholdMs;
  const fill = overflowedWaste ? 100 : Math.min(100, valueMs / scaleMs * 100);
  const tick = thresholdMs === null ? null : Math.min(100, thresholdMs / scaleMs * 100);
  const value = formatCompactMinutes(Math.floor(valueMs / 60_000));

  return (
    <div className={`mini-bullet kind-${kind}`}>
      <div className="mini-bullet-copy">
        <span>{label}</span>
        <strong>
          {threshold === undefined
            ? value
            : <>{value} / {formatCompactMinutes(threshold.minutes)} <small>· {threshold.label}</small></>}
        </strong>
      </div>
      <div className="mini-bullet-rail" aria-hidden="true">
        <i style={{ width: `${fill}%` }} />
        {tick !== null && <span style={{ left: `${tick}%` }} />}
      </div>
    </div>
  );
}

function MiniHourlyChart({ buckets }: { buckets: MiniHourlyBucket[] }) {
  const { lang, t } = useI18n();
  const locale = localeForLang(lang);

  return (
    <section className="mini-hourly" aria-label={t("mini.hourlyAria")}>
      <span className="mini-expanded-label">{t("mini.hourlyTitle")}</span>
      <div className="mini-hourly-columns">
        {buckets.map((bucket, index) => {
          const segments = [
            ["useful", bucket.useful_ms],
            ["neutral", bucket.neutral_ms],
            ["waste", bucket.waste_ms],
          ] as const;
          return (
            <div className="mini-hour" key={bucket.hour_ts}>
              <div className="mini-hour-stack" aria-hidden="true">
                {segments.map(([kind, value]) => (
                  <i
                    className={`kind-${kind}${value > 0 ? " is-present" : ""}`}
                    key={kind}
                    style={{ height: `${Math.min(100, value / 3_600_000 * 100)}%` }}
                  />
                ))}
              </div>
              <span>{index % 3 === 0 || index === buckets.length - 1
                ? new Date(bucket.hour_ts).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" })
                : ""}</span>
            </div>
          );
        })}
      </div>
    </section>
  );
}

export function MiniView() {
  const { lang, t } = useI18n();
  const defaultKindLabels: Record<CategoryKind, string> = {
    useful: t("mini.defaultUseful"),
    neutral: t("mini.defaultNeutral"),
    waste: t("mini.defaultWaste"),
  };
  const [progress, setProgress] = useState<ProgressOverview | null>(null);
  const [hourly, setHourly] = useState<MiniHourlyBucket[]>([]);
  const [liveSegment, setLiveSegment] = useState<LiveSegment | null>(null);
  const [paused, setPaused] = useState(false);
  const [pinned, setPinned] = useState(true);
  const [mode, setMode] = useState<MiniMode>("auto");
  const [textSize, setTextSize] = useState<MiniTextSize>("normal");
  const [privacyNow, setPrivacyNow] = useState(false);
  const [showMiniAtLaunch, setShowMiniAtLaunch] = useState(false);
  const [corner, setCorner] = useState<MiniCorner | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [cornerOpen, setCornerOpen] = useState(false);
  const [kindLabels, setKindLabels] = useState(defaultKindLabels);
  const [loaded, setLoaded] = useState(false);
  const [showSwitchExplanation, setShowSwitchExplanation] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const previousContext = useRef<ContextIdentity | null>(null);
  const explanationHandled = useRef(false);
  const explanationNeedsPersistence = useRef(false);
  const explanationSaveInFlight = useRef(false);
  const explanationTimer = useRef<number | null>(null);
  const modeRef = useRef<MiniMode>(mode);
  modeRef.current = mode;

  const loadMini = useCallback(async () => {
    try {
      const [nextProgress, nextLiveSegment, trackingPaused, settings, nextHourly] = await Promise.all([
        invoke<ProgressOverview>("get_progress_overview"),
        invoke<LiveSegment | null>("get_live_segment"),
        invoke<boolean>("get_tracking_paused"),
        invoke<Record<string, string>>("get_settings"),
        invoke<MiniHourlyBucket[]>("mini_hourly", { limitHours: 12 }),
      ]);
      setProgress(nextProgress);
      setLiveSegment(nextLiveSegment);
      setPaused(trackingPaused);
      setPinned(settings.mini_pinned === "1");
      setMode(settings.mini_mode === "compact" || settings.mini_mode === "detailed" ? settings.mini_mode : "auto");
      setTextSize(settings.mini_text_size === "large" ? "large" : "normal");
      setPrivacyNow(settings.mini_privacy_now === "1");
      setShowMiniAtLaunch(settings.tray_only === "0");
      setCorner(matchesMiniCorner(settings.mini_corner) ? settings.mini_corner : null);
      setHourly(nextHourly);
      setKindLabels({
        useful: settings.kind_label_useful ?? defaultKindLabels.useful,
        neutral: settings.kind_label_neutral ?? defaultKindLabels.neutral,
        waste: settings.kind_label_waste ?? defaultKindLabels.waste,
      });
      if (settings.mini_observed_explained_v1 === "1") {
        explanationHandled.current = true;
        explanationNeedsPersistence.current = false;
      } else if (
        !explanationHandled.current
        && previousContext.current !== null
        && nextLiveSegment !== null
        && !sameContext(previousContext.current, nextLiveSegment)
      ) {
        explanationHandled.current = true;
        explanationNeedsPersistence.current = true;
        setShowSwitchExplanation(true);
        if (explanationTimer.current !== null) window.clearTimeout(explanationTimer.current);
        explanationTimer.current = window.setTimeout(() => setShowSwitchExplanation(false), 4_500);
      }
      if (nextLiveSegment !== null) previousContext.current = nextLiveSegment;
      if (explanationNeedsPersistence.current && !explanationSaveInFlight.current) {
        explanationSaveInFlight.current = true;
        void invoke("set_setting", { key: "mini_observed_explained_v1", value: "1" })
          .then(() => {
            explanationNeedsPersistence.current = false;
          })
          .catch((reason: unknown) => {
            setError(typeof reason === "string" ? reason : t("error.saveSettings"));
          })
          .finally(() => {
            explanationSaveInFlight.current = false;
          });
      }
      document.documentElement.dataset.theme = settings.theme === "dark" ? "dark" : "";
      setError(null);
    } catch (reason: unknown) {
      setLiveSegment(null);
      setError(typeof reason === "string" ? reason : t("error.miniRefresh"));
    } finally {
      setLoaded(true);
    }
  }, [t]);

  useEffect(() => {
    document.body.classList.add("is-mini");
    void loadMini();
    let active = true;
    let geometryTimer: number | null = null;
    let stopResizeListener: (() => void) | null = null;
    let stopMoveListener: (() => void) | null = null;
    const saveGeometry = () => {
      if (geometryTimer !== null) window.clearTimeout(geometryTimer);
      geometryTimer = window.setTimeout(() => void invoke("save_mini_geometry"), 400);
    };
    void getCurrentWindow().onResized(() => {
      saveGeometry();
      if (modeRef.current === "detailed") void invoke("resize_mini", { width: 420, height: 300 });
    }).then((unlisten) => {
      if (active) stopResizeListener = unlisten;
      else unlisten();
    });
    void getCurrentWindow().onMoved(saveGeometry).then((unlisten) => {
      if (active) stopMoveListener = unlisten;
      else unlisten();
    });
    const refresh = window.setInterval(() => void loadMini(), 5_000);
    return () => {
      active = false;
      document.body.classList.remove("is-mini");
      stopResizeListener?.();
      stopMoveListener?.();
      if (geometryTimer !== null) window.clearTimeout(geometryTimer);
      window.clearInterval(refresh);
      if (explanationTimer.current !== null) window.clearTimeout(explanationTimer.current);
    };
  }, [loadMini]);

  useEffect(() => {
    if (mode === "detailed") void invoke("resize_mini", { width: 420, height: 300 });
  }, [mode]);

  async function toggleTracking(event: React.MouseEvent<HTMLButtonElement>) {
    event.stopPropagation();
    const nextPaused = !paused;
    setPaused(nextPaused);
    try {
      await invoke("set_tracking_paused", { paused: nextPaused });
      await loadMini();
    } catch (reason: unknown) {
      setPaused(!nextPaused);
      setError(typeof reason === "string" ? reason : t("error.changeTracking"));
    }
  }

  async function togglePin(event: React.MouseEvent<HTMLButtonElement>) {
    event.stopPropagation();
    const nextPinned = !pinned;
    setPinned(nextPinned);
    try {
      await invoke("set_mini_pinned", { pinned: nextPinned });
    } catch (reason: unknown) {
      setPinned(!nextPinned);
      setError(typeof reason === "string" ? reason : t("error.miniPin"));
    }
  }

  async function saveSetting(key: string, value: string): Promise<void> {
    try {
      await invoke("set_setting", { key, value });
      setError(null);
    } catch (reason: unknown) {
      setError(typeof reason === "string" ? reason : t("error.saveSettings"));
      throw reason;
    }
  }

  async function changeMode(nextMode: MiniMode) {
    const previous = mode;
    setMode(nextMode);
    try {
      if (nextMode === "detailed") await invoke("resize_mini", { width: 420, height: 300 });
      await saveSetting("mini_mode", nextMode);
    } catch {
      setMode(previous);
    }
  }

  async function changeTextSize(nextSize: MiniTextSize) {
    const previous = textSize;
    setTextSize(nextSize);
    try {
      await saveSetting("mini_text_size", nextSize);
    } catch {
      setTextSize(previous);
    }
  }

  async function changePrivacy(nextPrivacy: boolean) {
    setPrivacyNow(nextPrivacy);
    try {
      await saveSetting("mini_privacy_now", nextPrivacy ? "1" : "0");
    } catch {
      setPrivacyNow(!nextPrivacy);
    }
  }

  async function changeLaunchVisibility(nextShow: boolean) {
    setShowMiniAtLaunch(nextShow);
    try {
      await saveSetting("tray_only", nextShow ? "0" : "1");
    } catch {
      setShowMiniAtLaunch(!nextShow);
    }
  }

  async function resetGeometry() {
    try {
      await invoke("reset_mini_geometry");
      setCorner(null);
      if (mode === "detailed") await invoke("resize_mini", { width: 420, height: 300 });
      setSettingsOpen(false);
    } catch (reason: unknown) {
      setError(typeof reason === "string" ? reason : t("error.saveSettings"));
    }
  }

  async function selectCorner(nextCorner: MiniCorner) {
    const previous = corner;
    setCorner(previous === nextCorner ? null : nextCorner);
    try {
      await invoke("pin_mini_corner", { corner: nextCorner });
      setCornerOpen(false);
    } catch (reason: unknown) {
      setCorner(previous);
      setError(typeof reason === "string" ? reason : t("error.miniPin"));
    }
  }

  async function toggleCornerPopover(event: React.MouseEvent<HTMLButtonElement>) {
    event.stopPropagation();
    setSettingsOpen(false);
    if (corner) {
      await selectCorner(corner);
    } else {
      setCornerOpen((open) => !open);
    }
  }

  const away = liveSegment?.status === "away";
  const verdict = progress ? getMiniVerdict({
    usefulMs: progress.today.useful_ms,
    wasteMs: progress.today.waste_ms,
    observedMs: progress.today.observed_ms,
    usefulGoalMin: progress.today.useful_goal_min,
    wasteLimitMin: progress.today.waste_limit_min,
    observedMin: progress.today.observed_min,
    usefulLabel: kindLabels.useful,
    wasteLabel: kindLabels.waste,
  }) : null;
  const verdictText = showSwitchExplanation
    ? t("mini.switchExplanation")
    : verdict ? t(verdict.key, verdict.vars) : t("mini.verdictInProgress");
  const actualCurrentApp = paused
    ? t("mini.trackingPaused")
    : !loaded
      ? t("mini.determiningWindow")
      : away
        ? t("mini.nowBreak")
        : liveSegment
          ? cleanAppName(liveSegment.app)
          : t("mini.noActiveWindow");
  const currentCategory = !paused && loaded && !away && liveSegment
    ? liveSegment.is_uncategorized ? t("common.uncategorized") : liveSegment.category_name
    : null;
  const currentTone = paused || away
    ? "warning"
    : !loaded || !liveSegment
      ? "muted"
      : liveSegment.is_uncategorized ? "muted" : liveSegment.category_kind;
  const currentApp = privacyNow && !paused && loaded && !away
    ? currentCategory ?? t("mini.hiddenApp")
    : actualCurrentApp;
  const nextRankNeeded = progress?.next_rank_threshold === null || progress?.next_rank_threshold === undefined
    ? null
    : Math.max(0, progress.next_rank_threshold - progress.lifetime_xp);
  const rankSpan = progress?.next_rank_threshold === null || progress?.next_rank_threshold === undefined
    ? 0
    : progress.next_rank_threshold - progress.current_rank_threshold;
  const rankProgress = !progress || rankSpan <= 0
    ? 100
    : Math.min(100, Math.max(0, (progress.lifetime_xp - progress.current_rank_threshold) / rankSpan * 100));

  return (
    <main className={`mini-shell mini-mode-${mode}${textSize === "large" ? " mini-text-large" : ""}${corner ? " is-corner-pinned" : ""}`}>
      <div
        className="mini-drag-strip"
        onMouseDown={(event) => {
          event.stopPropagation();
          if (event.button === 0 && !corner) void invoke("start_mini_drag");
        }}
      >
        <span className="mini-brand">TTLI</span>
        <span className={`mini-pulse ${paused ? "" : away ? "is-away" : liveSegment ? "is-live" : ""}`} />
        <button
          type="button"
          className="mini-settings-button"
          aria-label={t("mini.settings")}
          aria-expanded={settingsOpen}
          onMouseDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            setCornerOpen(false);
            setSettingsOpen((open) => !open);
          }}
        >⚙</button>
      </div>

      <section className="mini-hero" aria-label={t("mini.observedToday")}>
        <span>{t("mini.observedToday")}</span>
        <strong>{formatObservedClock(progress?.today.observed_ms ?? 0)}</strong>
      </section>

      <p className={`mini-verdict${showSwitchExplanation ? " is-explanation" : ""}`} title={verdictText}>{verdictText}</p>

      {progress ? (
        <section className="mini-metrics" aria-label={t("mini.dayProgress")}>
          <BulletBar kind="useful" label={kindLabels.useful} valueMs={progress.today.useful_ms} threshold={{ minutes: progress.today.useful_goal_min, label: t("mini.goalSuffix") }} />
          <BulletBar kind="waste" label={kindLabels.waste} valueMs={progress.today.waste_ms} threshold={{ minutes: progress.today.waste_limit_min, label: t("mini.limitSuffix") }} />
          <BulletBar kind="neutral" label={kindLabels.neutral} valueMs={progress.today.neutral_ms} />
        </section>
      ) : <div className="mini-loading" aria-label={t("common.loading")} />}

      <section className={`mini-current tone-${currentTone}`} title={privacyNow ? currentCategory ?? t("mini.hiddenApp") : currentApp} aria-label={t("mini.currentContext")}>
        <span>{t("mini.nowLabel")}</span>
        <strong>{currentApp}</strong>
        {currentCategory && !privacyNow && <i className={`kind-${liveSegment?.category_kind ?? "neutral"}`}>{currentCategory}</i>}
      </section>

      <div className="mini-expanded">
        <MiniHourlyChart buckets={hourly} />
        <section className="mini-rank-progress">
          <div>
            <span>{progress?.next_rank && nextRankNeeded !== null
              ? t("mini.rankUntil", { rank: progress.next_rank, xp: nextRankNeeded.toLocaleString(localeForLang(lang)) })
              : t("mini.rankMaximum")}</span>
          </div>
          <span className="mini-rank-rail" aria-hidden="true"><i style={{ width: `${rankProgress}%` }} /></span>
        </section>
      </div>

      {error && <p className="mini-error">{error}</p>}

      <footer className="mini-actions">
        <span className="mini-rank">
          {progress ? `${progress.current_rank} · ${progress.lifetime_xp.toLocaleString(localeForLang(lang))} XP` : "—"}
        </span>
        <button type="button" onClick={(event) => void toggleTracking(event)}>{paused ? t("dashboard.continue") : t("dashboard.pause")}</button>
        <button type="button" onClick={() => void invoke("show_dashboard")}>{t("mini.dashboard")}</button>
        <button
          type="button"
          className={pinned ? "is-pinned" : ""}
          aria-pressed={pinned}
          aria-label={pinned ? t("mini.unpin") : t("mini.pin")}
          title={pinned ? t("mini.unpinTitle") : t("mini.pinTitle")}
          onClick={(event) => void togglePin(event)}
        >
          {pinned ? "●" : "○"}
        </button>
        <button
          type="button"
          className={corner ? "is-pinned" : ""}
          aria-pressed={corner !== null}
          aria-label={t("mini.cornerPin")}
          title={t("mini.cornerPin")}
          onClick={(event) => void toggleCornerPopover(event)}
        >📎</button>
      </footer>
      {settingsOpen && (
        <section className="mini-popover mini-settings-popover" onClick={(event) => event.stopPropagation()}>
          <strong>{t("mini.settings")}</strong>
          <label><span>{t("mini.settingsMode")}</span><select value={mode} onChange={(event) => void changeMode(event.target.value as MiniMode)}>
            <option value="auto">{t("mini.settingsModeAuto")}</option>
            <option value="compact">{t("mini.settingsModeCompact")}</option>
            <option value="detailed">{t("mini.settingsModeDetailed")}</option>
          </select></label>
          <label><span>{t("mini.settingsText")}</span><select value={textSize} onChange={(event) => void changeTextSize(event.target.value as MiniTextSize)}>
            <option value="normal">{t("mini.settingsTextNormal")}</option>
            <option value="large">{t("mini.settingsTextLarge")}</option>
          </select></label>
          <label className="mini-settings-check"><input type="checkbox" checked={privacyNow} onChange={(event) => void changePrivacy(event.target.checked)} /><span>{t("mini.settingsPrivacy")}</span></label>
          <label className="mini-settings-check"><input type="checkbox" checked={showMiniAtLaunch} onChange={(event) => void changeLaunchVisibility(event.target.checked)} /><span>{t("mini.settingsLaunch")}</span></label>
          <button type="button" onClick={() => void resetGeometry()}>{t("mini.settingsReset")}</button>
        </section>
      )}
      {cornerOpen && (
        <section className="mini-popover mini-corner-popover" aria-label={t("mini.cornerChoose")} onClick={(event) => event.stopPropagation()}>
          {(["tl", "tr", "bl", "br"] as const).map((option) => (
            <button type="button" key={option} className={corner === option ? "is-active" : ""} aria-pressed={corner === option} onClick={() => void selectCorner(option)}>{t(`mini.corner.${option}`)}</button>
          ))}
        </section>
      )}
      <span className="mini-resize-grip" aria-hidden="true" />
    </main>
  );
}

function matchesMiniCorner(value: string | undefined): value is MiniCorner {
  return value === "tl" || value === "tr" || value === "bl" || value === "br";
}
