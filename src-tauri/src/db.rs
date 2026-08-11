use rusqlite::{params, Connection, OptionalExtension, Transaction};
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};
use uuid::Uuid;

const MIGRATION_001: &str = include_str!("../migrations/001_init.sql");
const MIGRATION_002: &str = include_str!("../migrations/002_score_day.sql");
const MIGRATION_003: &str = include_str!("../migrations/003_day_print.sql");

pub struct CategoryRecord {
    pub id: i64,
    pub name: String,
    pub color: String,
    pub icon: String,
    pub kind: String,
    pub goal_multiplier: f64,
    pub sort_order: i64,
}

#[derive(Debug, PartialEq)]
pub struct DailyProgressRecord {
    pub local_date: String,
    pub useful_ms: i64,
    pub neutral_ms: i64,
    pub waste_ms: i64,
    pub useful_goal_min: i64,
    pub waste_limit_min: i64,
    pub observed_min: i64,
}

#[derive(Debug, PartialEq)]
pub struct DailySeriesRecord {
    pub local_date: String,
    pub useful_ms: i64,
    pub neutral_ms: i64,
    pub waste_ms: i64,
    pub observed_ms: i64,
    pub useful_goal_min: i64,
    pub waste_limit_min: i64,
    pub observed_min: i64,
    pub passed: bool,
    pub useful_xp: i64,
    pub useful_ma_7d_ms: i64,
}

#[derive(Debug, PartialEq)]
pub struct CumulativePointRecord {
    pub timestamp_ms: i64,
    pub hour: i64,
    pub useful_ms: i64,
    pub waste_ms: i64,
    pub is_current: bool,
}

#[derive(Debug, PartialEq)]
pub struct TodayCumulativeRecord {
    pub points: Vec<CumulativePointRecord>,
    pub useful_goal_min: i64,
    pub waste_limit_min: i64,
}

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

pub fn database_path() -> Result<PathBuf, String> {
    #[cfg(windows)]
    let base = std::env::var_os("APPDATA")
        .map(PathBuf::from)
        .ok_or_else(|| "APPDATA is not available".to_string())?;

    #[cfg(not(windows))]
    let base = std::env::var_os("APPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir);

    Ok(base.join("time_to_lock_in.db"))
}

pub fn open() -> Result<Connection, String> {
    let path = database_path()?;
    let connection = Connection::open(path).map_err(|error| error.to_string())?;
    connection
        .execute_batch("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;")
        .map_err(|error| error.to_string())?;
    Ok(connection)
}

pub fn initialize() -> Result<(), String> {
    let mut connection = open()?;
    let previous_version = connection
        .query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))
        .map_err(|error| error.to_string())?;
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    transaction
        .execute_batch(MIGRATION_001)
        .map_err(|error| error.to_string())?;

    let timestamp = now_ms();
    let categories_seeded = transaction
        .query_row(
            "SELECT value FROM settings WHERE key = 'category_defaults_seeded'",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| error.to_string())?
        .is_some();
    if !categories_seeded {
        for (name, color, icon, kind, sort_order) in [
            ("Work", "#286983", "briefcase", "useful", 0),
            ("Chill", "#ea9d34", "coffee", "neutral", 1),
            ("Brainrot", "#b4637a", "skull", "waste", 2),
        ] {
            transaction
                .execute(
                    "INSERT OR IGNORE INTO categories (name, color, icon, kind, created_at, sort_order)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                    params![name, color, icon, kind, timestamp, sort_order],
                )
                .map_err(|error| error.to_string())?;
        }
        transaction
            .execute(
                "INSERT INTO settings (key, value) VALUES ('category_defaults_seeded', '1')",
                [],
            )
            .map_err(|error| error.to_string())?;
    }

    for (key, value) in [
        ("useful_goal_min", "120".to_string()),
        ("waste_limit_min", "60".to_string()),
        ("observed_min", "60".to_string()),
        ("idle_timeout_min", "5".to_string()),
        ("theme", "dawn".to_string()),
        ("onboarding_done", "0".to_string()),
        ("tray_only", "1".to_string()),
        ("mini_pinned", "0".to_string()),
        ("extension_token", Uuid::new_v4().to_string()),
        ("extension_chrome_id", String::new()),
        ("extension_edge_id", String::new()),
        ("kind_label_useful", "Полезное".to_string()),
        ("kind_label_neutral", "Нейтральное".to_string()),
        ("kind_label_waste", "Потери".to_string()),
    ] {
        transaction
            .execute(
                "INSERT OR IGNORE INTO settings (key, value) VALUES (?1, ?2)",
                params![key, value],
            )
            .map_err(|error| error.to_string())?;
    }

    if previous_version < 2 {
        transaction
            .execute_batch(MIGRATION_002)
            .map_err(|error| error.to_string())?;
    }
    if previous_version < 3 {
        transaction
            .execute_batch(MIGRATION_003)
            .map_err(|error| error.to_string())?;
    }

    let crashed_segment_id = transaction
        .query_row(
            "SELECT id FROM segments
             WHERE id = CAST((SELECT value FROM settings WHERE key = 'active_segment_id') AS INTEGER)
               AND status = 'active'",
            [],
            |row| row.get::<_, i64>(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    transaction
        .execute(
            "UPDATE segments
             SET status = 'crashed'
             WHERE id = CAST((SELECT value FROM settings WHERE key = 'active_segment_id') AS INTEGER)
               AND status = 'active'",
            [],
        )
        .map_err(|error| error.to_string())?;
    if let Some(segment_id) = crashed_segment_id {
        for local_date in segment_local_dates(&transaction, segment_id)? {
            refresh_daily_stats(&transaction, &local_date)?;
        }
    }
    transaction
        .execute("DELETE FROM settings WHERE key = 'active_segment_id'", [])
        .map_err(|error| error.to_string())?;
    if previous_version < 2 {
        rebuild_daily_stats(&transaction)?;
    }
    transaction
        .execute_batch("PRAGMA user_version=3;")
        .map_err(|error| error.to_string())?;
    transaction.commit().map_err(|error| error.to_string())
}

pub fn setting(connection: &Connection, key: &str) -> Result<Option<String>, String> {
    connection
        .query_row("SELECT value FROM settings WHERE key = ?1", [key], |row| {
            row.get(0)
        })
        .optional()
        .map_err(|error| error.to_string())
}

pub fn set_setting(connection: &Connection, key: &str, value: &str) -> Result<(), String> {
    let transaction = connection
        .unchecked_transaction()
        .map_err(|error| error.to_string())?;
    transaction
        .execute(
            "INSERT INTO settings (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, value],
        )
        .map_err(|error| error.to_string())?;
    if matches!(key, "useful_goal_min" | "waste_limit_min" | "observed_min") {
        transaction
            .execute(
                "INSERT INTO goal_history (
                    effective_local_date, useful_goal_min, waste_limit_min, observed_min
                 )
                 SELECT date('now', 'localtime'),
                        CAST((SELECT value FROM settings WHERE key = 'useful_goal_min') AS INTEGER),
                        CAST((SELECT value FROM settings WHERE key = 'waste_limit_min') AS INTEGER),
                        CAST((SELECT value FROM settings WHERE key = 'observed_min') AS INTEGER)
                 ON CONFLICT(effective_local_date) DO UPDATE SET
                    useful_goal_min = excluded.useful_goal_min,
                    waste_limit_min = excluded.waste_limit_min,
                    observed_min = excluded.observed_min",
                [],
            )
            .map_err(|error| error.to_string())?;
    }
    transaction.commit().map_err(|error| error.to_string())
}

