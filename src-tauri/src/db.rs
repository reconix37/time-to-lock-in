use rusqlite::{params, Connection, OptionalExtension, Transaction};
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};
use uuid::Uuid;

const MIGRATION: &str = include_str!("../migrations/001_init.sql");

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
    let transaction = connection.transaction().map_err(|error| error.to_string())?;
    transaction
        .execute_batch(MIGRATION)
        .map_err(|error| error.to_string())?;

    let timestamp = now_ms();
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

    for (key, value) in [
        ("useful_goal_min", "120".to_string()),
        ("waste_limit_min", "60".to_string()),
        ("observed_min", "60".to_string()),
        ("idle_timeout_min", "5".to_string()),
        ("theme", "dawn".to_string()),
        ("onboarding_done", "0".to_string()),
        ("extension_token", Uuid::new_v4().to_string()),
        ("extension_chrome_id", String::new()),
        ("extension_edge_id", String::new()),
    ] {
        transaction
            .execute(
                "INSERT OR IGNORE INTO settings (key, value) VALUES (?1, ?2)",
                params![key, value],
            )
            .map_err(|error| error.to_string())?;
    }

    let crashed_date = transaction
        .query_row(
            "SELECT date(ts_start / 1000, 'unixepoch', 'localtime')
             FROM segments
             WHERE id = CAST((SELECT value FROM settings WHERE key = 'active_segment_id') AS INTEGER)
               AND status = 'active'",
            [],
            |row| row.get::<_, String>(0),
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
    if let Some(local_date) = crashed_date {
        refresh_daily_stats(&transaction, &local_date)?;
    }
    transaction
        .execute("DELETE FROM settings WHERE key = 'active_segment_id'", [])
        .map_err(|error| error.to_string())?;
    transaction
        .execute_batch("PRAGMA user_version=1;")
        .map_err(|error| error.to_string())?;
    transaction.commit().map_err(|error| error.to_string())
}

pub fn setting(connection: &Connection, key: &str) -> Result<Option<String>, String> {
    connection
        .query_row(
            "SELECT value FROM settings WHERE key = ?1",
            [key],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| error.to_string())
}

pub fn refresh_daily_stats(
    transaction: &Transaction<'_>,
    local_date: &str,
) -> Result<(), String> {
    transaction
        .execute("DELETE FROM daily_stats WHERE local_date = ?1", [local_date])
        .map_err(|error| error.to_string())?;
    transaction
        .execute(
            "INSERT INTO daily_stats (local_date, category_id, duration_ms, xp)
             SELECT date(s.ts_start / 1000, 'unixepoch', 'localtime'), s.category_id,
                    SUM(MAX(0, s.ts_end - s.ts_start)),
                    CASE WHEN c.kind = 'useful' THEN SUM(MAX(0, s.ts_end - s.ts_start)) / 60000 ELSE 0 END
             FROM segments s
             JOIN categories c ON c.id = s.category_id
             WHERE date(s.ts_start / 1000, 'unixepoch', 'localtime') = ?1
               AND s.status IN ('active', 'crashed')
             GROUP BY s.category_id",
            [local_date],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}
