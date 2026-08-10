-- TTLI — 001_init (schema v1)
-- Канон: PRD v2 + Аудит раунда 7. Все ts — epoch ms (UTC). WAL на уровне подключения.

CREATE TABLE IF NOT EXISTS categories (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    name           TEXT    NOT NULL UNIQUE,
    color          TEXT    NOT NULL,            -- hex, из палитры Rosé Pine
    icon           TEXT    NOT NULL DEFAULT '',
    kind           TEXT    NOT NULL DEFAULT 'neutral' CHECK (kind IN ('useful','neutral','waste')),
    goal_multiplier REAL   NOT NULL DEFAULT 1.0, -- только для локальных целей, НЕ в Public XP
    created_at     INTEGER NOT NULL,
    sort_order     INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS rules (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    match_type  TEXT    NOT NULL CHECK (match_type IN ('exe','title','domain')),
    pattern     TEXT    NOT NULL,              -- exe: точное/префикс; title/domain: contains; lowercase
    category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
    priority    INTEGER NOT NULL DEFAULT 0,    -- выше = раньше; при равном: domain > title > exe
    created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rules_lookup ON rules(match_type, priority DESC);

CREATE TABLE IF NOT EXISTS segments (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    ts_start     INTEGER NOT NULL,             -- epoch ms (UTC)
    ts_end       INTEGER NOT NULL,             -- epoch ms (UTC)
    app          TEXT    NOT NULL,             -- exe/процесс
    window_title TEXT    NOT NULL DEFAULT '',
    domain       TEXT    NOT NULL DEFAULT '',  -- от расширения; пусто для не-браузерных
    category_id  INTEGER REFERENCES categories(id) ON DELETE SET NULL,
    status       TEXT    NOT NULL DEFAULT 'active' CHECK (status IN ('active','crashed','away','paused'))
);
CREATE INDEX IF NOT EXISTS idx_segments_range ON segments(ts_start, ts_end);
CREATE INDEX IF NOT EXISTS idx_segments_cat ON segments(category_id);

CREATE TABLE IF NOT EXISTS daily_stats (
    local_date  TEXT    NOT NULL,              -- YYYY-MM-DD по локальному offset на момент записи
    category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
    duration_ms INTEGER NOT NULL DEFAULT 0,
    xp          INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (local_date, category_id)
);

CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
-- Дефолты (заполняются при первом запуске, если пусто):
-- useful_goal_min=120, waste_limit_min=60, observed_min=60,
-- idle_timeout_min=5, hourly_rate=NULL (opt-in), theme=dawn,
-- onboarding_done=0, extension_token=<генерируется>,
-- mini_window_pos=<x,y>, tray_only=0