pub fn import_challenge(connection: &Connection, code: &str) -> Result<(i64, i64, i64), String> {
    let parts = code.split('-').collect::<Vec<_>>();
    if parts.len() != 4
        || parts[0] != "TF"
        || parts[1..].iter().any(|part| {
            part.is_empty() || !part.chars().all(|character| character.is_ascii_digit())
        })
    {
        return Err("Код должен быть в формате TF-184-43-60".to_string());
    }
    let values = parts[1..]
        .iter()
        .map(|part| part.parse::<i64>())
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| "Код должен быть в формате TF-184-43-60".to_string())?;
    if values.iter().any(|value| !(0..=1440).contains(value)) {
        return Err("Цели челленджа должны быть от 0 до 1440 минут".to_string());
    }
    let (useful_goal_min, waste_limit_min, observed_min) = (values[0], values[1], values[2]);
    let transaction = connection
        .unchecked_transaction()
        .map_err(|error| error.to_string())?;
    for (key, value) in [
        ("useful_goal_min", useful_goal_min),
        ("waste_limit_min", waste_limit_min),
        ("observed_min", observed_min),
    ] {
        transaction
            .execute(
                "INSERT INTO settings (key, value) VALUES (?1, ?2)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                params![key, value.to_string()],
            )
            .map_err(|error| error.to_string())?;
    }
    transaction
        .execute(
            "INSERT INTO goal_history (
                effective_local_date, useful_goal_min, waste_limit_min, observed_min
             ) VALUES (date('now', 'localtime'), ?1, ?2, ?3)
             ON CONFLICT(effective_local_date) DO UPDATE SET
                useful_goal_min = excluded.useful_goal_min,
                waste_limit_min = excluded.waste_limit_min,
                observed_min = excluded.observed_min",
            params![useful_goal_min, waste_limit_min, observed_min],
        )
        .map_err(|error| error.to_string())?;
    transaction
        .execute(
            "INSERT INTO challenge_history (
                local_date, code, useful_goal_min, waste_limit_min, observed_min
             ) VALUES (date('now', 'localtime'), ?1, ?2, ?3, ?4)
             ON CONFLICT(local_date) DO UPDATE SET
                code = excluded.code,
                useful_goal_min = excluded.useful_goal_min,
                waste_limit_min = excluded.waste_limit_min,
                observed_min = excluded.observed_min",
            params![code, useful_goal_min, waste_limit_min, observed_min],
        )
        .map_err(|error| error.to_string())?;
    transaction.commit().map_err(|error| error.to_string())?;
    Ok((useful_goal_min, waste_limit_min, observed_min))
}

