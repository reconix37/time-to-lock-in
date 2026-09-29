import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emitTo, listen } from "@tauri-apps/api/event";
import { MiniIcon } from "./MiniView";
import { useI18n } from "./i18nContext";
import { useMiniRightDrag } from "./useMiniRightDrag";

type MiniCorner = "tl" | "tr" | "bl" | "br";

interface MiniState {
  pinned: boolean;
  corner: MiniCorner | null;
}

export function MiniBrow() {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [clickThrough, setClickThroughState] = useState(false);
  const [pinned, setPinned] = useState(true);
  const [corner, setCorner] = useState<MiniCorner | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [opacity, setOpacity] = useState(100);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const rightDrag = useMiniRightDrag();
  const closeTimerRef = useRef<number | null>(null);

  const load = useCallback(async () => {
    try {
      const [settings, state] = await Promise.all([
        invoke<Record<string, string>>("get_settings"),
        invoke<MiniState>("get_mini_state"),
      ]);
      document.documentElement.dataset.theme = settings.theme === "dark" ? "dark" : "";
      setClickThroughState(settings.mini_click_through === "1");
      setPinned(state.pinned);
      setCorner(state.corner);
      setOpacity(Number(settings.mini_opacity ?? "100"));
      setError(null);
    } catch (reason: unknown) {
      setError(typeof reason === "string" ? reason : t("error.miniRefresh"));
    }
  }, [t]);

  useEffect(() => {
    document.body.classList.add("is-mini-brow");
    void load();
    let active = true;
    let stopRefreshListener: (() => void) | null = null;
    void listen("mini://refresh", () => void load()).then((unlisten) => {
      if (active) stopRefreshListener = unlisten;
      else unlisten();
    });
    const refresh = window.setInterval(() => void load(), 2_000);
    return () => {
      active = false;
      document.body.classList.remove("is-mini-brow");
      stopRefreshListener?.();
      if (closeTimerRef.current !== null) window.clearTimeout(closeTimerRef.current);
      window.clearInterval(refresh);
    };
  }, [load]);

  useEffect(() => {
    void invoke("set_mini_brow_expanded", { expanded: open, settingsOpen });
  }, [open, settingsOpen]);

  const keepOpen = () => {
    if (closeTimerRef.current !== null) window.clearTimeout(closeTimerRef.current);
    setOpen(true);
  };

  const scheduleClose = () => {
    if (closeTimerRef.current !== null) window.clearTimeout(closeTimerRef.current);
    closeTimerRef.current = window.setTimeout(() => { setOpen(false); setSettingsOpen(false); }, 280);
  };

  async function changeClickThrough(next: boolean): Promise<boolean> {
    try {
      await invoke("set_setting", { key: "mini_click_through", value: next ? "1" : "0" });
      setClickThroughState(next);
      await emitTo("mini", "mini://refresh");
      setError(null);
      return true;
    } catch (reason: unknown) {
      setError(typeof reason === "string" ? reason : t("error.saveSettings"));
      return false;
    }
  }

  async function openBodyPanel(panel: "settings" | "corner"): Promise<void> {
    if (clickThrough && !(await changeClickThrough(false))) return;
    setOpen(false);
    await invoke("set_mini_brow_expanded", { expanded: false, settingsOpen: false });
    await emitTo("mini", "mini://open-panel", { panel, clickThrough: false });
  }

  async function togglePinned(): Promise<void> {
    const next = !pinned;
    try {
      await invoke("set_mini_pinned", { pinned: next });
      setPinned(next);
      setError(null);
    } catch (reason: unknown) {
      setError(typeof reason === "string" ? reason : t("error.miniPin"));
    }
  }

  async function changeOpacity(next: number): Promise<void> {
    setOpacity(next);
    try {
      await invoke("set_setting", { key: "mini_opacity", value: String(next) });
      await emitTo("mini", "mini://refresh");
    } catch (reason: unknown) {
      setError(typeof reason === "string" ? reason : t("error.saveSettings"));
    }
  }

  return (
    <main
      className="mini-brow-shell"
      onMouseEnter={keepOpen}
      onMouseLeave={scheduleClose}
      onContextMenu={(event) => event.preventDefault()}
      {...rightDrag}
    >
      <button
        type="button"
        className="mini-brow-handle"
        aria-label={t("mini.browReveal")}
        onClick={() => setOpen((current) => !current)}
      ><MiniIcon name="chevron" /></button>

      {open && (
        <nav className="mini-brow-panel" aria-label={t("mini.browActions")}>
          <div className="mini-brow-actions">
          <button type="button" className="mini-icon-button" aria-label={t("mini.dashboard")} title={t("mini.dashboard")} onClick={() => void invoke("show_dashboard")}>
            <MiniIcon name="dashboard" />
          </button>
          <button type="button" className={`mini-icon-button${corner ? " is-active" : ""}`} aria-pressed={corner !== null} aria-label={corner ? t("mini.cornerUnlock") : t("mini.cornerPin")} title={corner ? t("mini.cornerUnlock") : t("mini.cornerPin")} onClick={() => void openBodyPanel("corner")}>
              {corner ? t(`mini.corner.${corner}`) : <MiniIcon name="corner" />}
          </button>
          <button type="button" className="mini-icon-button" aria-label={t("mini.hideToTray")} title={t("mini.hideToTray")} onClick={() => void invoke("hide_mini")}>
            <MiniIcon name="hide" />
          </button>
          <span className="mini-brow-sep" aria-hidden="true" />
          <button type="button" className={`mini-icon-button${pinned ? " is-active" : ""}`} aria-pressed={pinned} aria-label={pinned ? t("mini.unpin") : t("mini.pin")} title={pinned ? t("mini.unpin") : t("mini.pin")} onClick={() => void togglePinned()}>
              <MiniIcon name="pin" />
          </button>
          <button
            type="button"
            className={`mini-icon-button${clickThrough ? " mini-brow-off-button is-active" : ""}`}
            aria-pressed={clickThrough}
            aria-label={clickThrough ? t("mini.clickThroughOff") : t("mini.clickThrough")}
            title={t("mini.clickThroughHint")}
            onClick={() => void changeClickThrough(!clickThrough)}
          >
            <MiniIcon name="click" />
            {clickThrough && <span>{t("mini.clickThroughOff")}</span>}
          </button>
          <button type="button" className={`mini-icon-button${settingsOpen ? " is-active" : ""}`} aria-label={t("mini.settings")} title={t("mini.settings")} onClick={() => setSettingsOpen((current) => !current)}>
              <MiniIcon name="settings" />
          </button>
          </div>
          {settingsOpen && <div className="mini-brow-settings">
            <label className="mini-settings-opacity"><span>{t("mini.settingsOpacity")}</span><output>{opacity}%</output><input type="range" min="60" max="100" step="5" value={opacity} onChange={(event) => void changeOpacity(Number(event.target.value))} /></label>
            <button type="button" onClick={() => void openBodyPanel("settings")}>{t("mini.settings")}</button>
          </div>}
        </nav>
      )}
      {error && <span className="mini-brow-error" role="status" title={error}>!</span>}
    </main>
  );
}
