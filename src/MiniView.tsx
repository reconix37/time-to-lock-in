import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ProgressOverview } from "./progress";

type CategoryKind = "useful" | "neutral" | "waste";

const DEFAULT_KIND_LABELS: Record<CategoryKind, string> = {
  useful: "Полезное",
  neutral: "Нейтральное",
  waste: "Потери",
};

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
}

interface BulletBarProps {
  kind: "useful" | "neutral" | "waste";
  label: string;
  valueMs: number;
  thresholdMin: number;
}

function formatClock(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1_000));
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor(seconds % 3_600 / 60);
  const remainder = seconds % 60;
  return [hours, minutes, remainder].map((value) => value.toString().padStart(2, "0")).join(":");
}

function cleanAppName(app: string): string {
  return app.replace(/\.exe$/i, "");
}

function BulletBar({ kind, label, valueMs, thresholdMin }: BulletBarProps) {
  const thresholdMs = thresholdMin * 60_000;
  const scaleMs = Math.max(thresholdMs * 1.25, valueMs, 1);
  const fill = thresholdMs === 0 ? (valueMs > 0 ? 100 : 0) : Math.min(100, valueMs / scaleMs * 100);
  const tick = Math.min(100, thresholdMs / scaleMs * 100);

  return (
    <div className={`mini-bullet kind-${kind}`}>
      <div className="mini-bullet-copy">
        <span>{label}</span>
        <strong>
          {Math.floor(valueMs / 60_000)}м
          {thresholdMs > 0 && <small> / {thresholdMin}м</small>}
        </strong>
      </div>
      <div className="mini-bullet-rail" aria-hidden="true">
        <i style={{ width: `${fill}%` }} />
        {thresholdMs > 0 && <span style={{ left: `${tick}%` }} />}
      </div>
    </div>
  );
}

export function MiniView() {
  const [progress, setProgress] = useState<ProgressOverview | null>(null);
  const [liveSegment, setLiveSegment] = useState<LiveSegment | null>(null);
  const [paused, setPaused] = useState(false);
  const [pinned, setPinned] = useState(true);
  const [kindLabels, setKindLabels] = useState(DEFAULT_KIND_LABELS);
  const [now, setNow] = useState(Date.now());
  const [error, setError] = useState<string | null>(null);

  const loadMini = useCallback(async () => {
    try {
      const [nextProgress, nextLiveSegment, trackingPaused, settings] = await Promise.all([
        invoke<ProgressOverview>("get_progress_overview"),
        invoke<LiveSegment | null>("get_live_segment"),
        invoke<boolean>("get_tracking_paused"),
        invoke<Record<string, string>>("get_settings"),
      ]);
      setProgress(nextProgress);
      setLiveSegment(nextLiveSegment);
      setPaused(trackingPaused);
      setPinned(settings.mini_pinned === "1");
      setKindLabels({
        useful: settings.kind_label_useful ?? DEFAULT_KIND_LABELS.useful,
        neutral: settings.kind_label_neutral ?? DEFAULT_KIND_LABELS.neutral,
        waste: settings.kind_label_waste ?? DEFAULT_KIND_LABELS.waste,
      });
      document.documentElement.dataset.theme = settings.theme === "dark" ? "dark" : "";
      setError(null);
    } catch (reason: unknown) {
      setError(typeof reason === "string" ? reason : "Не удалось обновить мини-окно");
    }
  }, []);

  useEffect(() => {
    void invoke("fix_mini_window");
    void loadMini();
    const refresh = window.setInterval(() => void loadMini(), 5_000);
    const clock = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => {
      window.clearInterval(refresh);
      window.clearInterval(clock);
    };
  }, [loadMini]);

  const rankProgress = useMemo(() => {
    if (!progress || progress.next_rank_threshold === null) return 100;
    const span = progress.next_rank_threshold - progress.current_rank_threshold;
    return Math.min(100, Math.max(0, (progress.lifetime_xp - progress.current_rank_threshold) / span * 100));
  }, [progress]);

  async function toggleTracking(event: React.MouseEvent<HTMLButtonElement>) {
    event.stopPropagation();
    const nextPaused = !paused;
    setPaused(nextPaused);
    try {
      await invoke("set_tracking_paused", { paused: nextPaused });
      await loadMini();
    } catch (reason: unknown) {
      setPaused(!nextPaused);
      setError(typeof reason === "string" ? reason : "Не удалось изменить трекинг");
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
      setError(typeof reason === "string" ? reason : "Не удалось закрепить окно");
    }
  }

  const away = liveSegment?.status === "away";
  const sessionMs = liveSegment ? now - liveSegment.ts_start : 0;

  return (
    <main className="mini-shell">
      <div
        className="mini-drag-strip"
        onMouseDown={(event) => {
          event.stopPropagation();
          if (event.button === 0) void invoke("start_mini_drag");
        }}
      >
        <span className={`mini-pulse ${away ? "is-away" : liveSegment && !paused ? "is-live" : ""}`} />
        <span>{away ? "AFK" : paused ? "Пауза" : liveSegment ? cleanAppName(liveSegment.app) : "TTLI"}</span>
        <i aria-hidden="true">•••</i>
      </div>

      <section className="mini-session" aria-label="Текущая сессия">
        <strong>{formatClock(sessionMs)}</strong>
        <span>{liveSegment ? liveSegment.category_name : paused ? "Наблюдение приостановлено" : "Ждём активное окно"}</span>
      </section>

      {progress ? (
        <section className="mini-metrics" aria-label="Прогресс дня">
          <BulletBar kind="useful" label={kindLabels.useful} valueMs={progress.today.useful_ms} thresholdMin={progress.today.useful_goal_min} />
          <BulletBar kind="waste" label={kindLabels.waste} valueMs={progress.today.waste_ms} thresholdMin={progress.today.waste_limit_min} />
          <BulletBar kind="neutral" label={kindLabels.neutral} valueMs={progress.today.neutral_ms} thresholdMin={0} />
          <div className="mini-rank">
            <span>{progress.current_rank}</span>
            <div aria-hidden="true"><i style={{ width: `${rankProgress}%` }} /></div>
            <strong>{progress.lifetime_xp.toLocaleString("ru-RU")} XP</strong>
          </div>
        </section>
      ) : <div className="mini-loading" aria-label="Загрузка" />}

      {error && <p className="mini-error">{error}</p>}

      <footer className="mini-actions">
        <button type="button" onClick={(event) => void toggleTracking(event)}>{paused ? "Продолжить" : "Пауза"}</button>
        <button type="button" onClick={() => void invoke("show_dashboard")}>Дашборд</button>
        <button
          type="button"
          className={pinned ? "is-pinned" : ""}
          aria-pressed={pinned}
          aria-label={pinned ? "Открепить мини-окно" : "Закрепить мини-окно поверх остальных"}
          title={pinned ? "Открепить" : "Закрепить поверх окон"}
          onClick={(event) => void togglePin(event)}
        >
          {pinned ? "●" : "○"}
        </button>
      </footer>
    </main>
  );
}