pub fn create_category(name: &str, color: &str, kind: &str) -> Result<CategoryRecord, String> {
    let normalized_name = name.trim();
    if normalized_name.is_empty() || normalized_name.chars().count() > 80 {
        return Err("Название должно содержать от 1 до 80 символов".to_string());
    }
    if color.len() != 7
        || !color.starts_with('#')
        || !color[1..]
            .chars()
            .all(|character| character.is_ascii_hexdigit())
    {
        return Err("Цвет должен быть в формате #RRGGBB".to_string());
    }
    if !matches!(kind, "useful" | "neutral" | "waste") {
        return Err("Недопустимый тип категории".to_string());
    }

    let connection = open()?;
    let duplicate = connection
        .query_row(
            "SELECT 1 FROM categories WHERE lower(name) = lower(?1)",
            [normalized_name],
            |_| Ok(true),
        )
        .optional()
        .map_err(|error| error.to_string())?
        .unwrap_or(false);
    if duplicate {
        return Err("Категория с таким названием уже существует".to_string());
    }

    let sort_order = connection
        .query_row(
            "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM categories",
            [],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|error| error.to_string())?;
    connection
        .execute(
            "INSERT INTO categories (name, color, icon, kind, goal_multiplier, created_at, sort_order)
             VALUES (?1, ?2, '', ?3, 1.0, ?4, ?5)",
            params![normalized_name, color.to_lowercase(), kind, now_ms(), sort_order],
        )
        .map_err(|error| error.to_string())?;

    Ok(CategoryRecord {
        id: connection.last_insert_rowid(),
        name: normalized_name.to_string(),
        color: color.to_lowercase(),
        icon: String::new(),
        kind: kind.to_string(),
        goal_multiplier: 1.0,
        sort_order,
    })
}

pub fn delete_category(id: i64) -> Result<(), String> {
    if id == 0 {
        return Err("Категорию «Без категории» нельзя удалить".to_string());
    }
    if id < 0 {
        return Err("Недопустимый идентификатор категории".to_string());
    }

    let mut connection = open()?;
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    let affected_dates = {
        let mut statement = transaction
            .prepare(
                "SELECT DISTINCT local_date
                 FROM segment_day_overlaps WHERE category_id = ?1",
            )
            .map_err(|error| error.to_string())?;
        let dates = statement
            .query_map([id], |row| row.get::<_, String>(0))
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
        dates
    };
    let deleted = transaction
        .execute("DELETE FROM categories WHERE id = ?1", [id])
        .map_err(|error| error.to_string())?;
    if deleted == 0 {
        return Err("Категория не найдена".to_string());
    }
    for local_date in affected_dates {
        refresh_daily_stats(&transaction, &local_date)?;
    }
    transaction.commit().map_err(|error| error.to_string())
}

