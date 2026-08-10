import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
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

interface TimelineBlock {
  id: number;
  app: string;
  category_id: number;
  segments: Segment[];
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
  const [showAllBlocks, setShowAllBlocks] = useState(false);
  const [expandedBlockIds, setExpandedBlockIds] = useState<Set<number>>(new Set());
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [extensionChromeId, setExtensionChromeId] = useState("");
  const [extensionEdgeId, setExtensionEdgeId] = useState("");
  const [tokenCopied, setTokenCopied] = useState(false);
  const [categoryManagerOpen, setCategoryManagerOpen] = useState(false);
  const [categoryManagerTab, setCategoryManagerTab] = useState<"categories" | "rules">("categories");
  const [rules, setRules] = useState<Rule[]>([]);
  const [managerLoading, setManagerLoading] = useState(false);
  const [managerSaving, setManagerSaving] = useState(false);
  const [managerError, setManagerError] = useState<string | null>(null);
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
      const [nextSegments, nextCategories, nextStats, nextApps, nextSettings, trackingPaused] =
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
      setSettings(nextSettings);
      setDark(nextSettings.theme === "dark");
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

  const categoryById = useMemo(
    () => new Map(categories.map((category) => [category.id, category])),
    [categories],
  );
  const manageableCategories = useMemo(
    () => categories.filter((category) => category.id !== 0),
    [categories],
  );
  const timelineBlocks = useMemo(() => {
    const blocks: TimelineBlock[] = [];
    for (const segment of segments) {
      const previous = blocks[blocks.length - 1];
      if (previous?.app === segment.app && previous.category_id === segment.category_id) {
        previous.segments.push(segment);
      } else {
        blocks.push({
          id: segment.id,
          app: segment.app,
          category_id: segment.category_id,
          segments: [segment],
        });
      }
    }
    return blocks.reverse();
  }, [segments]);
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
  const visibleBlocks = showAllBlocks ? timelineBlocks : timelineBlocks.slice(0, 30);

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

  function openSettings() {
    setExtensionChromeId(settings.extension_chrome_id ?? "");
    setExtensionEdgeId(settings.extension_edge_id ?? "");
    setTokenCopied(false);
    setSettingsError(null);
    setSettingsOpen(true);
  }

