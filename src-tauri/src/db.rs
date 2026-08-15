use rusqlite::{params, Connection, OptionalExtension, Transaction};
use std::collections::HashMap;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};
use uuid::Uuid;

use crate::rules::{Activity, RuleDefinition, RuleSet};

const MIGRATION_001: &str = include_str!("../migrations/001_init.sql");
const MIGRATION_002: &str = include_str!("../migrations/002_score_day.sql");
const MIGRATION_003: &str = include_str!("../migrations/003_day_print.sql");
const MIGRATION_004: &str = include_str!("../migrations/004_reclassify_history.sql");
const MIGRATION_005: &str = include_str!("../migrations/005_categories_scoring.sql");
const MIGRATION_006: &str = include_str!("../migrations/006_rule_uniqueness.sql");

const TITLE_NOISE_WORDS: &[&str] = &[
    "смотреть",
    "смотрите",
    "сериал",
    "фильм",
    "онлайн",
    "бесплатно",
    "в",
    "хорошем",
    "качестве",
    "все",
    "watch",
    "online",
    "free",
    "hd",
    "full",
    "film",
    "movie",
    "series",
    "in",
    "good",
    "quality",
    "4k",
    "1080p",
    "720p",
];
const EPISODE_WORDS: &[&str] = &["серия", "серии", "серий", "эпизод", "episode", "episodes"];
const SEASON_WORDS: &[&str] = &["сезон", "season"];

pub(crate) fn title_matches(pattern: &str, title: &str) -> bool {
    title_matches_with_case(pattern, title, true)
}

pub(crate) fn title_matches_with_case(pattern: &str, title: &str, case_insensitive: bool) -> bool {
    let normalized_pattern = if case_insensitive {
        pattern.to_lowercase()
    } else {
        pattern.to_string()
    };
    let normalized_title = if case_insensitive {
        title.to_lowercase()
    } else {
        title.to_string()
    };
    let tokens = normalized_pattern
        .split(|character: char| !character.is_alphanumeric())
        .filter(|token| !token.is_empty())
        .collect::<Vec<_>>();
    let significant_tokens = tokens
        .iter()
        .enumerate()
        .filter_map(|(index, token)| {
            let is_number = token.chars().all(|character| character.is_ascii_digit());
            let previous = index
                .checked_sub(1)
                .and_then(|previous| tokens.get(previous));
            let next = tokens.get(index + 1);
            let beside_episode = is_number
                && (previous.is_some_and(|previous| EPISODE_WORDS.contains(previous))
                    || next.is_some_and(|next| EPISODE_WORDS.contains(next)));
            let beside_season = is_number
                && (previous.is_some_and(|previous| SEASON_WORDS.contains(previous))
                    || next.is_some_and(|next| SEASON_WORDS.contains(next)));
            ((token.chars().count() >= 2 || beside_season)
                && !TITLE_NOISE_WORDS.contains(token)
                && !EPISODE_WORDS.contains(token)
                && !beside_episode)
                .then_some(*token)
        })
        .collect::<Vec<_>>();

    if significant_tokens.is_empty() {
        return normalized_title.contains(&normalized_pattern);
    }

    // Ручные title-правила тоже получают AND-поиск: порядок слов и разделители не важны.
    significant_tokens
        .iter()
        .all(|token| normalized_title.contains(token))
}

