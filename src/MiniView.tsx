import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { TodayScoring } from "./components/ScorePanel";
import { localizedDuration } from "./duration";
import type { ProgressOverview } from "./progress";
import { localeForLang } from "./i18n";
import { useI18n } from "./i18nContext";
import { parseMiniSettings, type MiniMode, type MiniTextSize } from "./miniSettings";
import { formatCompactMinutes } from "./miniVerdict";

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

type MiniCorner = "tl" | "tr" | "bl" | "br";

interface MiniState {
  pinned: boolean;
  corner: MiniCorner | null;
  resizable: boolean;
  position_x: number;
  position_y: number;
}

type BulletBarProps = {
  kind: CategoryKind;
  label: string;
  valueMs: number;
} & ({ threshold: { minutes: number; label: string } } | { threshold?: undefined });

function cleanAppName(app: string): string {
  return app.replace(/\.exe$/i, "");
}

function formatScore(value: number): string {
  const formatted = value.toFixed(1);
  return value > 0 ? `+${formatted}` : formatted;
}

function EllipsizedText({ className, text }: { className?: string; text: string }) {
  const ref = useRef<HTMLSpanElement | null>(null);
  const [truncated, setTruncated] = useState(false);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const update = () => setTruncated(element.scrollWidth > element.clientWidth);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [text]);

  return <span ref={ref} className={className} aria-label={text} title={truncated ? text : undefined}>{text}</span>;
}

