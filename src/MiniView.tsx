import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { TodayScoring } from "./components/ScorePanel";
import { CategoryMark } from "./components/CategoryIcon";
import { localizedDuration } from "./duration";
import type { ProgressOverview } from "./progress";
import { localeForLang } from "./i18n";
import { useI18n } from "./i18nContext";
import { parseMiniSettings, applyMiniPreset, defaultMiniLayout, serializeMiniLayout, MINI_BLOCK_IDS, type MiniBlockId, type MiniBlockCfg, type MiniLayout, type MiniMode, type MiniTextSize } from "./miniSettings";
import { getMiniVerdict } from "./miniVerdict";
import { MiniActivityChart } from "./components/MiniActivityChart";
import type { TodayCumulative } from "./components/CumulativeChart";

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

// В спрятанном виде (tuck) таб торчит из выбранного угла экрана, но это
// ПРОТИВОПОЛОЖНЫЙ угол самого окна (окно сдвигается так, что его дальний
// угол остаётся в экранном угле). Ручку рисуем именно там.
const TUCK_DIAGONAL: Record<MiniCorner, MiniCorner> = { tl: "br", tr: "bl", bl: "tr", br: "tl" };

interface MiniState {
  pinned: boolean;
  corner: MiniCorner | null;
  resizable: boolean;
  position_x: number;
  position_y: number;
}

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

function MiniIcon({ name }: { name: "corner" | "pin" | "settings" | "hide" | "click" | "chevron" | "dashboard" }) {
  if (name === "corner") {
    return <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5.2 8.3 9.7 3.8a2.1 2.1 0 0 1 3 3l-5.9 5.9a3.2 3.2 0 0 1-4.5-4.5l5.4-5.4" /></svg>;
  }
  if (name === "pin") {
    return <svg viewBox="0 0 16 16" aria-hidden="true"><rect className="mini-icon-win-back" x="2.5" y="3.5" width="8.5" height="8.5" rx="1.2" fill="none" stroke="currentColor" strokeWidth="1.3" /><rect className="mini-icon-win-front" x="5.5" y="5.5" width="8.5" height="8.5" rx="1.2" fill="none" stroke="currentColor" strokeWidth="1.3" /></svg>;
  }
  if (name === "click") {
    return <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.9 2.7 12 7 7.7 8.2 6 12.5z" /></svg>;
  }
  if (name === "chevron") {
    return <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m3.5 6 4.5 4 4.5-4" /></svg>;
  }
  if (name === "hide") {
    return <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m3.5 3.5 9 9m0-9-9 9" /></svg>;
  }
  if (name === "dashboard") {
    return <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.8 7.6 8 3l5.2 4.6M4 6.4v6.6h8V6.4M6.4 13V9.6h3.2V13" /></svg>;
  }
  return <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6.9 2.2h2.2l.4 1.5 1.2.7 1.5-.5 1.1 1.9-1.1 1.1v1.4l1.1 1.1-1.1 1.9-1.5-.5-1.2.7-.4 1.5H6.9l-.4-1.5-1.2-.7-1.5.5-1.1-1.9 1.1-1.1V6.9L2.7 5.8l1.1-1.9 1.5.5 1.2-.7z" /><circle cx="8" cy="7.6" r="1.7" /></svg>;
}

function MiniScoreHero({ scoring }: { scoring: TodayScoring | null }) {
  const { t } = useI18n();
  const tone = !scoring ? "" : scoring.total_score > 0 ? "is-positive" : scoring.total_score < 0 ? "is-negative" : "";

  return (
    <section className="mini-score-hero" aria-label={t("mini.scoreToday")}>
      <span>{t("mini.scoreToday")}</span>
      <div className="mini-score-values">
        <strong className={tone}>{scoring ? formatScore(scoring.total_score) : "0.0"}</strong>
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
          <CategoryMark icon={category.icon} color={category.effective_color} compact />
          <EllipsizedText text={category.full_path} />
          <strong className={category.points > 0 ? "is-positive" : category.points < 0 ? "is-negative" : ""}>{formatScore(category.points)}</strong>
        </div>
      ))}
    </section>
  );
}

