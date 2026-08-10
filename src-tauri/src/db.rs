use rusqlite::{params, Connection, OptionalExtension, Transaction};
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};
use uuid::Uuid;

const MIGRATION: &str = include_str!("../migrations/001_init.sql");

pub struct CategoryRecord {
    pub id: i64,
    pub name: String,
    pub color: String,
    pub icon: String,
    pub kind: String,
    pub goal_multiplier: f64,
    pub sort_order: i64,
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
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    transaction
        .execute_batch(MIGRATION)
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
        .query_row("SELECT value FROM settings WHERE key = ?1", [key], |row| {
            row.get(0)
        })
        .optional()
        .map_err(|error| error.to_string())
}

pub fn set_setting(connection: &Connection, key: &str, value: &str) -> Result<(), String> {
    connection
        .execute(
            "INSERT INTO settings (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, value],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
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
                "SELECT DISTINCT date(ts_start / 1000, 'unixepoch', 'localtime')
                 FROM segments WHERE category_id = ?1",
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
             SELECT date(s.ts_start / 1000, 'unixepoch', 'localtime'), COALESCE(s.category_id, 0),
                    SUM(MAX(0, s.ts_end - s.ts_start)),
                    CASE WHEN c.kind = 'useful' THEN SUM(MAX(0, s.ts_end - s.ts_start)) / 60000 ELSE 0 END
             FROM segments s
             LEFT JOIN categories c ON c.id = COALESCE(s.category_id, 0)
             WHERE date(s.ts_start / 1000, 'unixepoch', 'localtime') = ?1
               AND s.status IN ('active', 'crashed')
             GROUP BY COALESCE(s.category_id, 0)",
            [local_date],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{set_setting, upsert_exe_rule, MIGRATION};
    use rusqlite::{params, Connection};

    #[test]
    fn upserts_exe_rule_case_insensitively() {
        let connection = Connection::open_in_memory().expect("in-memory database");
        connection.execute_batch(MIGRATION).expect("schema");
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
        connection.execute_batch(MIGRATION).expect("schema");

        assert_eq!(
            upsert_exe_rule(&connection, "example.exe", 0),
            Err("Без категории нельзя привязать".to_string())
        );
    }

    #[test]
    fn upserts_setting() {
        let connection = Connection::open_in_memory().expect("in-memory database");
        connection.execute_batch(MIGRATION).expect("schema");

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
}
