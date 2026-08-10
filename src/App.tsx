import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import "./styles/tokens.css";
import "./App.css";

type CategoryKind = "useful" | "neutral" | "waste";

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

const EMPTY_STATS: TodayStats = {
  useful_ms: 0,
  neutral_ms: 0,
  waste_ms: 0,
  observed_ms: 0,
};

const KIND_LABELS: Record<CategoryKind, string> = {
  useful: "Полезное",
  neutral: "Нейтральное",
  waste: "Потери",
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

function App() {
  const [segments, setSegments] = useState<Segment[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [stats, setStats] = useState<TodayStats>(EMPTY_STATS);
  const [apps, setApps] = useState<AppToday[]>([]);
  const [selectedSegment, setSelectedSegment] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const [dark, setDark] = useState(false);
  const [paused, setPaused] = useState(false);
  const [showAllSegments, setShowAllSegments] = useState(false);

  const loadDashboard = useCallback(async () => {
    try {
      const [nextSegments, nextCategories, nextStats, nextApps, settings, trackingPaused] =
        await Promise.all([
          invoke<Segment[]>("get_today_segments"),
          invoke<Category[]>("get_categories"),
          invoke<TodayStats>("get_today_stats"),
          invoke<AppToday[]>("get_apps_today"),
          invoke<Record<string, string>>("get_settings"),
          invoke<boolean>("get_tracking_paused"),
        ]);
      setSegments(nextSegments);
      setCategories(nextCategories);
      setStats(nextStats);
      setApps(nextApps);
      setDark(settings.theme === "dark");
      setPaused(trackingPaused);
      setError(null);
    } catch (reason: unknown) {
      setError(typeof reason === "string" ? reason : "Не удалось прочитать локальные данные");
    } finally {
      setLoading(false);
    }
  }, []);

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

  const categoryById = useMemo(
    () => new Map(categories.map((category) => [category.id, category])),
    [categories],
  );
  const latestSegment = segments[segments.length - 1];
  const live = !paused && latestSegment?.status === "active" && now - latestSegment.ts_end <= 10_000
    ? latestSegment
    : undefined;
  const totalRing = Math.max(stats.observed_ms, 1);
  const ringParts = [
    { kind: "useful" as const, value: stats.useful_ms },
    { kind: "neutral" as const, value: stats.neutral_ms },
    { kind: "waste" as const, value: stats.waste_ms },
  ];
  let ringOffset = 0;
  const maxAppDuration = Math.max(...apps.map((app) => app.duration_ms), 1);
  const reversedSegments = [...segments].reverse();
  const visibleSegments = showAllSegments ? reversedSegments : reversedSegments.slice(0, 50);

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

  async function reclassify(segmentId: number, categoryId: number | null) {
    try {
      await invoke("set_segment_category", { segmentId, categoryId });
      setSelectedSegment(null);
      await loadDashboard();
    } catch (reason: unknown) {
      setError(typeof reason === "string" ? reason : "Не удалось изменить категорию");
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
            <span className={`category-chip kind-${categoryById.get(live.category_id ?? -1)?.kind ?? "muted"}`}>
              {categoryById.get(live.category_id ?? -1)?.name ?? "Без категории"}
            </span>
            <div className="live-clock">
              <strong>{formatDuration(now - live.ts_start)}</strong>
              <span>с {formatTime(live.ts_start)}</span>
            </div>
          </>
        )}
      </section>

      {error && <div className="error-banner">{error}. Данные обновятся автоматически.</div>}

      <div className="dashboard-grid">
        <section className="card timeline-card">
          <div className="card-heading">
            <div><span className="eyebrow">Сегодня</span><h1>Хронология дня</h1></div>
            <span className="mono-meta">{segments.length} сегментов</span>
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
                        className={`track-segment ${segment.status === "away" ? "is-away" : ""}`}
                        style={{
                          left: `${(startMinute / 1440) * 100}%`,
                          width: `${Math.max((duration / 86_400_000) * 100, 0.18)}%`,
                          "--segment-color": category?.color ?? "var(--cat-muted)",
                        } as React.CSSProperties}
                        onClick={() => setSelectedSegment(segment.id)}
                        title={`${cleanAppName(segment.app)} · ${formatDuration(duration)}`}
                      />
                    );
                  })}
                </div>
              </div>

              <div className="segment-list">
                {visibleSegments.map((segment) => {
                  const category = categoryById.get(segment.category_id ?? -1);
                  const isCurrent = live?.id === segment.id;
                  const duration = (isCurrent ? now : segment.ts_end) - segment.ts_start;
                  return (
                    <div className="segment-row" key={segment.id}>
                      <button className="segment-main" onClick={() => setSelectedSegment(segment.id)}>
                        <span className="segment-time">{formatTime(segment.ts_start)}–{formatTime(isCurrent ? now : segment.ts_end)}</span>
                        <span className="segment-app"><strong>{cleanAppName(segment.app)}</strong><small>{segment.domain || segment.window_title || "Без заголовка"}</small></span>
                        <span className="segment-category" style={{ "--segment-color": category?.color ?? "var(--cat-muted)" } as React.CSSProperties}>{category?.name ?? (segment.status === "away" ? "Перерыв" : "Без категории")}</span>
                        <span className="segment-duration">{formatDuration(duration)}</span>
                      </button>
                      {selectedSegment === segment.id && (
                        <div className="category-picker">
                          <span>Переклассифицировать:</span>
                          {categories.map((item) => (
                            <button key={item.id} onClick={() => void reclassify(segment.id, item.id)}>{item.name}</button>
                          ))}
                          <button onClick={() => void reclassify(segment.id, null)}>Без категории</button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
              {!showAllSegments && segments.length > 50 && (
                <button className="show-all-button" onClick={() => setShowAllSegments(true)}>
                  Показать все ({segments.length})
                </button>
              )}
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
                    <span>{KIND_LABELS[part.kind]}</span>
                    <strong>{formatDuration(part.value)}</strong>
                  </div>
                ))}
              </div>
            </div>
            <div className="category-bars">
              {ringParts.map((part) => (
                <div className="category-bar" key={part.kind}>
                  <div><span>{KIND_LABELS[part.kind]}</span><strong>{stats.observed_ms ? Math.round((part.value / stats.observed_ms) * 100) : 0}%</strong></div>
                  <span className="bar-rail"><i className={`kind-${part.kind}`} style={{ width: `${stats.observed_ms ? (part.value / stats.observed_ms) * 100 : 0}%` }} /></span>
                </div>
              ))}
            </div>
          </section>

          <section className="card apps-card">
            <div className="card-heading"><div><span className="eyebrow">Рейтинг</span><h2>Приложения</h2></div></div>
            {apps.length === 0 ? <p className="quiet-empty">Пока нет данных</p> : apps.slice(0, 6).map((app) => {
              const dominant: CategoryKind = app.useful_ms >= app.neutral_ms && app.useful_ms >= app.waste_ms ? "useful" : app.waste_ms >= app.neutral_ms ? "waste" : "neutral";
              return (
                <div className="app-row" key={app.app}>
                  <span className="app-rank">{String(apps.indexOf(app) + 1).padStart(2, "0")}</span>
                  <span className="app-name">{cleanAppName(app.app)}</span>
                  <span className="app-bar"><i className={`kind-${dominant}`} style={{ width: `${(app.duration_ms / maxAppDuration) * 100}%` }} /></span>
                  <strong>{formatDuration(app.duration_ms)}</strong>
                </div>
              );
            })}
          </section>
        </aside>
      </div>
    </main>
  );
}

export default App;