function requiredMiniSize(mode: MiniMode, textSize: MiniTextSize): { width: number; height: number } {
  if (mode === "detailed") return { width: 390, height: 280 };
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
  const [clickThrough, setClickThrough] = useState(false);
  const [cornerTuck, setCornerTuck] = useState(false);
  const [tucked, setTucked] = useState(false);
  const [layout, setLayout] = useState<MiniLayout>(defaultMiniLayout);
  const [editingLayout, setEditingLayout] = useState(false);
  const [dayCumulative, setDayCumulative] = useState<TodayCumulative | null>(null);
  const [browOpen, setBrowOpen] = useState(false);
  const browTimerRef = useRef<number | null>(null);
  // «бровь»: панель управления выезжает по hover'у, чтобы не занимать место и не мешать ресайзу окна.
  const openBrow = () => {
    if (browTimerRef.current !== null) window.clearTimeout(browTimerRef.current);
    setBrowOpen(true);
  };
  const scheduleCloseBrow = () => {
    if (browTimerRef.current !== null) window.clearTimeout(browTimerRef.current);
    browTimerRef.current = window.setTimeout(() => setBrowOpen(false), 280);
  };
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [cornerOpen, setCornerOpen] = useState(false);
  const [kindLabels, setKindLabels] = useState(defaultKindLabels);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const settingsButtonRef = useRef<HTMLButtonElement | null>(null);
  const settingsPopoverRef = useRef<HTMLElement | null>(null);
  const cornerButtonRef = useRef<HTMLButtonElement | null>(null);
  const cornerPopoverRef = useRef<HTMLElement | null>(null);
  const tuckTimerRef = useRef<number | null>(null);
  // живой редактор layout: drag-перестановка блоков потока
  const flowRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ id: MiniBlockId; last: number | null; moved: boolean } | null>(null);
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
      setClickThrough(miniSettings.clickThrough);
      setCornerTuck(miniSettings.cornerTuck);
      setLayout(miniSettings.layout);
      if (miniSettings.layout.blocks.some((block) => block.id === "chart" && block.enabled)) {
        void invoke<TodayCumulative>("get_today_cumulative").then(setDayCumulative).catch(() => undefined);
      }
      setKindLabels({
        useful: settings.kind_label_useful ?? defaultKindLabels.useful,
        neutral: settings.kind_label_neutral ?? defaultKindLabels.neutral,
        waste: settings.kind_label_waste ?? defaultKindLabels.waste,
      });
      // режим «Компактно» на старте: точный размер + переменная геометрия.
      // Ресайз НЕ глушим: юзер должен всегда мочь растянуть/сжать виджет мышью
      // (иначе «куда пропал ресайз»). Адаптив сам перестроит строки под любой размер.
      // Отдельно чиним застрявший resizable=false из прошлых версий (не в corner-lock).
      if (miniSettings.mode === "compact") {
        const required = requiredMiniSize("compact", miniSettings.textSize);
        void invoke("resize_mini", { width: required.width, height: required.height, force: true });
        if (matchesMiniCorner(miniState.corner) === false) {
          void invoke("set_mini_resizable", { resizable: true });
        }
      }
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
      if (tuckTimerRef.current !== null) window.clearTimeout(tuckTimerRef.current);
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

  // Частичный click-through: верхняя «шапка» окна остаётся кликабельной даже при
  // «кликах сквозь». Кликабельную полосу расширяем под открытые панели (бровь/настройки).
  useEffect(() => {
    if (!clickThrough) return;
    const height = settingsOpen ? 320 : browOpen ? 110 : 72;
    void invoke("set_mini_hit_band", { height });
  }, [clickThrough, settingsOpen, browOpen]);

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
      await invoke("resize_mini", { width: required.width, height: required.height, force: nextMode === "compact" });
      // ресайз не глушим в «Компактно» — юзер всегда может тянуть края
      if (!corner) await invoke("set_mini_resizable", { resizable: true });
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

  async function changeClickThrough(next: boolean) {
    const previous = clickThrough;
    setClickThrough(next);
    try {
      await saveSetting("mini_click_through", next ? "1" : "0");
      // при включении окно перестаёт ловить клики — попап закроем сами через 3 сек
      if (next) window.setTimeout(() => setSettingsOpen(false), 3000);
    } catch {
      setClickThrough(previous);
    }
  }

  async function changeCornerTuck(next: boolean) {
    const previous = cornerTuck;
    setCornerTuck(next);
    try {
      await saveSetting("mini_corner_tuck", next ? "1" : "0");
    } catch {
      setCornerTuck(previous);
    }
  }

  const saveLayout = useCallback((next: MiniLayout) => {
    setLayout(next);
    void invoke("set_setting", { key: "mini_layout", value: serializeMiniLayout(next) });
    if (next.blocks.some((block) => block.id === "chart" && block.enabled)) {
      void invoke<TodayCumulative>("get_today_cumulative").then(setDayCumulative).catch(() => undefined);
    }
  }, []);

  const toggleBlockEnabled = useCallback((id: MiniBlockId) => {
    saveLayout({
      ...layout,
      blocks: layout.blocks.map((block) => (block.id === id ? { ...block, enabled: !block.enabled } : block)),
    });
  }, [layout, saveLayout]);

  const toggleBlockSize = useCallback((id: MiniBlockId) => {
    saveLayout({
      ...layout,
      blocks: layout.blocks.map((block) => (block.id === id ? { ...block, size: block.size === 1 ? 2 : 1 } : block)),
    });
  }, [layout, saveLayout]);

  // --- живой canvas-редактор: drag-перестановка блоков потока внутри реального виджета ---
  const computeFlowIndex = useCallback((clientY: number): number => {
    const container = flowRef.current;
    if (!container) return -1;
    const dragId = dragRef.current?.id;
    const blocks = Array.from(container.querySelectorAll<HTMLElement>("[data-mini-id]"));
    const target = blocks.find(
      (block) => block.dataset.miniId !== dragId && clientY < block.getBoundingClientRect().top + block.getBoundingClientRect().height / 2,
    );
    if (!target) return blocks.length - (dragId ? 1 : 0);
    return blocks.indexOf(target);
  }, []);

  const reorderFlow = useCallback((movingId: MiniBlockId, flowIndex: number) => {
    const visibleFlow = layout.blocks.filter(
      (block) => block.enabled && block.id !== "categories" && block.id !== "score",
    );
    const moving = visibleFlow.find((block) => block.id === movingId);
    if (!moving || flowIndex < 0 || flowIndex >= visibleFlow.length) return;
    const rest = visibleFlow.filter((block) => block.id !== movingId);
    rest.splice(flowIndex, 0, moving);
    const pair = layout.blocks.filter((block) => block.id === "categories" || block.id === "score");
    const disabledFlow = layout.blocks.filter(
      (block) => !block.enabled && block.id !== "categories" && block.id !== "score",
    );
    saveLayout({ ...layout, blocks: [...pair, ...rest, ...disabledFlow] });
  }, [layout, saveLayout]);

  const onWindowDragMove = useCallback((event: PointerEvent) => {
    const drag = dragRef.current;
    if (!drag) return;
    drag.moved = true;
    const index = computeFlowIndex(event.clientY);
    if (index >= 0 && index !== drag.last) {
      drag.last = index;
      reorderFlow(drag.id, index);
    }
  }, [computeFlowIndex, reorderFlow]);

  const endBlockDrag = useCallback(() => {
    window.removeEventListener("pointermove", onWindowDragMove);
    window.removeEventListener("pointerup", endBlockDrag);
    dragRef.current = null;
  }, [onWindowDragMove]);

  const beginBlockDrag = useCallback((id: MiniBlockId) => {
    if (dragRef.current !== null) endBlockDrag();
    dragRef.current = { id, last: null, moved: false };
    window.addEventListener("pointermove", onWindowDragMove);
    window.addEventListener("pointerup", endBlockDrag);
  }, [endBlockDrag, onWindowDragMove]);

  const startEditingLayout = useCallback(() => {
    setSettingsOpen(false);
    if (clickThrough) void changeClickThrough(false);
    setEditingLayout(true);
  }, [clickThrough]);

  const finishEditingLayout = useCallback(() => setEditingLayout(false), []);

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
    // Всегда открываем меню выбора угла (даже если угол уже запинен).
    // Распин — повторный клик по активной кнопке угла внутри меню.
    setCornerOpen((open) => !open);
  }

  const away = liveSegment?.status === "away";
  const trackingTone = paused ? "off" : away ? "away" : "live";
  const trackingLabel = trackingTone === "live" ? t("mini.trackingLive") : trackingTone === "away" ? t("mini.trackingAway") : t("mini.trackingOff");
  // tuck: наведение выезжает окно, увод мыши прячет обратно (800 мс)
  const scheduleTuck = () => {
    if (!cornerTuck || !corner || clickThrough || settingsOpen || cornerOpen) return;
    if (tuckTimerRef.current !== null) window.clearTimeout(tuckTimerRef.current);
    tuckTimerRef.current = window.setTimeout(() => {
      void invoke("tuck_mini_position", { tucked: true });
      setTucked(true);
    }, 800);
  };
  const revealTuck = () => {
    if (tuckTimerRef.current !== null) {
      window.clearTimeout(tuckTimerRef.current);
      tuckTimerRef.current = null;
    }
    if (cornerTuck && corner && !clickThrough) {
      void invoke("tuck_mini_position", { tucked: false });
      setTucked(false);
    }
  };
  // «потянуть за ухо»: клик по табу в углу вытягивает виджет и отключает авто-прятание
  const untuckWidget = () => {
    setCornerTuck(false);
    setTucked(false);
    void invoke("set_mini_tuck", { tucked: false }).catch(() => undefined);
  };
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
  const verdict = progress
    ? getMiniVerdict({
        usefulMs: progress.today.useful_ms,
        wasteMs: progress.today.waste_ms,
        observedMs: progress.today.observed_ms,
        usefulGoalMin: progress.today.useful_goal_min,
        wasteLimitMin: progress.today.waste_limit_min,
        observedMin: progress.today.observed_min,
        usefulLabel: kindLabels.useful,
        wasteLabel: kindLabels.waste,
      })
    : null;

  // Живой рендер тела: в режиме редактирования те же реальные блоки, но каждый —
  // кликабельная плитка (drag переставить / скрыть / ресайз). Видно, что меняешь.
  const renderBody = (editing: boolean) => {
    const enabled = layout.blocks.filter((block) => block.enabled);
    const pairIds = ["categories", "score"] as const;
    const pair = pairIds
      .map((id) => enabled.find((block) => block.id === id))
      .filter((block): block is MiniBlockCfg => block !== undefined);
    const flow = enabled.filter((block) => block.id !== "categories" && block.id !== "score");
    const renderBlock = (id: MiniBlockId) => {
      if (id === "score") return <MiniScoreHero scoring={scoring} />;
      if (id === "categories") return <MiniTopCategories scoring={scoring} />;
      if (id === "verdict") {
        if (!progress || !verdict) return <div className="mini-loading" aria-label={t("common.loading")} />;
        const goalMs = progress.today.useful_goal_min * 60_000;
        return (
          <section className="mini-verdict" aria-label={t("mini.dayProgress")}>
            <EllipsizedText text={t(verdict.key, verdict.vars)} />
            {goalMs > 0 && (
              <div className="mini-goal" title={t("mini.goalTooltip", { goal: localizedDuration(goalMs, t) })}>
                <div className="mini-goal-rail"><i style={{ width: `${Math.min((progress.today.useful_ms / goalMs) * 100, 100)}%` }} /></div>
                <span className="mini-goal-copy">{t("mini.goalProgress", { useful: localizedDuration(progress.today.useful_ms, t), goal: localizedDuration(goalMs, t) })}</span>
              </div>
            )}
          </section>
        );
      }
      if (id === "current") {
        return (
          <section className={`mini-current tone-${currentTone}`} aria-label={t("mini.currentContext")}>
            <span className="mini-now-label">{t("mini.nowLabel")}</span>
            <EllipsizedText className="mini-current-app" text={currentApp} />
            {privacyNow && <button type="button" className="mini-privacy-badge" title={t("mini.privacyBadgeHint")} onClick={() => void changePrivacy(false)}>{t("mini.nowHiddenBadge")}</button>}
            {currentCategory && !privacyNow && <EllipsizedText className={`mini-category-badge kind-${liveSegment?.category_kind ?? "neutral"}`} text={currentCategory} />}
          </section>
        );
      }
      return <MiniActivityChart data={dayCumulative} />;
    };
    const chrome = (id: MiniBlockId, pinned: boolean) => {
      if (!editing) return null;
      return (
        <div className="mini-block-edit">
          {pinned
            ? <span className="mini-edit-pinned" title={t("mini.blockPinned")}>{t("mini.blockPinnedMark")}</span>
            : (
              <button
                type="button"
                className="mini-edit-drag"
                aria-label={t("mini.dragBlock")}
                title={t("mini.dragBlock")}
                onPointerDown={(event) => {
                  event.stopPropagation();
                  event.preventDefault();
                  beginBlockDrag(id);
                }}
              >⠿</button>
            )}
          <button type="button" className="mini-edit-hide" aria-label={t("mini.hideBlock")} title={t("mini.hideBlock")} onClick={(event) => { event.stopPropagation(); toggleBlockEnabled(id); }}>✕</button>
          <button type="button" className={`mini-edit-size${layout.blocks.find((b) => b.id === id)?.size === 2 ? " is-wide" : ""}`} aria-label={t("mini.sizeWide")} title={t("mini.sizeWide")} onClick={(event) => { event.stopPropagation(); toggleBlockSize(id); }}>▭</button>
        </div>
      );
    };
    return (
      <>
        {pair.length > 0 && (
          <div className="mini-pair">
            {pair.map((block) => (
              <div key={block.id} data-mini-id={block.id} className={`mini-block block-${block.id}${editing ? " is-editing" : ""}`}>
                {renderBlock(block.id)}
                {chrome(block.id, true)}
              </div>
            ))}
          </div>
        )}
        {flow.length > 0 && (
          <div ref={flowRef} className="mini-flow">
            {flow.map((block) => (
              <div key={block.id} data-mini-id={block.id} className={`mini-block block-${block.id}${editing ? " is-editing" : ""}${block.id === "chart" ? " mini-block--chart" : ""}`}>
                {renderBlock(block.id)}
                {chrome(block.id, false)}
              </div>
            ))}
          </div>
        )}
      </>
    );
  };

  return (
    <main
      className={`mini-shell mini-mode-${mode}${textSize === "large" ? " mini-text-large" : ""}${corner ? " is-corner-pinned" : ""}`}
      onMouseEnter={revealTuck}
      onMouseLeave={scheduleTuck}
    >
      <header
        className="mini-drag-strip"
        onMouseDown={(event) => {
          event.stopPropagation();
          if (event.button === 0 && !corner) void invoke("start_mini_drag");
        }}
        onMouseLeave={scheduleCloseBrow}
      >
        <div className="mini-header-status">
          <span className={`mini-pulse is-${trackingTone}`} role="img" aria-label={trackingLabel} title={trackingLabel} />
          <span className="mini-brand">TTLI</span>
          {clickThrough && <span className="mini-privacy-badge mini-click-through-badge" title={t("mini.clickThroughHint")}>{t("mini.clickThroughBadge")}</span>}
        </div>
        <button
          type="button"
          className="mini-brow-handle"
          aria-label={t("mini.browReveal")}
          title={t("mini.browReveal")}
          onMouseEnter={openBrow}
          onMouseLeave={scheduleCloseBrow}
          onClick={(event) => event.stopPropagation()}
        ><MiniIcon name="chevron" /></button>
      </header>

      {browOpen && (
        <nav
          className="mini-brow-panel"
          onMouseEnter={openBrow}
          onMouseLeave={scheduleCloseBrow}
          aria-label={t("mini.browActions")}
        >
          <button
            type="button"
            className="mini-icon-button"
            aria-label={t("mini.dashboard")}
            title={t("mini.dashboard")}
            onPointerDown={(event) => event.stopPropagation()}
            onMouseDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              setBrowOpen(false);
              void invoke("show_dashboard");
            }}
          ><MiniIcon name="dashboard" /></button>
          <button
            ref={cornerButtonRef}
            type="button"
            className={`mini-icon-button${corner ? " is-active" : ""}`}
            aria-pressed={corner !== null}
            aria-label={corner ? t("mini.cornerUnlock") : t("mini.cornerPin")}
            title={corner ? t("mini.cornerUnlock") : t("mini.cornerPin")}
            onPointerDown={(event) => event.stopPropagation()}
            onMouseDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              setBrowOpen(false);
              void toggleCornerPopover(event);
            }}
          >{corner ? t(`mini.corner.${corner}`) : <MiniIcon name="corner" />}</button>
          <button
            type="button"
            className="mini-icon-button"
            aria-label={t("mini.hideToTray")}
            title={t("mini.hideToTray")}
            onPointerDown={(event) => event.stopPropagation()}
            onMouseDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              setBrowOpen(false);
              void invoke("hide_mini");
            }}
          ><MiniIcon name="hide" /></button>
          <span className="mini-brow-sep" aria-hidden="true" />
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
            type="button"
            className={`mini-icon-button${clickThrough ? " is-active" : ""}`}
            aria-pressed={clickThrough}
            aria-label={t("mini.clickThrough")}
            title={t("mini.clickThroughHint")}
            onPointerDown={(event) => event.stopPropagation()}
            onMouseDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              setBrowOpen(false);
              void changeClickThrough(!clickThrough);
            }}
          ><MiniIcon name="click" /></button>
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
        </nav>
      )}

      <section className={`mini-body is-layout${editingLayout ? " is-edit-layout" : ""}`}>
        {editingLayout ? (
          <div className="mini-layout-editor live" role="group" aria-label={t("mini.layoutTitle")}>
            <div className="mini-layout-editor-head">
              <strong>{t("mini.layoutTitle")}</strong>
              <div className="mini-layout-edit-actions">
                <button type="button" onClick={() => saveLayout(applyMiniPreset(layout, "compact"))}>{t("mini.presetCompact")}</button>
                <button type="button" onClick={() => saveLayout(applyMiniPreset(layout, "detailed"))}>{t("mini.presetDetailed")}</button>
                <button type="button" className="is-reset" onClick={() => saveLayout(defaultMiniLayout())}>{t("mini.layoutReset")}</button>
              </div>
            </div>
            <p className="mini-layout-canvas-hint">{t("mini.layoutCanvasHint")}</p>
            {renderBody(true)}
            {(() => {
              const hidden = MINI_BLOCK_IDS.filter((id) => !(layout.blocks.find((b) => b.id === id)?.enabled));
              return hidden.length > 0 ? (
                <div className="mini-hidden-strip" role="group" aria-label={t("mini.hiddenBlocks")}>
                  {hidden.map((id) => (
                    <button key={id} type="button" onClick={() => toggleBlockEnabled(id)}>+ {t(`mini.block.${id}`)}</button>
                  ))}
                </div>
              ) : null;
            })()}
            <div className="mini-layout-editor-foot">
              <button type="button" className="mini-layout-done" onClick={finishEditingLayout}>{t("mini.layoutDone")}</button>
            </div>
          </div>
        ) : (
          renderBody(false)
        )}
      </section>

      {error && <p className="mini-error">{error}</p>}

      <footer className="mini-actions">
        <div className="mini-footer-stats">
          <EllipsizedText className="mini-productive" text={t("mini.productive", { value: scoring?.productive_percent.toFixed(1) ?? "0.0" })} />
          <EllipsizedText className="mini-accounted" text={accountedText} />
          <EllipsizedText className="mini-rank" text={rankText} />
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
            <label className="mini-settings-check" title={t("mini.clickThroughHint")}><input type="checkbox" checked={clickThrough} onChange={(event) => void changeClickThrough(event.target.checked)} /><span>{t("mini.clickThrough")}</span></label>
            <button type="button" className="mini-settings-customize" onClick={startEditingLayout}>{t("mini.customizeWidget")}</button>
            <div className="mini-settings-window-actions">
              <button type="button" onClick={() => void invoke("hide_mini")}>{t("mini.hideToTray")}</button>
            </div>
          </div>
          <button className="mini-settings-reset" type="button" onClick={() => void resetGeometry()}>{t("mini.settingsReset")}</button>
        </section>
      )}
      {cornerOpen && (
        <section ref={cornerPopoverRef} className="mini-popover mini-corner-popover" aria-label={t("mini.cornerChoose")} onPointerDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()}>
          <div className="mini-corner-buttons">
            {(["tl", "tr", "bl", "br"] as const).map((option) => (
              <button type="button" key={option} className={corner === option ? "is-active" : ""} aria-pressed={corner === option} aria-label={t(`mini.cornerName.${option}`)} onClick={() => void selectCorner(option)}>{t(`mini.corner.${option}`)}</button>
            ))}
          </div>
          <label className="mini-corner-tuck" title={t("mini.tuckHint")}>
            <input type="checkbox" checked={cornerTuck} disabled={corner === null || clickThrough} onChange={(event) => void changeCornerTuck(event.target.checked)} />
            <span>{t("mini.tuckCorner")}</span>
            {corner === null && <small>{t("mini.tuckNeedCorner")}</small>}
            {corner !== null && clickThrough && <small>{t("mini.tuckClickThroughFirst")}</small>}
          </label>
        </section>
      )}
      {tucked && corner && (
        <button
          type="button"
          className={`mini-tuck-handle corner-${TUCK_DIAGONAL[corner]}`}
          aria-label={t("mini.tuckShow")}
          title={t("mini.tuckShow")}
          onClick={(event) => {
            event.stopPropagation();
            untuckWidget();
          }}
        ><MiniIcon name="chevron" /></button>
      )}
      <span className="mini-resize-grip" aria-hidden="true" />
    </main>
  );
}

function matchesMiniCorner(value: string | null | undefined): value is MiniCorner {
  return value === "tl" || value === "tr" || value === "bl" || value === "br";
}