pub fn upsert_exe_rule(
    connection: &Connection,
    app: &str,
    category_id: i64,
) -> Result<i64, String> {
    if category_id == 0 {
        return Err("Без категории нельзя привязать".to_string());
    }

    let normalized_app = app.trim().to_lowercase();
    let existing_id = connection
        .query_row(
            "SELECT id FROM rules
             WHERE match_type = 'exe' AND lower(pattern) = lower(?1)
             ORDER BY id ASC
             LIMIT 1",
            [&normalized_app],
            |row| row.get::<_, i64>(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;

    if let Some(rule_id) = existing_id {
        connection
            .execute(
                "UPDATE rules SET category_id = ?1 WHERE id = ?2",
                params![category_id, rule_id],
            )
            .map_err(|error| error.to_string())?;
        return Ok(rule_id);
    }

    connection
        .execute(
            "INSERT INTO rules (match_type, pattern, category_id, priority, created_at)
             VALUES ('exe', ?1, ?2, 0, ?3)",
            params![normalized_app, category_id, now_ms()],
        )
        .map_err(|error| error.to_string())?;
    Ok(connection.last_insert_rowid())
}

pub fn refresh_daily_stats(transaction: &Transaction<'_>, local_date: &str) -> Result<(), String> {
    transaction
        .execute(
            "DELETE FROM daily_stats WHERE local_date = ?1",
            [local_date],
        )
        .map_err(|error| error.to_string())?;
    transaction
        .execute(
            "INSERT INTO daily_stats (local_date, category_id, duration_ms, xp)
             SELECT o.local_date, o.category_id, SUM(o.duration_ms),
                    CASE WHEN c.kind = 'useful' THEN SUM(o.duration_ms) / 60000 ELSE 0 END
             FROM segment_day_overlaps o
             LEFT JOIN categories c ON c.id = o.category_id
             WHERE o.local_date = ?1
             GROUP BY o.category_id",
            [local_date],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

pub fn segment_local_dates(
    connection: &Connection,
    segment_id: i64,
) -> Result<Vec<String>, String> {
    let mut statement = connection
        .prepare(
            "SELECT local_date FROM segment_day_overlaps
             WHERE segment_id = ?1 ORDER BY local_date",
        )
        .map_err(|error| error.to_string())?;
    let dates = statement
        .query_map([segment_id], |row| row.get::<_, String>(0))
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    Ok(dates)
}

fn rebuild_daily_stats(transaction: &Transaction<'_>) -> Result<(), String> {
    transaction
        .execute("DELETE FROM daily_stats", [])
        .map_err(|error| error.to_string())?;
    transaction
        .execute(
            "INSERT INTO daily_stats (local_date, category_id, duration_ms, xp)
             SELECT o.local_date, o.category_id, SUM(o.duration_ms),
                    CASE WHEN c.kind = 'useful' THEN SUM(o.duration_ms) / 60000 ELSE 0 END
             FROM segment_day_overlaps o
             LEFT JOIN categories c ON c.id = o.category_id
             GROUP BY o.local_date, o.category_id",
            [],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

pub fn progress_series(connection: &Connection) -> Result<Vec<DailyProgressRecord>, String> {
    let mut statement = connection
        .prepare(
            "WITH RECURSIVE calendar(local_date, position) AS (
                SELECT date(
                    'now', 'localtime',
                    '-' || (((CAST(strftime('%w', 'now', 'localtime') AS INTEGER) + 6) % 7) + 77) || ' days'
                ), 0
                UNION ALL
                SELECT date(local_date, '+1 day'), position + 1
                FROM calendar WHERE position < 83
             ), historical AS (
                SELECT ds.local_date,
                       SUM(CASE WHEN c.kind = 'useful' THEN ds.duration_ms ELSE 0 END) AS useful_ms,
                       SUM(CASE WHEN c.kind = 'neutral' THEN ds.duration_ms ELSE 0 END) AS neutral_ms,
                       SUM(CASE WHEN c.kind = 'waste' THEN ds.duration_ms ELSE 0 END) AS waste_ms
                FROM daily_stats ds
                LEFT JOIN categories c ON c.id = ds.category_id
                WHERE ds.local_date BETWEEN date('now', 'localtime', '-' || (?1 - 1) || ' days')
                                        AND date('now', 'localtime', '-1 day')
                GROUP BY ds.local_date
             ), today AS (
                SELECT o.local_date,
                       SUM(CASE WHEN c.kind = 'useful' THEN o.duration_ms ELSE 0 END) AS useful_ms,
                       SUM(CASE WHEN c.kind = 'neutral' THEN o.duration_ms ELSE 0 END) AS neutral_ms,
                       SUM(CASE WHEN c.kind = 'waste' THEN o.duration_ms ELSE 0 END) AS waste_ms
                FROM segment_day_overlaps o
                LEFT JOIN categories c ON c.id = o.category_id
                WHERE o.local_date = date('now', 'localtime')
                GROUP BY o.local_date
             ), totals AS (
                SELECT * FROM historical UNION ALL SELECT * FROM today
             )
             SELECT calendar.local_date,
                    COALESCE(totals.useful_ms, 0),
                    COALESCE(totals.neutral_ms, 0),
                    COALESCE(totals.waste_ms, 0),
                    goals.useful_goal_min,
                    goals.waste_limit_min,
                    goals.observed_min
             FROM calendar
             LEFT JOIN totals ON totals.local_date = calendar.local_date
             JOIN goal_history goals ON goals.effective_local_date = (
                SELECT MAX(history.effective_local_date)
                FROM goal_history history
                WHERE history.effective_local_date <= calendar.local_date
             )
             ORDER BY calendar.local_date",
        )
        .map_err(|error| error.to_string())?;
    let records = statement
        .query_map([84], |row| {
            Ok(DailyProgressRecord {
                local_date: row.get(0)?,
                useful_ms: row.get(1)?,
                neutral_ms: row.get(2)?,
                waste_ms: row.get(3)?,
                useful_goal_min: row.get(4)?,
                waste_limit_min: row.get(5)?,
                observed_min: row.get(6)?,
            })
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    Ok(records)
}

pub fn daily_series(connection: &Connection, days: i64) -> Result<Vec<DailySeriesRecord>, String> {
    if !(1..=366).contains(&days) {
        return Err("days must be between 1 and 366".to_string());
    }

    let mut statement = connection
        .prepare(
            "WITH RECURSIVE calendar(local_date, position) AS (
                SELECT date('now', 'localtime', '-' || (?1 - 1) || ' days'), 0
                UNION ALL
                SELECT date(local_date, '+1 day'), position + 1
                FROM calendar WHERE position < ?1 - 1
             ), historical AS (
                SELECT ds.local_date,
                       SUM(CASE WHEN c.kind = 'useful' THEN ds.duration_ms ELSE 0 END) AS useful_ms,
                       SUM(CASE WHEN c.kind = 'neutral' THEN ds.duration_ms ELSE 0 END) AS neutral_ms,
                       SUM(CASE WHEN c.kind = 'waste' THEN ds.duration_ms ELSE 0 END) AS waste_ms
                FROM daily_stats ds
                LEFT JOIN categories c ON c.id = ds.category_id
                WHERE ds.local_date < date('now', 'localtime')
                GROUP BY ds.local_date
             ), today AS (
                SELECT o.local_date,
                       SUM(CASE WHEN c.kind = 'useful' THEN o.duration_ms ELSE 0 END) AS useful_ms,
                       SUM(CASE WHEN c.kind = 'neutral' THEN o.duration_ms ELSE 0 END) AS neutral_ms,
                       SUM(CASE WHEN c.kind = 'waste' THEN o.duration_ms ELSE 0 END) AS waste_ms
                FROM segment_day_overlaps o
                LEFT JOIN categories c ON c.id = o.category_id
                WHERE o.local_date = date('now', 'localtime')
                GROUP BY o.local_date
             ), totals AS (
                SELECT * FROM historical UNION ALL SELECT * FROM today
             ), filled AS (
                SELECT calendar.local_date,
                       COALESCE(totals.useful_ms, 0) AS useful_ms,
                       COALESCE(totals.neutral_ms, 0) AS neutral_ms,
                       COALESCE(totals.waste_ms, 0) AS waste_ms,
                       goals.useful_goal_min,
                       goals.waste_limit_min,
                       goals.observed_min
                FROM calendar
                LEFT JOIN totals ON totals.local_date = calendar.local_date
                JOIN goal_history goals ON goals.effective_local_date = (
                    SELECT MAX(history.effective_local_date)
                    FROM goal_history history
                    WHERE history.effective_local_date <= calendar.local_date
                )
             )
             SELECT local_date,
                    useful_ms,
                    neutral_ms,
                    waste_ms,
                    useful_ms + neutral_ms + waste_ms AS observed_ms,
                    useful_goal_min,
                    waste_limit_min,
                    observed_min,
                    useful_ms >= useful_goal_min * 60000
                        AND waste_ms <= waste_limit_min * 60000
                        AND useful_ms + neutral_ms + waste_ms >= observed_min * 60000 AS passed,
                    useful_ms / 60000 AS useful_xp,
                    CAST(AVG(useful_ms) OVER (
                        ORDER BY local_date ROWS BETWEEN 6 PRECEDING AND CURRENT ROW
                    ) AS INTEGER) AS useful_ma_7d_ms
             FROM filled
             ORDER BY local_date",
        )
        .map_err(|error| error.to_string())?;
    let records = statement
        .query_map([days], |row| {
            Ok(DailySeriesRecord {
                local_date: row.get(0)?,
                useful_ms: row.get(1)?,
                neutral_ms: row.get(2)?,
                waste_ms: row.get(3)?,
                observed_ms: row.get(4)?,
                useful_goal_min: row.get(5)?,
                waste_limit_min: row.get(6)?,
                observed_min: row.get(7)?,
                passed: row.get::<_, i64>(8)? != 0,
                useful_xp: row.get(9)?,
                useful_ma_7d_ms: row.get(10)?,
            })
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    Ok(records)
}

pub fn today_cumulative(
    connection: &Connection,
    current_ms: i64,
) -> Result<TodayCumulativeRecord, String> {
    let mut statement = connection
        .prepare(
            "WITH RECURSIVE context AS (
                SELECT datetime(?1 / 1000, 'unixepoch', 'localtime', 'start of day') AS local_day,
                       ?1 AS current_ms
             ), bounds AS (
                SELECT current_ms,
                       CAST(strftime('%s', local_day, 'utc') AS INTEGER) * 1000 AS day_start_ms,
                       CAST(strftime('%s', local_day, '+1 day', 'utc') AS INTEGER) * 1000 AS day_end_ms
                FROM context
             ), hours(hour) AS (
                SELECT 0
                UNION ALL
                SELECT hour + 1 FROM hours WHERE hour < 23
             ), buckets AS (
                SELECT hours.hour,
                       CAST(strftime('%s', context.local_day, '+' || hours.hour || ' hours', 'utc') AS INTEGER) * 1000 AS bucket_start_ms,
                       CAST(strftime('%s', context.local_day, '+' || (hours.hour + 1) || ' hours', 'utc') AS INTEGER) * 1000 AS bucket_end_ms,
                       context.current_ms
                FROM hours CROSS JOIN context
             ), hourly AS (
                SELECT buckets.hour,
                       buckets.bucket_end_ms AS timestamp_ms,
                       COALESCE(SUM(CASE WHEN categories.kind = 'useful' THEN
                           MAX(0, MIN(segments.ts_end, buckets.bucket_end_ms, buckets.current_ms) - MAX(segments.ts_start, buckets.bucket_start_ms))
                       ELSE 0 END), 0) AS useful_ms,
                       COALESCE(SUM(CASE WHEN categories.kind = 'waste' THEN
                           MAX(0, MIN(segments.ts_end, buckets.bucket_end_ms, buckets.current_ms) - MAX(segments.ts_start, buckets.bucket_start_ms))
                       ELSE 0 END), 0) AS waste_ms
                FROM buckets
                LEFT JOIN segments
                  ON segments.status IN ('active', 'crashed')
                 AND segments.ts_end > buckets.bucket_start_ms
                 AND segments.ts_start < MIN(buckets.bucket_end_ms, buckets.current_ms)
                LEFT JOIN categories ON categories.id = COALESCE(segments.category_id, 0)
                GROUP BY buckets.hour, buckets.bucket_end_ms
             ), boundary_points AS (
                SELECT day_start_ms AS timestamp_ms, 0 AS hour,
                       0 AS useful_ms, 0 AS waste_ms, 0 AS is_current
                FROM bounds
                UNION ALL
                SELECT timestamp_ms, hour + 1,
                       SUM(useful_ms) OVER (ORDER BY hour),
                       SUM(waste_ms) OVER (ORDER BY hour),
                       0
                FROM hourly
             ), current_point AS (
                SELECT bounds.current_ms AS timestamp_ms,
                       CAST(strftime('%H', bounds.current_ms / 1000, 'unixepoch', 'localtime') AS INTEGER) AS hour,
                       COALESCE(SUM(CASE WHEN categories.kind = 'useful' THEN
                           MAX(0, MIN(segments.ts_end, bounds.current_ms, bounds.day_end_ms) - MAX(segments.ts_start, bounds.day_start_ms))
                       ELSE 0 END), 0) AS useful_ms,
                       COALESCE(SUM(CASE WHEN categories.kind = 'waste' THEN
                           MAX(0, MIN(segments.ts_end, bounds.current_ms, bounds.day_end_ms) - MAX(segments.ts_start, bounds.day_start_ms))
                       ELSE 0 END), 0) AS waste_ms,
                       1 AS is_current
                FROM bounds
                LEFT JOIN segments
                  ON segments.status IN ('active', 'crashed')
                 AND segments.ts_end > bounds.day_start_ms
                 AND segments.ts_start < MIN(bounds.current_ms, bounds.day_end_ms)
                LEFT JOIN categories ON categories.id = COALESCE(segments.category_id, 0)
             )
             SELECT timestamp_ms, hour, useful_ms, waste_ms, is_current
             FROM boundary_points
             UNION ALL
             SELECT timestamp_ms, hour, useful_ms, waste_ms, is_current
             FROM current_point
             ORDER BY timestamp_ms, is_current",
        )
        .map_err(|error| error.to_string())?;
    let points = statement
        .query_map([current_ms], |row| {
            Ok(CumulativePointRecord {
                timestamp_ms: row.get(0)?,
                hour: row.get(1)?,
                useful_ms: row.get(2)?,
                waste_ms: row.get(3)?,
                is_current: row.get::<_, i64>(4)? != 0,
            })
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    let (useful_goal_min, waste_limit_min) = connection
        .query_row(
            "SELECT useful_goal_min, waste_limit_min
             FROM goal_history
             WHERE effective_local_date <= date(?1 / 1000, 'unixepoch', 'localtime')
             ORDER BY effective_local_date DESC
             LIMIT 1",
            [current_ms],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|error| error.to_string())?;

    Ok(TodayCumulativeRecord {
        points,
        useful_goal_min,
        waste_limit_min,
    })
}

#[cfg(test)]
mod tests {
    use super::{
        daily_series, import_challenge, progress_series, refresh_daily_stats, segment_local_dates,
        set_setting, today_cumulative, upsert_exe_rule, MIGRATION_001, MIGRATION_002,
        MIGRATION_003,
    };
    use rusqlite::{params, Connection};

    #[test]
    fn upserts_exe_rule_case_insensitively() {
        let connection = Connection::open_in_memory().expect("in-memory database");
        connection.execute_batch(MIGRATION_001).expect("schema");
        for (id, name) in [(1, "Work"), (2, "Chill")] {
            connection
                .execute(
                    "INSERT INTO categories (id, name, color, kind, created_at) VALUES (?1, ?2, '#000000', 'neutral', 0)",
                    params![id, name],
                )
                .expect("category");
        }

        let rule_id = upsert_exe_rule(&connection, "Example.EXE", 1).expect("insert rule");
        let updated_id = upsert_exe_rule(&connection, "example.exe", 2).expect("update rule");

        assert_eq!(updated_id, rule_id);
        let stored = connection
            .query_row(
                "SELECT match_type, pattern, category_id FROM rules WHERE id = ?1",
                [rule_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, i64>(2)?,
                    ))
                },
            )
            .expect("stored rule");
        assert_eq!(stored, ("exe".to_string(), "example.exe".to_string(), 2));
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM rules", [], |row| row.get::<_, i64>(0))
                .expect("rule count"),
            1
        );
    }

    #[test]
    fn rejects_uncategorized_exe_rule() {
        let connection = Connection::open_in_memory().expect("in-memory database");
        connection.execute_batch(MIGRATION_001).expect("schema");

        assert_eq!(
            upsert_exe_rule(&connection, "example.exe", 0),
            Err("Без категории нельзя привязать".to_string())
        );
    }

    #[test]
    fn upserts_setting() {
        let connection = Connection::open_in_memory().expect("in-memory database");
        connection.execute_batch(MIGRATION_001).expect("schema");

        set_setting(&connection, "extension_chrome_id", "first").expect("insert setting");
        set_setting(&connection, "extension_chrome_id", "second").expect("update setting");

        assert_eq!(
            connection
                .query_row(
                    "SELECT value FROM settings WHERE key = 'extension_chrome_id'",
                    [],
                    |row| row.get::<_, String>(0),
                )
                .expect("stored setting"),
            "second"
        );
    }

    fn score_schema() -> Connection {
        let connection = Connection::open_in_memory().expect("in-memory database");
        connection
            .execute_batch(MIGRATION_001)
            .expect("base schema");
        for (key, value) in [
            ("useful_goal_min", "120"),
            ("waste_limit_min", "60"),
            ("observed_min", "60"),
        ] {
            connection
                .execute(
                    "INSERT INTO settings (key, value) VALUES (?1, ?2)",
                    [key, value],
                )
                .expect("setting");
        }
        connection
            .execute_batch(MIGRATION_002)
            .expect("score schema");
        connection
            .execute_batch(MIGRATION_003)
            .expect("day print schema");
        connection
    }

    #[test]
    fn imports_challenge_as_today_goals_and_rejects_invalid_codes() {
        let connection = score_schema();

        let imported = import_challenge(&connection, "TF-184-43-60").expect("challenge");

        assert_eq!(imported, (184, 43, 60));
        assert_eq!(
            connection
                .query_row(
                    "SELECT useful_goal_min, waste_limit_min, observed_min
                     FROM goal_history WHERE effective_local_date = date('now', 'localtime')",
                    [],
                    |row| Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, i64>(2)?
                    )),
                )
                .expect("effective goals"),
            (184, 43, 60)
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT code FROM challenge_history WHERE local_date = date('now', 'localtime')",
                    [],
                    |row| row.get::<_, String>(0),
                )
                .expect("stored challenge"),
            "TF-184-43-60"
        );
        assert!(import_challenge(&connection, "tf-184-43-60").is_err());
        assert!(import_challenge(&connection, " TF-184-43-60 ").is_err());
        assert!(import_challenge(&connection, "TF-184-43").is_err());
        assert!(import_challenge(&connection, "TF-1441-43-60").is_err());
    }

    fn local_ms(connection: &Connection, local_datetime: &str) -> i64 {
        connection
            .query_row(
                "SELECT CAST(strftime('%s', ?1, 'utc') AS INTEGER) * 1000",
                [local_datetime],
                |row| row.get(0),
            )
            .expect("local timestamp")
    }

    #[test]
    fn cumulative_today_splits_segments_across_local_hours() {
        let connection = score_schema();
        for (start, end, category_id, kind, status) in [
            (
                "2026-08-10 10:45:00",
                "2026-08-10 12:15:00",
                1,
                "useful",
                "active",
            ),
            (
                "2026-08-10 11:30:00",
                "2026-08-10 13:10:00",
                2,
                "waste",
                "crashed",
            ),
        ] {
            connection
                .execute(
                    "INSERT INTO categories (id, name, color, kind, created_at)
                     VALUES (?1, ?2, '#000000', ?3, 0)",
                    params![category_id, kind, kind],
                )
                .expect("category");
            connection
                .execute(
                    "INSERT INTO segments (ts_start, ts_end, app, category_id, status)
                     VALUES (?1, ?2, 'example.exe', ?3, ?4)",
                    params![
                        local_ms(&connection, start),
                        local_ms(&connection, end),
                        category_id,
                        status,
                    ],
                )
                .expect("segment");
        }

        let current_ms = local_ms(&connection, "2026-08-10 14:30:00");
        let cumulative = today_cumulative(&connection, current_ms).expect("cumulative series");
        let at_hour = |hour: i64| {
            cumulative
                .points
                .iter()
                .find(|point| point.hour == hour && !point.is_current)
                .expect("hour boundary")
        };

        assert_eq!((at_hour(11).useful_ms, at_hour(11).waste_ms), (900_000, 0));
        assert_eq!(
            (at_hour(12).useful_ms, at_hour(12).waste_ms),
            (4_500_000, 1_800_000)
        );
        assert_eq!(
            (at_hour(13).useful_ms, at_hour(13).waste_ms),
            (5_400_000, 5_400_000)
        );
        assert_eq!(
            cumulative
                .points
                .iter()
                .find(|point| point.is_current)
                .map(|point| (point.useful_ms, point.waste_ms)),
            Some((5_400_000, 6_000_000))
        );
        assert_eq!(cumulative.useful_goal_min, 120);
        assert_eq!(cumulative.waste_limit_min, 60);
    }

    #[test]
    fn cumulative_today_clips_midnight_and_ignores_non_observed_statuses() {
        let connection = score_schema();
        connection
            .execute(
                "INSERT INTO categories (id, name, color, kind, created_at)
                 VALUES (1, 'Work', '#000000', 'useful', 0)",
                [],
            )
            .expect("category");
        for (start, end, status) in [
            ("2026-08-09 23:30:00", "2026-08-10 00:30:00", "crashed"),
            ("2026-08-10 00:15:00", "2026-08-10 00:45:00", "away"),
        ] {
            connection
                .execute(
                    "INSERT INTO segments (ts_start, ts_end, app, category_id, status)
                     VALUES (?1, ?2, 'example.exe', 1, ?3)",
                    params![
                        local_ms(&connection, start),
                        local_ms(&connection, end),
                        status
                    ],
                )
                .expect("segment");
        }

        let cumulative =
            today_cumulative(&connection, local_ms(&connection, "2026-08-10 01:30:00"))
                .expect("cumulative series");

        assert_eq!(cumulative.points.len(), 26);
        assert_eq!(
            cumulative
                .points
                .iter()
                .find(|point| point.hour == 1 && !point.is_current)
                .map(|point| (point.useful_ms, point.waste_ms)),
            Some((1_800_000, 0))
        );
    }

    #[test]
    fn splits_segment_duration_across_local_midnight() {
        let mut connection = score_schema();
        connection
            .execute(
                "INSERT INTO segments (
                    ts_start, ts_end, app, category_id, status
                 ) VALUES (
                    strftime('%s', '2026-08-09 23:50:00', 'utc') * 1000,
                    strftime('%s', '2026-08-10 00:20:00', 'utc') * 1000,
                    'Code.exe', 0, 'crashed'
                 )",
                [],
            )
            .expect("segment");
        let segment_id = connection.last_insert_rowid();

        assert_eq!(
            segment_local_dates(&connection, segment_id).expect("dates"),
            vec!["2026-08-09".to_string(), "2026-08-10".to_string()]
        );
        let transaction = connection.transaction().expect("transaction");
        refresh_daily_stats(&transaction, "2026-08-09").expect("first day");
        refresh_daily_stats(&transaction, "2026-08-10").expect("second day");
        transaction.commit().expect("commit");
        let durations = connection
            .prepare("SELECT duration_ms FROM daily_stats ORDER BY local_date")
            .expect("query")
            .query_map([], |row| row.get::<_, i64>(0))
            .expect("rows")
            .collect::<Result<Vec<_>, _>>()
            .expect("durations");
        assert_eq!(durations, vec![600_000, 1_200_000]);
    }

    #[test]
    fn goal_changes_preserve_the_prior_effective_day() {
        let connection = score_schema();
        set_setting(&connection, "useful_goal_min", "180").expect("new goal");

        let goals = connection
            .prepare(
                "SELECT effective_local_date, useful_goal_min
                 FROM goal_history ORDER BY effective_local_date",
            )
            .expect("query")
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
            })
            .expect("rows")
            .collect::<Result<Vec<_>, _>>()
            .expect("goals");
        assert_eq!(goals.len(), 2);
        assert_eq!(goals[0].1, 120);
        assert_eq!(goals[1].1, 180);
        let series = progress_series(&connection).expect("series");
        assert_eq!(series.len(), 84);
        let (yesterday, today) = connection
            .query_row(
                "SELECT date('now', 'localtime', '-1 day'), date('now', 'localtime')",
                [],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .expect("dates");
        assert_eq!(
            series
                .iter()
                .find(|day| day.local_date == yesterday)
                .expect("yesterday")
                .useful_goal_min,
            120,
            "the prior day keeps the prior goal"
        );
        assert_eq!(
            series
                .iter()
                .find(|day| day.local_date == today)
                .expect("today")
                .useful_goal_min,
            180,
            "today uses the new goal"
        );
    }

    #[test]
    fn daily_series_zero_fills_dates_and_joins_effective_goals() {
        let connection = score_schema();
        connection
            .execute(
                "INSERT INTO goal_history (
                    effective_local_date, useful_goal_min, waste_limit_min, observed_min
                 ) VALUES (date('now', 'localtime', '-2 days'), 180, 45, 90)",
                [],
            )
            .expect("historical goal");
        connection
            .execute(
                "INSERT INTO categories (id, name, color, kind, created_at)
                 VALUES (1, 'Work', '#000000', 'useful', 0)",
                [],
            )
            .expect("category");
        connection
            .execute(
                "INSERT INTO daily_stats (local_date, category_id, duration_ms, xp)
                 VALUES (date('now', 'localtime', '-1 day'), 1, 10800000, 180)",
                [],
            )
            .expect("daily stats");

        let series = daily_series(&connection, 4).expect("daily series");

        assert_eq!(series.len(), 4);
        assert_eq!(series[0].useful_ms, 0, "missing dates are zero-filled");
        assert_eq!(series[1].useful_goal_min, 180);
        assert_eq!(series[1].waste_limit_min, 45);
        assert_eq!(series[1].observed_min, 90);
        assert_eq!(series[2].useful_xp, 180);
        assert_eq!(series[2].observed_ms, 10_800_000);
        assert!(series[2].passed);
    }

    #[test]
    fn daily_series_uses_six_lead_in_days_for_the_first_displayed_average() {
        let connection = score_schema();
        connection
            .execute(
                "INSERT INTO categories (id, name, color, kind, created_at)
                 VALUES (1, 'Work', '#000000', 'useful', 0)",
                [],
            )
            .expect("category");
        for offset in 29..=35 {
            connection
                .execute(
                    "INSERT INTO daily_stats (local_date, category_id, duration_ms, xp)
                     VALUES (date('now', 'localtime', '-' || ?1 || ' days'), 1, ?2, ?2 / 60000)",
                    params![offset, (36 - offset) * 60_000],
                )
                .expect("daily stats");
        }

        let source = daily_series(&connection, 36).expect("36 source days");

        assert_eq!(source.len(), 36);
        assert_eq!(
            source[6].useful_ma_7d_ms,
            4 * 60_000,
            "index 6 is the first displayed day and averages all seven source days"
        );
    }
}