  async function openCategoryManager() {
    setCategoryManagerTab("categories");
    setCategoryFormOpen(false);
    setRuleFormOpen(false);
    setManagerError(null);
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
      setRules((current) => current.filter((rule) => rule.id !== ruleId));
    } catch (reason: unknown) {
      setManagerError(typeof reason === "string" ? reason : "Не удалось удалить правило");
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

  function toggleBlock(blockId: number) {
    setExpandedBlockIds((current) => {
      const next = new Set(current);
      if (next.has(blockId)) next.delete(blockId);
      else next.add(blockId);
      return next;
    });
  }

  function selectTimelineSegment(segmentId: number) {
    const block = timelineBlocks.find((item) =>
      item.segments.some((segment) => segment.id === segmentId),
    );
    if (block) {
      setExpandedBlockIds((current) => new Set(current).add(block.id));
      if (timelineBlocks.indexOf(block) >= 30) setShowAllBlocks(true);
    }
    setSelectedSegment(segmentId);
  }

  async function saveExtensionSettings() {
    const chromeId = extensionChromeId.trim();
    const edgeId = extensionEdgeId.trim();
    const isValidId = (value: string) => value === "" || /^[a-p]{32}$/.test(value);
    if (!isValidId(chromeId) || !isValidId(edgeId)) {
      setSettingsError("ID должен состоять из 32 символов от a до p");
      return;
    }
    setSettingsSaving(true);
    setSettingsError(null);
    try {
      await Promise.all([
        invoke<void>("set_setting", { key: "extension_chrome_id", value: chromeId }),
        invoke<void>("set_setting", { key: "extension_edge_id", value: edgeId }),
      ]);
      setSettings((current) => ({
        ...current,
        extension_chrome_id: chromeId,
        extension_edge_id: edgeId,
      }));
      setSettingsOpen(false);
      setError(null);
    } catch (reason: unknown) {
      setSettingsError(typeof reason === "string" ? reason : "Не удалось сохранить настройки расширения");
    } finally {
      setSettingsSaving(false);
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
        <button className="manager-open-button" onClick={() => void openCategoryManager()} aria-label="Открыть категории и правила">
          <span aria-hidden="true">🗂</span><span className="manager-open-label">Категории</span>
        </button>
        <button className="icon-button" onClick={openSettings} aria-label="Открыть настройки">
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
            <span className={`category-tag kind-${categoryById.get(live.category_id)?.kind ?? "muted"}`}>
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
                        onClick={() => selectTimelineSegment(segment.id)}
                        title={`${cleanAppName(segment.app)} · ${formatDuration(duration)}`}
                      />
                    );
                  })}
                </div>
              </div>

              <div className="segment-list">
                {visibleBlocks.map((block) => {
                  const firstSegment = block.segments[0];
                  const lastSegment = block.segments[block.segments.length - 1];
                  const category = categoryById.get(block.category_id);
                  const isExpanded = expandedBlockIds.has(block.id);
                  const blockEnd = live?.id === lastSegment.id ? now : lastSegment.ts_end;
                  const duration = block.segments.reduce((total, segment) => {
                    const segmentEnd = live?.id === segment.id ? now : segment.ts_end;
                    return total + Math.max(0, segmentEnd - segment.ts_start);
                  }, 0);
                  return (
                    <div className="segment-block" key={block.id}>
                      <button
                        className="segment-main"
                        aria-expanded={isExpanded}
                        onClick={() => toggleBlock(block.id)}
                      >
                        <span className="segment-time">{formatTime(firstSegment.ts_start)}–{formatTime(blockEnd)}</span>
                        <span className="segment-app"><strong>{cleanAppName(block.app)}</strong><small>{lastSegment.domain || lastSegment.window_title || "Без заголовка"}</small></span>
                        <span className={`category-tag kind-${category?.kind ?? "muted"}`}>{category?.name ?? (lastSegment.status === "away" ? "Перерыв" : "Без категории")}</span>
                        <span className="segment-duration">{formatDuration(duration)}</span>
                      </button>
                      {isExpanded && (
                        <div className="nested-segment-list">
                          {block.segments.map((segment) => {
                            const segmentCategory = categoryById.get(segment.category_id);
                            const isCurrent = live?.id === segment.id;
                            const segmentEnd = isCurrent ? now : segment.ts_end;
                            return (
                              <div className="nested-segment" key={segment.id}>
                                <button className="nested-segment-main" onClick={() => setSelectedSegment(segment.id)}>
                                  <span className="segment-time">{formatTime(segment.ts_start)}–{formatTime(segmentEnd)}</span>
                                  <span className="segment-app"><small>{segment.domain || segment.window_title || "Без заголовка"}</small></span>
                                  <span className={`category-tag kind-${segmentCategory?.kind ?? "muted"}`}>{segmentCategory?.name ?? (segment.status === "away" ? "Перерыв" : "Без категории")}</span>
                                  <span className="segment-duration">{formatDuration(segmentEnd - segment.ts_start)}</span>
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
                      )}
                    </div>
                  );
                })}
              </div>
              {!showAllBlocks && timelineBlocks.length > 30 && (
                <button className="show-all-button" onClick={() => setShowAllBlocks(true)}>
                  Показать все ({timelineBlocks.length})
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
                          <option value="useful">Полезное</option>
                          <option value="neutral">Нейтральное</option>
                          <option value="waste">Потери</option>
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
                        <strong>{category.name}</strong>
                        <span className={`manager-kind kind-${category.kind}`}>{KIND_LABELS[category.kind]}</span>
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
                          <span className="rule-category">
                            <span className="manager-color-dot" style={{ backgroundColor: category?.color ?? "var(--cat-muted)" }} />
                            {category?.name ?? "Без категории"}
                          </span>
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
              <span className="eyebrow">Браузер</span>
              <h2 id="settings-title">Настройки</h2>
            </div>
            <label className="settings-field">
              <span>ID расширения Chrome</span>
              <input
                autoFocus
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
              ID виден в chrome://extensions → TTLI Tracker → ID. Вставляется один раз, после этого браузер шлёт события в приложение.
            </p>
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
            {settingsError && <p className="settings-error" id="settings-error">{settingsError}</p>}
            <div className="settings-actions">
              <button className="settings-done" disabled={settingsSaving} onClick={() => void saveExtensionSettings()}>
                {settingsSaving ? "Сохраняем…" : "Готово"}
              </button>
            </div>
          </section>
        </div>
      )}
    </main>
  );
}

export default App;