pub struct CategoryRecord {
    pub id: i64,
    pub name: String,
    pub color: String,
    pub icon: String,
    pub kind: String,
    pub goal_multiplier: f64,
    pub sort_order: i64,
    pub parent_id: Option<i64>,
    pub score: f64,
    pub inherit_color: bool,
    pub inherit_score: bool,
    pub effective_color: String,
    pub effective_score: f64,
    pub full_path: String,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ScoringCategoryRecord {
    pub category_id: i64,
    pub name: String,
    pub full_path: String,
    pub effective_color: String,
    pub duration_ms: i64,
    pub points: f64,
}

#[derive(Debug, PartialEq)]
pub struct TodayScoringRecord {
    pub total_score: f64,
    pub productive_percent: f64,
    pub top_productive: Vec<ScoringCategoryRecord>,
    pub top_distracting: Vec<ScoringCategoryRecord>,
    pub top_categories: Vec<ScoringCategoryRecord>,
}

#[derive(Debug, PartialEq)]
pub struct ReclassificationSummary {
    pub changed_segments: i64,
    pub changed_duration_ms: i64,
}

#[derive(Debug, PartialEq)]
pub struct ClassificationMatchStats {
    pub match_count: i64,
    pub manual_count: i64,
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
pub struct AfkDayRecord {
    pub local_date: String,
    pub afk_ms: i64,
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

#[derive(Debug, PartialEq)]
pub struct MiniHourlyRecord {
    pub hour_ts: i64,
    pub useful_ms: i64,
    pub neutral_ms: i64,
    pub waste_ms: i64,
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
        ("language", "ru".to_string()),
        ("onboarding_done", "0".to_string()),
        ("tray_only", "1".to_string()),
        ("mini_pinned", "1".to_string()),
        ("mini_visible", "0".to_string()),
        ("mini_mode", "auto".to_string()),
        ("mini_text_size", "normal".to_string()),
        ("mini_privacy_now", "0".to_string()),
        ("mini_opacity", "100".to_string()),
        ("mini_corner", String::new()),
        ("currency", "₴".to_string()),
        ("extension_token", Uuid::new_v4().to_string()),
        ("extension_chrome_id", String::new()),
        ("extension_edge_id", String::new()),
        ("kind_label_useful", "Полезное".to_string()),
        ("kind_label_neutral", "Нейтральное".to_string()),
        ("kind_label_waste", "Потери".to_string()),
        ("kind_label_observed", "Наблюдение".to_string()),
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
    if previous_version < 5 {
        transaction
            .execute_batch(MIGRATION_005)
            .map_err(|error| error.to_string())?;
    }
    if previous_version < 6 {
        transaction
            .execute_batch(MIGRATION_006)
            .map_err(|error| error.to_string())?;
    }
    if previous_version < 4 {
        transaction
            .execute_batch(MIGRATION_004)
            .map_err(|error| error.to_string())?;
        if previous_version > 0 {
            preserve_legacy_manual_categories(&transaction)?;
            // До v4 значение 0 было дефолтом, поэтому апгрейд включает новый pinned-дефолт.
            transaction
                .execute(
                    "UPDATE settings SET value = '1'
                     WHERE key = 'mini_pinned' AND value = '0'",
                    [],
                )
                .map_err(|error| error.to_string())?;
        }
        reclassify_history_in_transaction(&transaction, false, None)?;
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
        .execute_batch("PRAGMA user_version=6;")
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

#[derive(Clone, Copy)]
pub struct CategoryValues<'a> {
    pub name: &'a str,
    pub color: &'a str,
    pub kind: &'a str,
    pub parent_id: Option<i64>,
    pub score: f64,
    pub inherit_color: bool,
    pub inherit_score: bool,
}

fn validate_category_values(values: CategoryValues<'_>) -> Result<(), String> {
    let normalized_name = values.name.trim();
    if normalized_name.is_empty() || normalized_name.chars().count() > 80 {
        return Err("Название должно содержать от 1 до 80 символов".to_string());
    }
    if values.color.len() != 7
        || !values.color.starts_with('#')
        || !values.color[1..]
            .chars()
            .all(|character| character.is_ascii_hexdigit())
    {
        return Err("Цвет должен быть в формате #RRGGBB".to_string());
    }
    if !matches!(values.kind, "useful" | "neutral" | "waste") {
        return Err("Недопустимый тип категории".to_string());
    }
    if !values.score.is_finite() || !(-10.0..=10.0).contains(&values.score) {
        return Err("Score должен быть от -10 до 10".to_string());
    }
    if values.parent_id.is_none() && (values.inherit_color || values.inherit_score) {
        return Err("Корневая категория не может наследовать цвет или score".to_string());
    }
    if values.parent_id.is_some_and(|parent_id| parent_id <= 0) {
        return Err("Недопустимый родитель категории".to_string());
    }
    Ok(())
}

fn validate_category_tree(
    connection: &Connection,
    category_id: Option<i64>,
    parent_id: Option<i64>,
) -> Result<(), String> {
    if category_id.is_some() && category_id == parent_id {
        return Err("category cycle".to_string());
    }
    if let Some(parent_id) = parent_id {
        let exists = connection
            .query_row(
                "SELECT 1 FROM categories WHERE id = ?1",
                [parent_id],
                |_| Ok(true),
            )
            .optional()
            .map_err(|error| error.to_string())?
            .unwrap_or(false);
        if !exists {
            return Err("parent category does not exist".to_string());
        }
    }
    let mut parents = connection
        .prepare("SELECT id, parent_id FROM categories WHERE id <> 0")
        .map_err(|error| error.to_string())?
        .query_map([], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, Option<i64>>(1)?))
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<HashMap<_, _>, _>>()
        .map_err(|error| error.to_string())?;
    let target_id = category_id.unwrap_or_else(|| parents.keys().max().copied().unwrap_or(0) + 1);
    parents.insert(target_id, parent_id);
    for start in parents.keys() {
        let mut seen = Vec::new();
        let mut current = Some(*start);
        while let Some(id) = current {
            if seen.contains(&id) {
                return Err("category cycle".to_string());
            }
            seen.push(id);
            if seen.len() > 3 {
                return Err("category depth exceeds 3 levels".to_string());
            }
            current = parents.get(&id).copied().flatten();
        }
    }
    Ok(())
}

pub fn list_categories(connection: &Connection) -> Result<Vec<CategoryRecord>, String> {
    let mut statement = connection
        .prepare(
            "WITH RECURSIVE category_tree (
                id, name, color, icon, kind, goal_multiplier, sort_order, parent_id,
                score, inherit_color, inherit_score, effective_color, effective_score,
                full_path, depth
             ) AS (
                SELECT id, name, color, icon, kind, goal_multiplier, sort_order, parent_id,
                       score, inherit_color, inherit_score, color, score, name, 1
                FROM categories WHERE parent_id IS NULL
                UNION ALL
                SELECT child.id, child.name, child.color, child.icon, child.kind,
                       child.goal_multiplier, child.sort_order, child.parent_id, child.score,
                       child.inherit_color, child.inherit_score,
                       CASE WHEN child.inherit_color = 1 THEN parent.effective_color ELSE child.color END,
                       CASE WHEN child.inherit_score = 1 THEN parent.effective_score ELSE child.score END,
                       parent.full_path || ' > ' || child.name, parent.depth + 1
                FROM categories child
                JOIN category_tree parent ON child.parent_id = parent.id
             )
             SELECT id, name, color, icon, kind, goal_multiplier, sort_order, parent_id,
                    score, inherit_color, inherit_score, effective_color, effective_score,
                    full_path
             FROM category_tree ORDER BY full_path COLLATE NOCASE",
        )
        .map_err(|error| error.to_string())?;
    let categories = statement
        .query_map([], |row| {
            Ok(CategoryRecord {
                id: row.get(0)?,
                name: row.get(1)?,
                color: row.get(2)?,
                icon: row.get(3)?,
                kind: row.get(4)?,
                goal_multiplier: row.get(5)?,
                sort_order: row.get(6)?,
                parent_id: row.get(7)?,
                score: row.get(8)?,
                inherit_color: row.get::<_, i64>(9)? == 1,
                inherit_score: row.get::<_, i64>(10)? == 1,
                effective_color: row.get(11)?,
                effective_score: row.get(12)?,
                full_path: row.get(13)?,
            })
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    Ok(categories)
}

fn category_by_id(connection: &Connection, id: i64) -> Result<CategoryRecord, String> {
    list_categories(connection)?
        .into_iter()
        .find(|category| category.id == id)
        .ok_or_else(|| "Категория не найдена".to_string())
}

pub fn create_category(values: CategoryValues<'_>) -> Result<CategoryRecord, String> {
    validate_category_values(values)?;
    let normalized_name = values.name.trim();

    let connection = open()?;
    validate_category_tree(&connection, None, values.parent_id)?;
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
            "INSERT INTO categories (
                name, color, icon, kind, goal_multiplier, created_at, sort_order,
                parent_id, score, inherit_color, inherit_score
             ) VALUES (?1, ?2, '', ?3, 1.0, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                normalized_name,
                values.color.to_lowercase(),
                values.kind,
                now_ms(),
                sort_order,
                values.parent_id,
                values.score,
                i64::from(values.inherit_color),
                i64::from(values.inherit_score),
            ],
        )
        .map_err(|error| error.to_string())?;
    category_by_id(&connection, connection.last_insert_rowid())
}

pub fn update_category(id: i64, values: CategoryValues<'_>) -> Result<CategoryRecord, String> {
    if id <= 0 {
        return Err("Недопустимый идентификатор категории".to_string());
    }
    validate_category_values(values)?;
    let normalized_name = values.name.trim();
    let connection = open()?;
    validate_category_tree(&connection, Some(id), values.parent_id)?;
    let updated = connection
        .execute(
            "UPDATE categories SET name = ?1, color = ?2, kind = ?3, parent_id = ?4,
                    score = ?5, inherit_color = ?6, inherit_score = ?7
             WHERE id = ?8",
            params![
                normalized_name,
                values.color.to_lowercase(),
                values.kind,
                values.parent_id,
                values.score,
                i64::from(values.inherit_color),
                i64::from(values.inherit_score),
                id,
            ],
        )
        .map_err(|error| error.to_string())?;
    if updated == 0 {
        return Err("Категория не найдена".to_string());
    }
    category_by_id(&connection, id)
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
    priority: i64,
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
                "UPDATE rules SET category_id = ?1, priority = ?2 WHERE id = ?3",
                params![category_id, priority, rule_id],
            )
            .map_err(|error| error.to_string())?;
        bump_rules_revision(connection)?;
        return Ok(rule_id);
    }