function MiniIcon({ name }: { name: "corner" | "pin" | "settings" | "minimize" | "hide" }) {
  if (name === "corner") {
    return <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5.2 8.3 9.7 3.8a2.1 2.1 0 0 1 3 3l-5.9 5.9a3.2 3.2 0 0 1-4.5-4.5l5.4-5.4" /></svg>;
  }
  if (name === "pin") {
    return <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m5 2 6 6-2 .7-1.6 2.5-.7 2.3-1.2-1.2 1.1-3L3 5.7 5 5zM3 13l3-3" /></svg>;
  }
  if (name === "minimize") {
    return <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 11.5h10" /></svg>;
  }
  if (name === "hide") {
    return <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m3.5 3.5 9 9m0-9-9 9" /></svg>;
  }
  return <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6.9 2.2h2.2l.4 1.5 1.2.7 1.5-.5 1.1 1.9-1.1 1.1v1.4l1.1 1.1-1.1 1.9-1.5-.5-1.2.7-.4 1.5H6.9l-.4-1.5-1.2-.7-1.5.5-1.1-1.9 1.1-1.1V6.9L2.7 5.8l1.1-1.9 1.5.5 1.2-.7z" /><circle cx="8" cy="7.6" r="1.7" /></svg>;
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
        <EllipsizedText text={label} />
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

function MiniScoreHero({ scoring }: { scoring: TodayScoring | null }) {
  const { t } = useI18n();
  const tone = !scoring ? "" : scoring.total_score > 0 ? "is-positive" : scoring.total_score < 0 ? "is-negative" : "";

  return (
    <section className="mini-score-hero" aria-label={t("mini.scoreToday")}>
      <span>{t("mini.scoreToday")}</span>
      <div className="mini-score-values">
        <strong className={tone}>{scoring ? formatScore(scoring.total_score) : "0.0"}</strong>
        <small>{t("mini.productive", { value: scoring?.productive_percent.toFixed(1) ?? "0.0" })}</small>
      </div>
    </section>
  );
}

function MiniTopCategories({ scoring }: { scoring: TodayScoring | null }) {
  const { t } = useI18n();
  const categories = scoring?.top_categories.slice(0, 4) ?? [];

  return (
    <section className="mini-top-categories" aria-label={t("mini.topCategories")}>
      <span className="mini-top-heading mini-top-heading-expanded">{t("mini.topFourCategories")}</span>
      {categories.length === 0 ? <span className="mini-score-empty">{t("mini.noData")}</span> : categories.map((category) => (
        <div className="mini-top-category" key={category.category_id} title={category.full_path}>
          <span className="mini-score-dot" style={{ backgroundColor: category.effective_color }} />
          <EllipsizedText text={category.full_path} />
          <strong className={category.points > 0 ? "is-positive" : category.points < 0 ? "is-negative" : ""}>{formatScore(category.points)}</strong>
        </div>
      ))}
    </section>
  );
}

function requiredMiniSize(mode: MiniMode, textSize: MiniTextSize): { width: number; height: number } {
  if (mode === "detailed") return { width: 420, height: 320 };
  if (textSize === "large") return { width: 340, height: 252 };
  return { width: 300, height: 228 };
}

export function MiniView() {
  const { lang, t } = useI18n();
  const defaultKindLabels: Record<CategoryKind, string> = {
    useful: t("mini.defaultUseful"),
    neutral: t("mini.defaultNeutral"),
    waste: t("mini.defaultWaste"),
  };
  const [progress, setProgress] = useState<ProgressOverview | null>(null);
  const [scoring, setScoring] = useState<TodayScoring | null>(null);
  const [liveSegment, setLiveSegment] = useState<LiveSegment | null>(null);
  const [paused, setPaused] = useState(false);
  const [pinned, setPinned] = useState(true);
  const [mode, setMode] = useState<MiniMode>("auto");
  const [textSize, setTextSize] = useState<MiniTextSize>("normal");
  const [privacyNow, setPrivacyNow] = useState(false);
  const [showMiniAtLaunch, setShowMiniAtLaunch] = useState(false);
  const [opacity, setOpacity] = useState(100);
  const [corner, setCorner] = useState<MiniCorner | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [cornerOpen, setCornerOpen] = useState(false);
  const [kindLabels, setKindLabels] = useState(defaultKindLabels);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const settingsButtonRef = useRef<HTMLButtonElement | null>(null);
  const settingsPopoverRef = useRef<HTMLElement | null>(null);
  const cornerButtonRef = useRef<HTMLButtonElement | null>(null);
  const cornerPopoverRef = useRef<HTMLElement | null>(null);
  const modeRef = useRef<MiniMode>(mode);
  const textSizeRef = useRef<MiniTextSize>(textSize);
  modeRef.current = mode;
  textSizeRef.current = textSize;

  const applyMiniState = useCallback((state: MiniState) => {
    setPinned(state.pinned);
    setCorner(matchesMiniCorner(state.corner) && !state.resizable ? state.corner : null);
  }, []);

  const syncMiniState = useCallback(async () => {
    const state = await invoke<MiniState>("get_mini_state");
    applyMiniState(state);
  }, [applyMiniState]);

  const loadMini = useCallback(async () => {
    try {
      const [nextProgress, nextScoring, nextLiveSegment, trackingPaused, settings, miniState] = await Promise.all([
        invoke<ProgressOverview>("get_progress_overview"),
        invoke<TodayScoring>("get_today_scoring"),
        invoke<LiveSegment | null>("get_live_segment"),
        invoke<boolean>("get_tracking_paused"),
        invoke<Record<string, string>>("get_settings"),
        invoke<MiniState>("get_mini_state"),
      ]);
      setProgress(nextProgress);
      setScoring(nextScoring);
      setLiveSegment(nextLiveSegment);
      setPaused(trackingPaused);
      applyMiniState(miniState);
      const miniSettings = parseMiniSettings(settings);
      setMode(miniSettings.mode);
      setTextSize(miniSettings.textSize);
      setPrivacyNow(miniSettings.privacyNow);
      setShowMiniAtLaunch(miniSettings.showAtLaunch);
      setOpacity(miniSettings.opacity);
      setKindLabels({
        useful: settings.kind_label_useful ?? defaultKindLabels.useful,
        neutral: settings.kind_label_neutral ?? defaultKindLabels.neutral,
        waste: settings.kind_label_waste ?? defaultKindLabels.waste,
      });
      document.documentElement.dataset.theme = settings.theme === "dark" ? "dark" : "";
      setError(null);
    } catch (reason: unknown) {
      setLiveSegment(null);
      setError(typeof reason === "string" ? reason : t("error.miniRefresh"));
    } finally {
      setLoaded(true);
    }
  }, [applyMiniState, t]);

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
      const required = requiredMiniSize(modeRef.current, textSizeRef.current);
      void invoke("resize_mini", required);
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
    };
  }, [loadMini]);

  useEffect(() => {
    const required = requiredMiniSize(mode, textSize);
    void invoke("resize_mini", required);
  }, [mode, textSize]);

  useEffect(() => {
    if (!settingsOpen && !cornerOpen) return;
    const closeOutsidePopovers = (event: PointerEvent) => {
      if (!(event.target instanceof Node)) return;
      if (settingsOpen && !settingsPopoverRef.current?.contains(event.target) && !settingsButtonRef.current?.contains(event.target)) setSettingsOpen(false);
      if (cornerOpen && !cornerPopoverRef.current?.contains(event.target) && !cornerButtonRef.current?.contains(event.target)) setCornerOpen(false);
    };
    const closePopoversOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setSettingsOpen(false);
        setCornerOpen(false);
      }
    };
    window.addEventListener("pointerdown", closeOutsidePopovers);
    window.addEventListener("keydown", closePopoversOnEscape);
    return () => {
      window.removeEventListener("pointerdown", closeOutsidePopovers);
      window.removeEventListener("keydown", closePopoversOnEscape);
    };
  }, [settingsOpen, cornerOpen]);

  async function togglePin(event: React.MouseEvent<HTMLButtonElement>) {
    event.stopPropagation();
    const previous = pinned;
    let changed = false;
    try {
      await invoke("set_mini_pinned", { pinned: !pinned });
      changed = true;
      await syncMiniState();
      setError(null);
    } catch (reason: unknown) {
      if (changed) {
        try {
          await invoke("set_mini_pinned", { pinned: previous });
          await syncMiniState();
        } catch {
          setPinned(previous);
        }
      }
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
    try {
      const required = requiredMiniSize(nextMode, textSize);
      await invoke("resize_mini", required);
      await saveSetting("mini_mode", nextMode);
      setMode(nextMode);
    } catch {
      setMode(previous);
    }
  }

  async function changeTextSize(nextSize: MiniTextSize) {
    const previous = textSize;
    try {
      const required = requiredMiniSize(mode, nextSize);
      await invoke("resize_mini", required);
      await saveSetting("mini_text_size", nextSize);
      setTextSize(nextSize);
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

  async function changeOpacity(nextOpacity: number) {
    const previous = opacity;
    setOpacity(nextOpacity);
    try {
      await saveSetting("mini_opacity", String(nextOpacity));
    } catch {
      setOpacity(previous);
    }
  }

  async function resetGeometry() {
    try {
      await invoke("reset_mini_geometry");
      const required = requiredMiniSize(mode, textSize);
      await invoke("resize_mini", required);
      await syncMiniState();
      setSettingsOpen(false);
      setError(null);
    } catch (reason: unknown) {
      setError(typeof reason === "string" ? reason : t("error.saveSettings"));
    }
  }

  async function selectCorner(nextCorner: MiniCorner) {
    const previous = corner;
    let changed = false;
    try {
      await invoke("pin_mini_corner", { corner: nextCorner });
      changed = true;
      await syncMiniState();
      setCornerOpen(false);
      setError(null);
    } catch (reason: unknown) {
      if (changed) {
        try {
          await invoke("pin_mini_corner", { corner: nextCorner });
          await syncMiniState();
        } catch {
          setCorner(previous);
        }
      }
      setCornerOpen(true);
      setError(typeof reason === "string" ? reason : t("error.miniPin"));
    }
  }

  async function toggleCornerPopover(event: React.MouseEvent<HTMLButtonElement>) {
    event.stopPropagation();
    setSettingsOpen(false);
    if (corner) await selectCorner(corner);
    else setCornerOpen((open) => !open);
  }

  const away = liveSegment?.status === "away";
  const trackingTone = paused ? "off" : away ? "away" : "live";
  const trackingLabel = trackingTone === "live" ? t("mini.trackingLive") : trackingTone === "away" ? t("mini.trackingAway") : t("mini.trackingOff");
  const actualCurrentApp = paused
    ? t("mini.trackingOff")
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
  const currentTone = paused ? "muted" : away ? "warning" : !loaded || !liveSegment ? "muted" : liveSegment.is_uncategorized ? "muted" : liveSegment.category_kind;
  const currentApp = privacyNow && !paused && loaded && !away ? currentCategory ?? t("mini.hiddenApp") : actualCurrentApp;
  const accountedText = t("mini.accountedToday", { duration: localizedDuration(progress?.today.observed_ms ?? 0, t) });
  const rankText = progress
    ? t("mini.rank", { rank: progress.current_rank, xp: progress.lifetime_xp.toLocaleString(localeForLang(lang)) })
    : t("mini.rank", { rank: "—", xp: "0" });

  return (
    <main className={`mini-shell mini-mode-${mode}${textSize === "large" ? " mini-text-large" : ""}${corner ? " is-corner-pinned" : ""}`}>
      <header
        className="mini-drag-strip"
        onMouseDown={(event) => {
          event.stopPropagation();
          if (event.button === 0 && !corner) void invoke("start_mini_drag");
        }}
      >
        <div className="mini-header-status">
          <span className={`mini-pulse is-${trackingTone}`} role="img" aria-label={trackingLabel} title={trackingLabel} />
          <span className="mini-brand">TTLI</span>
        </div>
        <div className="mini-header-controls">
          <button
            ref={cornerButtonRef}
            type="button"
            className={`mini-icon-button${corner ? " is-active" : ""}`}
            aria-pressed={corner !== null}
            aria-label={corner ? t("mini.cornerUnlock") : t("mini.cornerPin")}
            title={corner ? t("mini.cornerUnlock") : t("mini.cornerPin")}
            onPointerDown={(event) => event.stopPropagation()}
            onMouseDown={(event) => event.stopPropagation()}
            onClick={(event) => void toggleCornerPopover(event)}
          >{corner ? t(`mini.corner.${corner}`) : <MiniIcon name="corner" />}</button>
          <button
            type="button"
            className={`mini-icon-button${pinned ? " is-active" : ""}`}
            aria-pressed={pinned}
            aria-label={pinned ? t("mini.unpin") : t("mini.pin")}
            title={pinned ? t("mini.unpin") : t("mini.pin")}
            onPointerDown={(event) => event.stopPropagation()}
            onMouseDown={(event) => event.stopPropagation()}
            onClick={(event) => void togglePin(event)}
          ><MiniIcon name="pin" /></button>
          <button
            ref={settingsButtonRef}
            type="button"
            className="mini-icon-button"
            aria-label={t("mini.settings")}
            title={t("mini.settings")}
            aria-expanded={settingsOpen}
            onPointerDown={(event) => event.stopPropagation()}
            onMouseDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              setCornerOpen(false);
              setSettingsOpen((open) => !open);
            }}
          ><MiniIcon name="settings" /></button>
          <button
            type="button"
            className="mini-icon-button"
            aria-label={t("mini.minimize")}
            title={t("mini.minimize")}
            onPointerDown={(event) => event.stopPropagation()}
            onMouseDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              void invoke("minimize_mini");
            }}
          ><MiniIcon name="minimize" /></button>
          <button
            type="button"
            className="mini-icon-button"
            aria-label={t("mini.hideToTray")}
            title={t("mini.hideToTray")}
            onPointerDown={(event) => event.stopPropagation()}
            onMouseDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              void invoke("hide_mini");
            }}
          ><MiniIcon name="hide" /></button>
        </div>
      </header>

      <section className="mini-body">
        <MiniScoreHero scoring={scoring} />
        <MiniTopCategories scoring={scoring} />

        {progress ? (
          <section className="mini-metrics" aria-label={t("mini.dayProgress")}>
            <BulletBar kind="useful" label={kindLabels.useful} valueMs={progress.today.useful_ms} threshold={{ minutes: progress.today.useful_goal_min, label: t("mini.goalSuffix") }} />
            <BulletBar kind="waste" label={kindLabels.waste} valueMs={progress.today.waste_ms} threshold={{ minutes: progress.today.waste_limit_min, label: t("mini.limitSuffix") }} />
            <BulletBar kind="neutral" label={kindLabels.neutral} valueMs={progress.today.neutral_ms} />
          </section>
        ) : <div className="mini-loading" aria-label={t("common.loading")} />}

        <section className={`mini-current tone-${currentTone}`} aria-label={t("mini.currentContext")}>
          <span className="mini-now-label">{t("mini.nowLabel")}</span>
          <EllipsizedText className="mini-current-app" text={currentApp} />
          {privacyNow && <span className="mini-privacy-badge">{t("mini.nowHiddenBadge")}</span>}
          {currentCategory && !privacyNow && <EllipsizedText className={`mini-category-badge kind-${liveSegment?.category_kind ?? "neutral"}`} text={currentCategory} />}
        </section>
      </section>

      {error && <p className="mini-error">{error}</p>}

      <footer className="mini-actions">
        <div className="mini-footer-stats">
          <EllipsizedText className="mini-accounted" text={accountedText} />
          <EllipsizedText className="mini-rank" text={rankText} />
        </div>
        <div className="mini-footer-buttons">
          <button type="button" onClick={() => void invoke("show_dashboard")}>{t("mini.dashboard")}</button>
        </div>
      </footer>

      {settingsOpen && (
        <section ref={settingsPopoverRef} className="mini-popover mini-settings-popover" onPointerDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()}>
          <strong className="mini-popover-title">{t("mini.settings")}</strong>
          <div className="mini-settings-content">
            <label><span>{t("mini.settingsMode")}</span><select value={mode} onChange={(event) => void changeMode(event.target.value as MiniMode)}>
              <option value="auto">{t("mini.settingsModeAuto")}</option>
              <option value="compact">{t("mini.settingsModeCompact")}</option>
              <option value="detailed">{t("mini.settingsModeDetailed")}</option>
            </select></label>
            <label><span>{t("mini.settingsText")}</span><select value={textSize} onChange={(event) => void changeTextSize(event.target.value as MiniTextSize)}>
              <option value="normal">{t("mini.settingsTextNormal")}</option>
              <option value="large">{t("mini.settingsTextLargeGrows")}</option>
            </select></label>
            <label className="mini-settings-check"><input type="checkbox" checked={privacyNow} onChange={(event) => void changePrivacy(event.target.checked)} /><span>{t("mini.settingsPrivacy")}</span></label>
            <label className="mini-settings-check"><input type="checkbox" checked={showMiniAtLaunch || corner !== null} disabled={corner !== null} onChange={(event) => void changeLaunchVisibility(event.target.checked)} /><span>{corner ? t("mini.settingsLaunchCorner") : t("mini.settingsLaunch")}</span></label>
            <label className="mini-settings-opacity"><span>{t("mini.settingsOpacity")}</span><output>{opacity}%</output><input type="range" min="60" max="100" step="5" value={opacity} onChange={(event) => void changeOpacity(Number(event.target.value))} /></label>
            <div className="mini-settings-window-actions">
              <button type="button" onClick={() => void invoke("minimize_mini")}>{t("mini.minimize")}</button>
              <button type="button" onClick={() => void invoke("hide_mini")}>{t("mini.hideToTray")}</button>
            </div>
          </div>
          <button className="mini-settings-reset" type="button" onClick={() => void resetGeometry()}>{t("mini.settingsReset")}</button>
        </section>
      )}
      {cornerOpen && (
        <section ref={cornerPopoverRef} className="mini-popover mini-corner-popover" aria-label={t("mini.cornerChoose")} onPointerDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()}>
          {(["tl", "tr", "bl", "br"] as const).map((option) => (
            <button type="button" key={option} className={corner === option ? "is-active" : ""} aria-pressed={corner === option} aria-label={t(`mini.cornerName.${option}`)} onClick={() => void selectCorner(option)}>{t(`mini.corner.${option}`)}</button>
          ))}
        </section>
      )}
      <span className="mini-resize-grip" aria-hidden="true" />
    </main>
  );
}

function matchesMiniCorner(value: string | null | undefined): value is MiniCorner {
  return value === "tl" || value === "tr" || value === "bl" || value === "br";
}
