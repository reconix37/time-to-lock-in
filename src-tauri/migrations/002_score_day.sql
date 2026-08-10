-- TTLI — 002_score_day. Эффективные цели и единое разбиение сегментов по локальным дням.

CREATE TABLE IF NOT EXISTS goal_history (
    effective_local_date TEXT    PRIMARY KEY,
    useful_goal_min      INTEGER NOT NULL CHECK (useful_goal_min BETWEEN 0 AND 1440),
    waste_limit_min      INTEGER NOT NULL CHECK (waste_limit_min BETWEEN 0 AND 1440),
    observed_min         INTEGER NOT NULL CHECK (observed_min BETWEEN 0 AND 1440)
);

INSERT OR IGNORE INTO goal_history (
    effective_local_date,
    useful_goal_min,
    waste_limit_min,
    observed_min
)
SELECT
    '1970-01-01',
    CAST((SELECT value FROM settings WHERE key = 'useful_goal_min') AS INTEGER),
    CAST((SELECT value FROM settings WHERE key = 'waste_limit_min') AS INTEGER),
    CAST((SELECT value FROM settings WHERE key = 'observed_min') AS INTEGER);

DROP VIEW IF EXISTS segment_day_overlaps;
CREATE VIEW segment_day_overlaps AS
WITH RECURSIVE overlaps (
    segment_id, category_id, status, ts_start, ts_end, local_date
) AS (
    SELECT
        id,
        COALESCE(category_id, 0),
        status,
        ts_start,
        ts_end,
        date(ts_start / 1000, 'unixepoch', 'localtime')
    FROM segments
    WHERE status IN ('active', 'crashed') AND ts_end > ts_start

    UNION ALL

    SELECT
        segment_id,
        category_id,
        status,
        ts_start,
        ts_end,
        date(local_date, '+1 day')
    FROM overlaps
    WHERE date(local_date, '+1 day') <= date((ts_end - 1) / 1000, 'unixepoch', 'localtime')
)
SELECT
    segment_id,
    category_id,
    status,
    local_date,
    MAX(
        0,
        MIN(
            ts_end,
            CAST(strftime('%s', local_date || ' 00:00:00', '+1 day', 'utc') AS INTEGER) * 1000
        ) - MAX(
            ts_start,
            CAST(strftime('%s', local_date || ' 00:00:00', 'utc') AS INTEGER) * 1000
        )
    ) AS duration_ms
FROM overlaps;