    connection
        .execute(
            "INSERT INTO rules (match_type, pattern, category_id, priority, created_at)
             VALUES ('exe', ?1, ?2, ?3, ?4)",
            params![normalized_app, category_id, priority, now_ms()],
        )
        .map_err(|error| error.to_string())?;
    let rule_id = connection.last_insert_rowid();
    bump_rules_revision(connection)?;
    Ok(rule_id)
}

pub fn bump_rules_revision(connection: &Connection) -> Result<i64, String> {
    connection
        .execute(
            "INSERT INTO settings(key, value) VALUES ('rules_revision', '1')
             ON CONFLICT(key) DO UPDATE SET value = CAST(value AS INTEGER) + 1",
            [],
        )
        .map_err(|error| error.to_string())?;
    setting(connection, "rules_revision")?
        .unwrap_or_else(|| "0".to_string())
        .parse::<i64>()
        .map_err(|error| error.to_string())
}

pub fn rules_revision(connection: &Connection) -> Result<i64, String> {
    Ok(setting(connection, "rules_revision")?
        .unwrap_or_else(|| "0".to_string())
        .parse::<i64>()
        .unwrap_or(0))
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

fn preserve_legacy_manual_categories(transaction: &Transaction<'_>) -> Result<(), String> {
    let rules = transaction
        .prepare(
            "SELECT match_type, pattern, category_id
             FROM rules
             ORDER BY priority DESC,
                      CASE match_type WHEN 'domain' THEN 3 WHEN 'title' THEN 2 ELSE 1 END DESC,
                      id ASC",
        )
        .map_err(|error| error.to_string())?
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?.to_lowercase(),
                row.get::<_, i64>(2)?,
            ))
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    let manual_ids = transaction
        .prepare(
            "SELECT id, app, window_title, domain, category_id
             FROM segments WHERE COALESCE(category_id, 0) <> 0",
        )
        .map_err(|error| error.to_string())?
        .query_map([], |row| {
            let app = row.get::<_, String>(1)?.to_lowercase();
            let title = row.get::<_, String>(2)?;
            let domain = row.get::<_, String>(3)?.to_lowercase();
            let current_category_id = row.get::<_, i64>(4)?;
            let rule_category_id = rules
                .iter()
                .find(|(match_type, pattern, _)| match match_type.as_str() {
                    "domain" => domain.contains(pattern),
                    "title" => title_matches(pattern, &title),
                    "exe" => app.starts_with(pattern),
                    _ => false,
                })
                .map_or(0, |(_, _, category_id)| *category_id);
            Ok((row.get::<_, i64>(0)?, current_category_id, rule_category_id))
        })
        .map_err(|error| error.to_string())?
        .filter_map(|result| match result {
            Ok((segment_id, current, classified)) if current != classified => Some(Ok(segment_id)),
            Ok(_) => None,
            Err(error) => Some(Err(error)),
        })
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    for segment_id in manual_ids {
        transaction
            .execute(
                "UPDATE segments SET manual_category = 1 WHERE id = ?1",
                [segment_id],
            )
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn reclassification_changes(
    connection: &Connection,
    overwrite_manual: bool,
    manual_rule_scope: Option<(&str, &str)>,
) -> Result<Vec<(i64, i64, i64)>, String> {
    let rules = RuleSet::load(connection)?;
    let manual_scope = manual_rule_scope
        .map(|(match_type, pattern)| {
            RuleSet::compile(vec![RuleDefinition {
                id: 0,
                match_type: match_type.to_string(),
                pattern: pattern.to_string(),
                category_id: 1,
                priority: 0,
                match_mode: "legacy".to_string(),
                case_insensitive: true,
            }])
        })
        .transpose()?;
    let changes = connection
        .prepare(
            "SELECT id, app, window_title, domain, COALESCE(category_id, 0),
                    MAX(0, ts_end - ts_start), manual_category
             FROM segments WHERE manual_category = 0 OR ?1",
        )
        .map_err(|error| error.to_string())?
        .query_map([overwrite_manual], |row| {
            let id = row.get::<_, i64>(0)?;
            let app = row.get::<_, String>(1)?;
            let title = row.get::<_, String>(2)?;
            let domain = row.get::<_, String>(3)?;
            let current_category_id = row.get::<_, i64>(4)?;
            let duration_ms = row.get::<_, i64>(5)?;
            let manual_category = row.get::<_, i64>(6)?;
            let activity = Activity {
                app: &app,
                title: &title,
                domain: &domain,
            };
            let classified = rules.classify(&activity);
            let rule_category_id = (classified != 0).then_some(classified);
            let manual_in_scope = manual_scope
                .as_ref()
                .is_none_or(|scope| scope.classify(&activity) != 0);
            Ok((
                id,
                current_category_id,
                rule_category_id,
                duration_ms,
                manual_category,
                manual_in_scope,
            ))
        })
        .map_err(|error| error.to_string())?
        .filter_map(|result| match result {
            Ok((id, current, rule_category_id, duration, manual_category, manual_in_scope)) => {
                let category_id = rule_category_id.unwrap_or(0);
                if current == category_id
                    || (manual_category == 1 && (rule_category_id.is_none() || !manual_in_scope))
                {
                    None
                } else {
                    Some(Ok((id, category_id, duration)))
                }
            }
            Err(error) => Some(Err(error)),
        })
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    Ok(changes)
}

fn reclassify_history_in_transaction(
    transaction: &Transaction<'_>,
    overwrite_manual: bool,
    manual_rule_scope: Option<(&str, &str)>,
) -> Result<ReclassificationSummary, String> {
    let changes = reclassification_changes(transaction, overwrite_manual, manual_rule_scope)?;
    let changed_duration_ms = changes.iter().map(|(_, _, duration)| duration).sum();
    for (segment_id, category_id, _) in &changes {
        transaction
            .execute(
                "UPDATE segments SET category_id = ?1, manual_category = 0 WHERE id = ?2",
                params![category_id, segment_id],
            )
            .map_err(|error| error.to_string())?;
    }
    rebuild_daily_stats(transaction)?;
    Ok(ReclassificationSummary {
        changed_segments: changes.len() as i64,
        changed_duration_ms,
    })
}

pub fn reclassify_history(
    connection: &mut Connection,
    overwrite_manual: bool,
    manual_match_type: Option<&str>,
    manual_pattern: Option<&str>,
) -> Result<ReclassificationSummary, String> {
    let manual_rule_scope = match (manual_match_type, manual_pattern) {
        (Some(match_type), Some(pattern))
            if matches!(match_type, "exe" | "title" | "domain") && !pattern.trim().is_empty() =>
        {
            Some((match_type.to_string(), pattern.trim().to_lowercase()))
        }
        (None, None) => None,
        _ => return Err("invalid manual overwrite scope".to_string()),
    };
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    let summary = reclassify_history_in_transaction(
        &transaction,
        overwrite_manual,
        manual_rule_scope
            .as_ref()
            .map(|(match_type, pattern)| (match_type.as_str(), pattern.as_str())),
    )?;
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(summary)
}

pub fn preview_reclassify_history(
    connection: &Connection,
    overwrite_manual: bool,
) -> Result<ReclassificationSummary, String> {
    let changes = reclassification_changes(connection, overwrite_manual, None)?;
    Ok(ReclassificationSummary {
        changed_segments: changes.len() as i64,
        changed_duration_ms: changes.iter().map(|(_, _, duration)| duration).sum(),
    })
}

pub fn classification_match_stats(
    connection: &Connection,
    match_type: &str,
    pattern: &str,
) -> Result<ClassificationMatchStats, String> {
    classification_match_stats_with_mode(connection, match_type, pattern, "legacy", true)
}

pub fn classification_match_stats_with_mode(
    connection: &Connection,
    match_type: &str,
    pattern: &str,
    match_mode: &str,
    case_insensitive: bool,
) -> Result<ClassificationMatchStats, String> {
    let rules = RuleSet::compile(vec![RuleDefinition {
        id: 0,
        match_type: match_type.to_string(),
        pattern: pattern.trim().to_string(),
        category_id: 1,
        priority: 0,
        match_mode: match_mode.to_string(),
        case_insensitive,
    }])?;
    let stats = rules.match_stats(connection)?;
    Ok(ClassificationMatchStats {
        match_count: stats.match_count,
        manual_count: stats.manual_count,
    })
}

pub fn today_scoring(connection: &Connection) -> Result<TodayScoringRecord, String> {
    let categories = list_categories(connection)?
        .into_iter()
        .map(|category| (category.id, category))
        .collect::<HashMap<_, _>>();
    let mut statement = connection
        .prepare(
            "SELECT category_id, SUM(duration_ms)
             FROM segment_day_overlaps
             WHERE local_date = date('now', 'localtime')
             GROUP BY category_id",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)))
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    let observed_ms = rows.iter().map(|(_, duration)| *duration).sum::<i64>();
    let productive_ms = rows
        .iter()
        .filter(|(category_id, _)| {
            categories
                .get(category_id)
                .is_some_and(|category| category.effective_score > 0.0)
        })
        .map(|(_, duration)| *duration)
        .sum::<i64>();
    let mut entries = rows
        .into_iter()
        .map(|(category_id, duration_ms)| {
            let category = categories
                .get(&category_id)
                .or_else(|| categories.get(&0))
                .ok_or_else(|| "Uncategorized category is missing".to_string())?;
            Ok(ScoringCategoryRecord {
                category_id,
                name: category.name.clone(),
                full_path: category.full_path.clone(),
                effective_color: category.effective_color.clone(),
                duration_ms,
                points: category.effective_score * duration_ms as f64 / 3_600_000.0,
            })
        })
        .collect::<Result<Vec<_>, String>>()?;
    let total_score = entries.iter().map(|entry| entry.points).sum();
    let mut top_productive = entries
        .iter()
        .filter(|entry| entry.points > 0.0)
        .cloned()
        .collect::<Vec<_>>();
    top_productive.sort_by(|left, right| right.points.total_cmp(&left.points));
    let mut top_distracting = entries
        .iter()
        .filter(|entry| entry.points < 0.0)
        .cloned()
        .collect::<Vec<_>>();
    top_distracting.sort_by(|left, right| left.points.total_cmp(&right.points));
    entries.sort_by(|left, right| right.duration_ms.cmp(&left.duration_ms));
    top_productive.truncate(5);
    top_distracting.truncate(5);
    entries.truncate(8);
    Ok(TodayScoringRecord {
        total_score,
        productive_percent: if observed_ms == 0 {
            0.0
        } else {
            productive_ms as f64 * 100.0 / observed_ms as f64
        },
        top_productive,
        top_distracting,
        top_categories: entries,
    })
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

pub fn afk_series(connection: &Connection, days: i64) -> Result<Vec<AfkDayRecord>, String> {
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
             ), bounds AS (
                SELECT local_date,
                       CAST(strftime('%s', local_date || ' 00:00:00', 'utc') AS INTEGER) * 1000 AS day_start_ms,
                       CAST(strftime('%s', local_date || ' 00:00:00', '+1 day', 'utc') AS INTEGER) * 1000 AS day_end_ms
                FROM calendar
             )
             SELECT bounds.local_date,
                    COALESCE(SUM(MAX(
                        0,
                        MIN(segments.ts_end, bounds.day_end_ms)
                            - MAX(segments.ts_start, bounds.day_start_ms)
                    )), 0) AS afk_ms
             FROM bounds
             LEFT JOIN segments
               ON segments.status = 'away'
              AND segments.ts_end > bounds.day_start_ms
              AND segments.ts_start < bounds.day_end_ms
             GROUP BY bounds.local_date
             ORDER BY bounds.local_date",
        )
        .map_err(|error| error.to_string())?;
    let records = statement
        .query_map([days], |row| {
            Ok(AfkDayRecord {
                local_date: row.get(0)?,
                afk_ms: row.get(1)?,
            })
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    drop(statement);
    Ok(records)
}

pub fn afk_duration_for_day(connection: &Connection, local_date: &str) -> Result<i64, String> {
    connection
        .query_row(
            "WITH bounds AS (
                SELECT CAST(strftime('%s', ?1 || ' 00:00:00', 'utc') AS INTEGER) * 1000 AS day_start_ms,
                       CAST(strftime('%s', ?1 || ' 00:00:00', '+1 day', 'utc') AS INTEGER) * 1000 AS day_end_ms
             )
             SELECT COALESCE(SUM(MAX(
                        0,
                        MIN(segments.ts_end, bounds.day_end_ms)
                            - MAX(segments.ts_start, bounds.day_start_ms)
                    )), 0)
             FROM bounds
             LEFT JOIN segments
               ON segments.status = 'away'
              AND segments.ts_end > bounds.day_start_ms
              AND segments.ts_start < bounds.day_end_ms",
            [local_date],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())
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

pub fn mini_hourly(
    connection: &Connection,
    current_ms: i64,
    limit_hours: i64,
) -> Result<Vec<MiniHourlyRecord>, String> {
    let mut statement = connection
        .prepare(
            "WITH RECURSIVE bounds AS (
                SELECT (?1 / 3600000) * 3600000 AS current_hour_ms,
                       ?1 AS current_ms,
                       ?2 AS limit_hours
             ), hours(hour_ts, bucket_index) AS (
                SELECT current_hour_ms - (limit_hours - 1) * 3600000, 0 FROM bounds
                UNION ALL
                SELECT hour_ts + 3600000, bucket_index + 1
                FROM hours, bounds
                WHERE bucket_index + 1 < bounds.limit_hours
             )
             SELECT hours.hour_ts,
                    COALESCE(SUM(CASE WHEN categories.kind = 'useful' THEN
                        MAX(0, MIN(segments.ts_end, hours.hour_ts + 3600000, bounds.current_ms)
                            - MAX(segments.ts_start, hours.hour_ts))
                    ELSE 0 END), 0) AS useful_ms,
                    COALESCE(SUM(CASE WHEN categories.kind = 'neutral' THEN
                        MAX(0, MIN(segments.ts_end, hours.hour_ts + 3600000, bounds.current_ms)
                            - MAX(segments.ts_start, hours.hour_ts))
                    ELSE 0 END), 0) AS neutral_ms,
                    COALESCE(SUM(CASE WHEN categories.kind = 'waste' THEN
                        MAX(0, MIN(segments.ts_end, hours.hour_ts + 3600000, bounds.current_ms)
                            - MAX(segments.ts_start, hours.hour_ts))
                    ELSE 0 END), 0) AS waste_ms
             FROM hours
             CROSS JOIN bounds
             LEFT JOIN segments
               ON segments.status IN ('active', 'crashed')
              AND segments.ts_end > hours.hour_ts
              AND segments.ts_start < MIN(hours.hour_ts + 3600000, bounds.current_ms)
             LEFT JOIN categories ON categories.id = COALESCE(segments.category_id, 0)
             GROUP BY hours.hour_ts
             ORDER BY hours.hour_ts",
        )
        .map_err(|error| error.to_string())?;
    let records = statement
        .query_map(params![current_ms, limit_hours], |row| {
            Ok(MiniHourlyRecord {
                hour_ts: row.get(0)?,
                useful_ms: row.get(1)?,
                neutral_ms: row.get(2)?,
                waste_ms: row.get(3)?,
            })
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    drop(statement);
    Ok(records)
}

#[cfg(test)]
mod tests {
    use super::{
        afk_series, daily_series, import_challenge, mini_hourly, preview_reclassify_history,
        progress_series, reclassify_history, refresh_daily_stats, segment_local_dates, set_setting,
        today_cumulative, today_scoring, upsert_exe_rule, validate_category_tree, MIGRATION_001,
        MIGRATION_002, MIGRATION_003, MIGRATION_004, MIGRATION_005, MIGRATION_006,
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

        let rule_id = upsert_exe_rule(&connection, "Example.EXE", 1, 4).expect("insert rule");
        let updated_id = upsert_exe_rule(&connection, "example.exe", 2, 9).expect("update rule");

        assert_eq!(updated_id, rule_id);
        let stored = connection
            .query_row(
                "SELECT match_type, pattern, category_id, priority FROM rules WHERE id = ?1",
                [rule_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, i64>(2)?,
                        row.get::<_, i64>(3)?,
                    ))
                },
            )
            .expect("stored rule");
        assert_eq!(stored, ("exe".to_string(), "example.exe".to_string(), 2, 9));
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM rules", [], |row| row.get::<_, i64>(0))
                .expect("rule count"),
            1
        );
    }

    #[test]
    fn mini_hourly_zero_fills_and_splits_segments_across_rolling_hours() {
        let connection = score_schema();
        connection
            .execute_batch(
                "INSERT INTO categories (id, name, color, kind, created_at) VALUES
                    (1, 'Work', '#000000', 'useful', 0),
                    (2, 'Chill', '#000000', 'neutral', 0),
                    (3, 'Waste', '#000000', 'waste', 0);
                 INSERT INTO segments (ts_start, ts_end, app, category_id, status) VALUES
                    (1704094200000, 1704097800000, 'work.exe', 1, 'active'),
                    (1704096900000, 1704100500000, 'chill.exe', 2, 'crashed'),
                    (1704099600000, 1704101400000, 'waste.exe', 3, 'active'),
                    (1704099600000, 1704101400000, 'away.exe', 3, 'away');",
            )
            .expect("fixtures");

        let hours = mini_hourly(&connection, 1704101400000, 3).expect("hourly buckets");

        assert_eq!(hours.len(), 3);
        assert_eq!(hours[0].hour_ts, 1704092400000);
        assert_eq!(hours[0].useful_ms, 1_800_000);
        assert_eq!(hours[0].neutral_ms, 0);
        assert_eq!(hours[0].waste_ms, 0);
        assert_eq!(hours[1].useful_ms, 1_800_000);
        assert_eq!(hours[1].neutral_ms, 2_700_000);
        assert_eq!(hours[1].waste_ms, 0);
        assert_eq!(hours[2].useful_ms, 0);
        assert_eq!(hours[2].neutral_ms, 900_000);
        assert_eq!(hours[2].waste_ms, 1_800_000);
    }

    #[test]
    fn rejects_uncategorized_exe_rule() {
        let connection = Connection::open_in_memory().expect("in-memory database");
        connection.execute_batch(MIGRATION_001).expect("schema");

        assert_eq!(
            upsert_exe_rule(&connection, "example.exe", 0, 1),
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
            .execute_batch(MIGRATION_004)
            .expect("history reclassification schema");
        connection
            .execute_batch(MIGRATION_005)
            .expect("category scoring schema");
        connection
    }

    #[test]
    fn migration_maps_existing_kind_to_independent_score() {
        let connection = Connection::open_in_memory().expect("database");
        connection
            .execute_batch(MIGRATION_001)
            .expect("base schema");
        connection
            .execute_batch(
                "INSERT INTO categories (id, name, color, kind, created_at) VALUES
                    (1, 'Work', '#286983', 'useful', 0),
                    (2, 'Break', '#ea9d34', 'neutral', 0),
                    (3, 'Waste', '#b4637a', 'waste', 0);",
            )
            .expect("legacy categories");
        connection.execute_batch(MIGRATION_005).expect("migration");
        let scores = connection
            .prepare("SELECT score FROM categories WHERE id IN (0, 1, 2, 3) ORDER BY id")
            .expect("query")
            .query_map([], |row| row.get::<_, f64>(0))
            .expect("rows")
            .collect::<Result<Vec<_>, _>>()
            .expect("scores");
        assert_eq!(scores, vec![0.0, 10.0, 0.0, -10.0]);
        assert_eq!(
            connection
                .query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))
                .expect("version"),
            5
        );
    }

    fn rule_uniqueness_schema() -> Connection {
        let connection = Connection::open_in_memory().expect("database");
        connection
            .execute_batch(MIGRATION_001)
            .expect("base schema");
        connection
            .execute_batch(MIGRATION_005)
            .expect("rule schema");
        connection
            .execute_batch(
                "INSERT INTO categories (id, name, color, kind, created_at) VALUES
                    (1, 'Video', '#286983', 'neutral', 0),
                    (2, 'Learning', '#56949f', 'useful', 0);",
            )
            .expect("categories");
        connection
    }

    #[test]
    fn migration_006_collapses_same_category_duplicates_by_priority_then_id() {
        let connection = rule_uniqueness_schema();
        connection
            .execute_batch(
                "INSERT INTO rules (
                    id, match_type, pattern, category_id, priority, created_at,
                    match_mode, case_insensitive
                 ) VALUES
                    (10, 'title', 'youtube', 1, 5, 0, 'legacy', 1),
                    (11, 'title', 'youtube', 1, 9, 0, 'legacy', 1),
                    (12, 'title', 'youtube', 1, 9, 0, 'legacy', 1);",
            )
            .expect("duplicate rules");

        connection.execute_batch(MIGRATION_006).expect("migration");

        assert_eq!(
            connection
                .query_row(
                    "SELECT id, priority FROM rules WHERE category_id = 1",
                    [],
                    |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
                )
                .expect("kept rule"),
            (10, 9),
        );
    }

    #[test]
    fn migration_006_keeps_same_pattern_in_different_categories() {
        let connection = rule_uniqueness_schema();
        connection
            .execute_batch(
                "INSERT INTO rules (
                    match_type, pattern, category_id, priority, created_at,
                    match_mode, case_insensitive
                 ) VALUES
                    ('title', 'youtube', 1, 5, 0, 'legacy', 1),
                    ('title', 'youtube', 2, 5, 0, 'legacy', 1);",
            )
            .expect("rules");

        connection.execute_batch(MIGRATION_006).expect("migration");

        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM rules", [], |row| row.get::<_, i64>(0))
                .expect("rule count"),
            2,
        );
    }

    #[test]
    fn migration_006_unique_index_rejects_exact_duplicate() {
        let connection = rule_uniqueness_schema();
        connection.execute_batch(MIGRATION_006).expect("migration");
        connection
            .execute(
                "INSERT INTO rules (
                    match_type, pattern, category_id, priority, created_at,
                    match_mode, case_insensitive
                 ) VALUES ('title', 'youtube', 1, 5, 0, 'legacy', 1)",
                [],
            )
            .expect("first rule");

        assert!(connection
            .execute(
                "INSERT INTO rules (
                    match_type, pattern, category_id, priority, created_at,
                    match_mode, case_insensitive
                 ) VALUES ('title', 'youtube', 1, 9, 0, 'legacy', 1)",
                [],
            )
            .is_err());
    }

    #[test]
    fn category_tree_rejects_cycles_and_depth_over_three() {
        let connection = score_schema();
        connection
            .execute_batch(
                "INSERT INTO categories (id, name, color, kind, created_at, parent_id) VALUES
                    (1, 'Root', '#286983', 'useful', 0, NULL),
                    (2, 'Child', '#286983', 'neutral', 0, 1),
                    (3, 'Leaf', '#286983', 'neutral', 0, 2);",
            )
            .expect("categories");
        assert_eq!(
            validate_category_tree(&connection, Some(1), Some(3)),
            Err("category cycle".to_string())
        );
        assert_eq!(
            validate_category_tree(&connection, None, Some(3)),
            Err("category depth exceeds 3 levels".to_string())
        );
    }

    #[test]
    fn category_effective_values_follow_the_parent_chain() {
        let connection = score_schema();
        connection
            .execute_batch(
                "INSERT INTO categories (
                    id, name, color, kind, created_at, parent_id, score,
                    inherit_color, inherit_score
                 ) VALUES
                    (1, 'Work', '#286983', 'useful', 0, NULL, 8, 0, 0),
                    (2, 'Video', '#b4637a', 'neutral', 0, 1, -2, 1, 1),
                    (3, 'Course', '#ea9d34', 'neutral', 0, 2, 4, 1, 1);",
            )
            .expect("categories");
        let leaf = super::category_by_id(&connection, 3).expect("leaf");
        assert_eq!(leaf.effective_color, "#286983");
        assert_eq!(leaf.effective_score, 8.0);
        assert_eq!(leaf.full_path, "Work > Video > Course");
    }

    #[test]
    fn scoring_uses_score_hours_and_productive_time_without_parent_rollup() {
        let connection = score_schema();
        connection
            .execute_batch(
                "INSERT INTO categories (
                    id, name, color, kind, created_at, parent_id, score,
                    inherit_color, inherit_score
                 ) VALUES
                    (1, 'Work', '#286983', 'waste', 0, NULL, 8, 0, 0),
                    (2, 'Video', '#b4637a', 'neutral', 0, 1, 5, 1, 0),
                    (3, 'Social', '#b4637a', 'useful', 0, NULL, -10, 0, 0);
                 INSERT INTO segments (
                    ts_start, ts_end, app, category_id, status
                 ) VALUES
                    (strftime('%s', date('now', 'localtime') || ' 09:00:00', 'utc') * 1000,
                     strftime('%s', date('now', 'localtime') || ' 11:00:00', 'utc') * 1000,
                     'course.exe', 2, 'crashed'),
                    (strftime('%s', date('now', 'localtime') || ' 11:00:00', 'utc') * 1000,
                     strftime('%s', date('now', 'localtime') || ' 12:00:00', 'utc') * 1000,
                     'social.exe', 3, 'crashed'),
                    (strftime('%s', date('now', 'localtime') || ' 12:00:00', 'utc') * 1000,
                     strftime('%s', date('now', 'localtime') || ' 13:00:00', 'utc') * 1000,
                     'unknown.exe', 0, 'crashed');",
            )
            .expect("fixtures");
        let scoring = today_scoring(&connection).expect("scoring");
        assert!((scoring.total_score - 0.0).abs() < f64::EPSILON);
        assert!((scoring.productive_percent - 50.0).abs() < 0.001);
        assert_eq!(scoring.top_productive[0].full_path, "Work > Video");
        assert_eq!(scoring.top_productive[0].points, 10.0);
        assert_eq!(scoring.top_distracting[0].points, -10.0);
        assert_eq!(scoring.top_categories[0].category_id, 2);
    }

    #[test]
    fn score_does_not_change_daily_stats_xp() {
        let connection = score_schema();
        connection
            .execute_batch(
                "INSERT INTO categories (id, name, color, kind, created_at, score)
                 VALUES (1, 'Useful but negative', '#286983', 'useful', 0, -10);
                 INSERT INTO segments (ts_start, ts_end, app, category_id, status)
                 VALUES (
                    strftime('%s', date('now', 'localtime') || ' 09:00:00', 'utc') * 1000,
                    strftime('%s', date('now', 'localtime') || ' 10:00:00', 'utc') * 1000,
                    'work.exe', 1, 'crashed'
                 );
                 INSERT INTO goal_history (
                    effective_local_date, useful_goal_min, waste_limit_min, observed_min
                 ) VALUES (date('now', 'localtime'), 60, 0, 60);",
            )
            .expect("fixtures");
        let transaction = connection.unchecked_transaction().expect("transaction");
        let today = transaction
            .query_row("SELECT date('now', 'localtime')", [], |row| {
                row.get::<_, String>(0)
            })
            .expect("today");
        refresh_daily_stats(&transaction, &today).expect("daily stats");
        transaction.commit().expect("commit");
        assert_eq!(
            connection
                .query_row(
                    "SELECT duration_ms, xp FROM daily_stats
                     WHERE local_date = ?1 AND category_id = 1",
                    [&today],
                    |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
                )
                .expect("daily stats"),
            (3_600_000, 60)
        );
        let today_progress = progress_series(&connection)
            .expect("progress")
            .into_iter()
            .find(|day| day.local_date == today)
            .expect("today progress");
        assert_eq!(today_progress.useful_ms, 3_600_000);
        assert_eq!(today_progress.observed_min, 60);
        assert!(
            daily_series(&connection, 7)
                .expect("daily series")
                .into_iter()
                .find(|day| day.local_date == today)
                .expect("today series")
                .passed
        );
    }

    #[test]
    fn reclassifies_history_by_precedence_without_overwriting_manual_categories() {
        let mut connection = score_schema();
        for (id, name, kind) in [
            (1, "Work", "useful"),
            (2, "Chill", "neutral"),
            (3, "Brainrot", "waste"),
        ] {
            connection
                .execute(
                    "INSERT INTO categories (id, name, color, kind, created_at)
                     VALUES (?1, ?2, '#000000', ?3, 0)",
                    params![id, name, kind],
                )
                .expect("category");
        }
        for (match_type, pattern, category_id, priority) in [
            ("exe", "example.exe", 2, 20),
            ("title", "фокус", 1, 10),
            ("domain", "example.com", 3, 10),
        ] {
            connection
                .execute(
                    "INSERT INTO rules (match_type, pattern, category_id, priority, created_at)
                     VALUES (?1, ?2, ?3, ?4, 0)",
                    params![match_type, pattern, category_id, priority],
                )
                .expect("rule");
        }
        for (app, title, domain, category_id, manual_category) in [
            ("EXAMPLE.EXE", "ФОКУС", "example.com", 0, 0),
            ("OTHER.EXE", "ФОКУС", "example.com", 0, 0),
            ("OTHER.EXE", "ФОКУС", "", 0, 0),
            ("EXAMPLE.EXE", "Plain", "", 0, 0),
            ("OTHER.EXE", "ФОКУС", "example.com", 1, 1),
        ] {
            connection
                .execute(
                    "INSERT INTO segments (
                        ts_start, ts_end, app, window_title, domain, category_id, status,
                        manual_category
                     ) VALUES (
                        strftime('%s', '2026-08-10 10:00:00', 'utc') * 1000,
                        strftime('%s', '2026-08-10 10:10:00', 'utc') * 1000,
                        ?1, ?2, ?3, ?4, 'crashed', ?5
                     )",
                    params![app, title, domain, category_id, manual_category],
                )
                .expect("segment");
        }

        let preview = preview_reclassify_history(&mut connection, false).expect("preview");
        assert_eq!(preview.changed_segments, 4);
        assert_eq!(preview.changed_duration_ms, 2_400_000);
        let unchanged = connection
            .prepare("SELECT category_id FROM segments ORDER BY id")
            .expect("preview query")
            .query_map([], |row| row.get::<_, i64>(0))
            .expect("preview rows")
            .collect::<Result<Vec<_>, _>>()
            .expect("preview categories");
        assert_eq!(unchanged, vec![0, 0, 0, 0, 1]);

        let summary =
            reclassify_history(&mut connection, false, None, None).expect("reclassification");

        assert_eq!(summary.changed_segments, 4);
        assert_eq!(summary.changed_duration_ms, 2_400_000);
        let categories = connection
            .prepare("SELECT category_id FROM segments ORDER BY id")
            .expect("query")
            .query_map([], |row| row.get::<_, i64>(0))
            .expect("rows")
            .collect::<Result<Vec<_>, _>>()
            .expect("categories");
        assert_eq!(categories, vec![2, 3, 1, 2, 1]);
        let stats = connection
            .prepare(
                "SELECT c.kind, ds.duration_ms, ds.xp
                 FROM daily_stats ds JOIN categories c ON c.id = ds.category_id
                 WHERE ds.local_date = '2026-08-10' ORDER BY c.kind",
            )
            .expect("stats query")
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, i64>(2)?,
                ))
            })
            .expect("stats rows")
            .collect::<Result<Vec<_>, _>>()
            .expect("stats");
        assert_eq!(
            stats,
            vec![
                ("neutral".to_string(), 1_200_000, 0),
                ("useful".to_string(), 1_200_000, 20),
                ("waste".to_string(), 600_000, 0),
            ]
        );
    }

    #[test]
    fn counts_matching_manual_segments_and_can_repaint_them() {
        let mut connection = score_schema();
        for (id, name, kind) in [(1, "Work", "useful"), (3, "Brainrot", "waste")] {
            connection
                .execute(
                    "INSERT INTO categories (id, name, color, kind, created_at)
                     VALUES (?1, ?2, '#000000', ?3, 0)",
                    params![id, name, kind],
                )
                .expect("category");
        }
        connection
            .execute(
                "INSERT INTO rules (match_type, pattern, category_id, priority, created_at)
                 VALUES ('title', 'Игра престолов 4 сезон', 1, 0, 0)",
                [],
            )
            .expect("rule");
        connection
            .execute(
                "INSERT INTO rules (match_type, pattern, category_id, priority, created_at)
                 VALUES ('title', 'Игра престолов 5 сезон', 1, 0, 0)",
                [],
            )
            .expect("unrelated rule");
        for (title, manual_category) in [
            ("Игра престолов 4 сезон 2 серия", 1),
            ("Игра престолов 4 сезон 3 серия", 0),
            ("Игра престолов 5 сезон 2 серия", 1),
        ] {
            connection
                .execute(
                    "INSERT INTO segments (
                        ts_start, ts_end, app, window_title, category_id, status,
                        manual_category
                     ) VALUES (0, 60000, 'browser.exe', ?1, 3, 'crashed', ?2)",
                    params![title, manual_category],
                )
                .expect("segment");
        }

        let counts = classification_match_stats(&connection, "title", "Игра престолов 4 сезон")
            .expect("match stats");
        assert_eq!(counts.match_count, 2);
        assert_eq!(counts.manual_count, 1);
        let app_counts =
            classification_match_stats(&connection, "exe", "browser.exe").expect("app match stats");
        assert_eq!(app_counts.match_count, 3);
        assert_eq!(app_counts.manual_count, 2);

        let summary = reclassify_history(
            &mut connection,
            true,
            Some("title"),
            Some("игра престолов 4 сезон"),
        )
        .expect("reclassification");
        assert_eq!(summary.changed_segments, 2);
        let classifications = connection
            .prepare("SELECT category_id, manual_category FROM segments ORDER BY id")
            .expect("query")
            .query_map([], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)))
            .expect("rows")
            .collect::<Result<Vec<_>, _>>()
            .expect("classifications");
        assert_eq!(classifications, vec![(1, 0), (1, 0), (3, 1)]);
    }

    #[test]
    fn reclassifies_episode_variants_within_the_same_season() {
        let mut connection = score_schema();
        connection
            .execute(
                "INSERT INTO categories (id, name, color, kind, created_at)
                 VALUES (1, 'Chill', '#000000', 'neutral', 0)",
                [],
            )
            .expect("category");
        connection
            .execute(
                "INSERT INTO rules (match_type, pattern, category_id, priority, created_at)
                 VALUES ('title', ?1, 1, 0, 0)",
                ["Смотреть сериал Игра престолов 4 сезон 2 серия онлайн бесплатно"],
            )
            .expect("legacy title rule");
        for title in [
            "Игра престолов 4 сезон 3 серия",
            "Игра престолов 5 сезон 3 серия",
        ] {
            connection
                .execute(
                    "INSERT INTO segments (
                        ts_start, ts_end, app, window_title, category_id, status
                     ) VALUES (0, 60000, 'browser.exe', ?1, 0, 'crashed')",
                    [title],
                )
                .expect("segment");
        }

        reclassify_history(&mut connection, false, None, None).expect("reclassification");

        let categories = connection
            .prepare("SELECT category_id FROM segments ORDER BY id")
            .expect("query")
            .query_map([], |row| row.get::<_, i64>(0))
            .expect("rows")
            .collect::<Result<Vec<_>, _>>()
            .expect("categories");
        assert_eq!(categories, vec![1, 0]);
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
    fn afk_series_zero_fills_dates_and_splits_local_midnight() {
        let connection = score_schema();
        connection
            .execute_batch(
                "INSERT INTO segments (ts_start, ts_end, app, status)
                 VALUES (
                    strftime('%s', date('now', 'localtime', '-2 days') || ' 23:50:00', 'utc') * 1000,
                    strftime('%s', date('now', 'localtime', '-1 day') || ' 00:20:00', 'utc') * 1000,
                    'away.exe', 'away'
                 );
                 INSERT INTO segments (ts_start, ts_end, app, status)
                 VALUES (
                    strftime('%s', date('now', 'localtime', '-1 day') || ' 01:00:00', 'utc') * 1000,
                    strftime('%s', date('now', 'localtime', '-1 day') || ' 01:30:00', 'utc') * 1000,
                    'active.exe', 'active'
                 );",
            )
            .expect("segments");

        let series = afk_series(&connection, 4).expect("afk series");

        assert_eq!(series.len(), 4);
        assert_eq!(series[0].afk_ms, 0, "missing dates are zero-filled");
        assert_eq!(series[1].afk_ms, 10 * 60_000);
        assert_eq!(series[2].afk_ms, 20 * 60_000);
        assert_eq!(series[3].afk_ms, 0);
        assert!(afk_series(&connection, 0).is_err());
        assert!(afk_series(&connection, 367).is_err());
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
