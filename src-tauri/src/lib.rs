// Time To Lock In — точка входа и команды локального хранилища.

mod db;
mod http;
mod rules;
mod tray;
mod watcher;

use rusqlite::{params, OptionalExtension};
use serde::Serialize;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use tauri::{Emitter, Manager};
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_updater::UpdaterExt;

struct TrackingControl {
    paused: Arc<AtomicBool>,
}

type ServiceHandles = Arc<
    Mutex<
        Option<(
            Arc<AtomicBool>,
            std::thread::JoinHandle<()>,
            std::thread::JoinHandle<()>,
            std::thread::JoinHandle<()>,
        )>,
    >,
>;

#[derive(Serialize)]
struct Segment {
    id: i64,
    ts_start: i64,
    ts_end: i64,
    app: String,
    window_title: String,
    domain: String,
    category_id: i64,
    status: String,
}

#[derive(Serialize)]
struct TodayStats {
    useful_ms: i64,
    neutral_ms: i64,
    waste_ms: i64,
    observed_ms: i64,
}

#[derive(Serialize)]
struct CumulativePoint {
    timestamp_ms: i64,
    hour: i64,
    useful_ms: i64,
    waste_ms: i64,
    is_current: bool,
}

#[derive(Serialize)]
struct TodayCumulative {
    points: Vec<CumulativePoint>,
    useful_goal_min: i64,
    waste_limit_min: i64,
}

#[derive(Serialize)]
struct MiniHourlyBucket {
    hour_ts: i64,
    useful_ms: i64,
    neutral_ms: i64,
    waste_ms: i64,
}

#[derive(Serialize)]
struct DailySeriesDay {
    local_date: String,
    useful_ms: i64,
    neutral_ms: i64,
    waste_ms: i64,
    observed_ms: i64,
    useful_goal_min: i64,
    waste_limit_min: i64,
    observed_min: i64,
    passed: bool,
    useful_xp: i64,
    useful_ma_7d_ms: i64,
}

#[derive(Serialize)]
struct AfkDay {
    local_date: String,
    afk_ms: i64,
}

#[derive(Clone, Serialize)]
struct ProgressDay {
    local_date: String,
    useful_ms: i64,
    neutral_ms: i64,
    waste_ms: i64,
    observed_ms: i64,
    useful_goal_min: i64,
    waste_limit_min: i64,
    observed_min: i64,
    useful_passed: bool,
    waste_passed: bool,
    observed_passed: bool,
    passed: bool,
    useful_level: u8,
    waste_level: u8,
    future: bool,
}

#[derive(Serialize)]
struct ProgressOverview {
    today: ProgressDay,
    today_afk_ms: i64,
    lifetime_xp: i64,
    current_rank: &'static str,
    current_rank_threshold: i64,
    next_rank: Option<&'static str>,
    next_rank_threshold: Option<i64>,
    calendar: Vec<ProgressDay>,
}

#[derive(Serialize)]
struct LiveSegment {
    id: i64,
    ts_start: i64,
    ts_end: i64,
    app: String,
    window_title: String,
    domain: String,
    status: String,
    category_name: String,
    category_kind: String,
    is_uncategorized: bool,
}

const RANKS: [(&str, i64); 8] = [
    ("Хомяк", 0),
    ("Стажёр", 500),
    ("Кодер", 2_000),
    ("Фокусник", 5_000),
    ("Тайм-ниндзя", 12_000),
    ("Киберсамурай", 25_000),
    ("Архитектор времени", 50_000),
    ("Повелитель времени", 100_000),
];

const CATEGORY_ICONS: &[&str] = &[
    "briefcase",
    "coffee",
    "skull",
    "brain",
    "laptop",
    "code",
    "gamepad",
    "message-circle",
    "play-circle",
    "dumbbell",
    "music",
    "book-open",
    "house",
    "moon",
    "palette",
    "globe",
    "folder",
    "tag",
];

fn validate_category_icon(icon: &str) -> Result<(), String> {
    if icon.is_empty() || CATEGORY_ICONS.contains(&icon) {
        Ok(())
    } else {
        Err("invalid category icon".to_string())
    }
}

#[cfg(test)]
mod category_icon_tests {
    use super::{category_icon_or_fallback, validate_category_icon};

    #[test]
    fn category_icon_allowlist_accepts_empty_and_known_ids_only() {
        assert!(validate_category_icon("").is_ok());
        assert!(validate_category_icon("brain").is_ok());
        assert!(validate_category_icon("not-lucide").is_err());
        assert_eq!(category_icon_or_fallback("not-lucide".to_string()), "tag");
    }
}

pub(crate) fn category_icon_or_fallback(icon: String) -> String {
    if icon.is_empty() || CATEGORY_ICONS.contains(&icon.as_str()) {
        icon
    } else {
        "tag".to_string()
    }
}

#[derive(Clone, Serialize)]
struct DayPrintEntry {
    app: String,
    category_name: String,
    category_kind: String,
    is_uncategorized: bool,
    duration_ms: i64,
}

#[derive(Clone, Serialize)]
struct DayPrint {
    local_date: String,
    useful_ms: i64,
    neutral_ms: i64,
    waste_ms: i64,
    afk_ms: i64,
    observed_ms: i64,
    useful_goal_min: i64,
    waste_limit_min: i64,
    observed_min: i64,
    useful_passed: bool,
    waste_passed: bool,
    observed_passed: bool,
    passed: bool,
    public_xp: i64,
    lifetime_xp: i64,
    rank: &'static str,
    burned_rubles: Option<f64>,
    currency: String,
    top_entries: Vec<DayPrintEntry>,
    challenge_code: Option<String>,
    challenge_passed: Option<bool>,
}

#[derive(Serialize)]
struct WeekSummary {
    days: Vec<DayPrint>,
    passed_count: usize,
    useful_ms: i64,
    neutral_ms: i64,
    waste_ms: i64,
    afk_ms: i64,
    week_xp: i64,
    lifetime_xp: i64,
    rank: &'static str,
    strongest_day: Option<String>,
    waste_days: usize,
    burned_rubles: Option<f64>,
    currency: String,
}

#[derive(Serialize)]
struct ReclassificationSummary {
    changed_segments: i64,
    changed_duration_ms: i64,
}

#[derive(Serialize)]
struct ClassificationMatchStats {
    match_count: i64,
    manual_count: i64,
}

#[derive(Serialize)]
struct ImportedChallenge {
    code: String,
    useful_goal_min: i64,
    waste_limit_min: i64,
    observed_min: i64,
}

fn rank_for_xp(xp: i64) -> (&'static str, i64, Option<(&'static str, i64)>) {
    let index = RANKS
        .iter()
        .rposition(|(_, threshold)| xp >= *threshold)
        .unwrap_or(0);
    let (name, threshold) = RANKS[index];
    (name, threshold, RANKS.get(index + 1).copied())
}

fn local_date_format_is_valid(value: &str) -> bool {
    value.len() == 10
        && value.as_bytes()[4] == b'-'
        && value.as_bytes()[7] == b'-'
        && value
            .chars()
            .enumerate()
            .all(|(index, character)| matches!(index, 4 | 7) || character.is_ascii_digit())
}

fn heat_level(value_ms: i64, threshold_min: i64) -> u8 {
    if value_ms <= 0 {
        return 0;
    }
    let threshold_ms = threshold_min.saturating_mul(60_000);
    if threshold_ms <= 0 {
        return 4;
    }
    let ratio = value_ms as f64 / threshold_ms as f64;
    if ratio <= 0.25 {
        1
    } else if ratio <= 0.5 {
        2
    } else if ratio <= 0.75 {
        3
    } else {
        4
    }
}

fn progress_day(record: db::DailyProgressRecord, today: &str) -> ProgressDay {
    let observed_ms = record.useful_ms + record.neutral_ms + record.waste_ms;
    let useful_passed = record.useful_ms >= record.useful_goal_min.saturating_mul(60_000);
    let waste_passed = record.waste_ms <= record.waste_limit_min.saturating_mul(60_000);
    let observed_passed = observed_ms >= record.observed_min.saturating_mul(60_000);
    let future = record.local_date.as_str() > today;
    ProgressDay {
        local_date: record.local_date,
        useful_ms: record.useful_ms,
        neutral_ms: record.neutral_ms,
        waste_ms: record.waste_ms,
        observed_ms,
        useful_goal_min: record.useful_goal_min,
        waste_limit_min: record.waste_limit_min,
        observed_min: record.observed_min,
        useful_passed,
        waste_passed,
        observed_passed,
        passed: !future && useful_passed && waste_passed && observed_passed,
        useful_level: heat_level(record.useful_ms, record.useful_goal_min),
        waste_level: heat_level(record.waste_ms, record.waste_limit_min),
        future,
    }
}

#[tauri::command]
fn get_progress_overview() -> Result<ProgressOverview, String> {
    let connection = db::open()?;
    let today_date = connection
        .query_row("SELECT date('now', 'localtime')", [], |row| {
            row.get::<_, String>(0)
        })
        .map_err(|error| error.to_string())?;
    let calendar = db::progress_series(&connection)?
        .into_iter()
        .map(|record| progress_day(record, &today_date))
        .collect::<Vec<_>>();
    let today = calendar
        .iter()
        .find(|day| day.local_date == today_date)
        .cloned()
        .ok_or_else(|| "today is outside the progress calendar".to_string())?;
    let historical_xp = connection
        .query_row(
            "SELECT COALESCE(SUM(xp), 0) FROM daily_stats
             WHERE local_date < date('now', 'localtime')",
            [],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|error| error.to_string())?;
    let lifetime_xp = historical_xp + today.useful_ms / 60_000;
    let today_afk_ms = db::afk_duration_for_day(&connection, &today_date)?;
    let (current_rank, current_rank_threshold, next) = rank_for_xp(lifetime_xp);

    Ok(ProgressOverview {
        today,
        today_afk_ms,
        lifetime_xp,
        current_rank,
        current_rank_threshold,
        next_rank: next.map(|(name, _)| name),
        next_rank_threshold: next.map(|(_, threshold)| threshold),
        calendar,
    })
}

#[tauri::command]
fn get_daily_series(days: i64) -> Result<Vec<DailySeriesDay>, String> {
    let connection = db::open()?;
    db::daily_series(&connection, days).map(|series| {
        series
            .into_iter()
            .map(|day| DailySeriesDay {
                local_date: day.local_date,
                useful_ms: day.useful_ms,
                neutral_ms: day.neutral_ms,
                waste_ms: day.waste_ms,
                observed_ms: day.observed_ms,
                useful_goal_min: day.useful_goal_min,
                waste_limit_min: day.waste_limit_min,
                observed_min: day.observed_min,
                passed: day.passed,
                useful_xp: day.useful_xp,
                useful_ma_7d_ms: day.useful_ma_7d_ms,
            })
            .collect()
    })
}

#[tauri::command]
fn get_afk_series(days: i64) -> Result<Vec<AfkDay>, String> {
    let connection = db::open()?;
    db::afk_series(&connection, days).map(|series| {
        series
            .into_iter()
            .map(|day| AfkDay {
                local_date: day.local_date,
                afk_ms: day.afk_ms,
            })
            .collect()
    })
}

#[tauri::command]
fn mini_hourly(limit_hours: i64) -> Result<Vec<MiniHourlyBucket>, String> {
    if !(1..=24).contains(&limit_hours) {
        return Err("limit_hours must be between 1 and 24".to_string());
    }
    let connection = db::open()?;
    db::mini_hourly(&connection, db::now_ms(), limit_hours).map(|buckets| {
        buckets
            .into_iter()
            .map(|bucket| MiniHourlyBucket {
                hour_ts: bucket.hour_ts,
                useful_ms: bucket.useful_ms,
                neutral_ms: bucket.neutral_ms,
                waste_ms: bucket.waste_ms,
            })
            .collect()
    })
}

fn load_day_print(connection: &rusqlite::Connection, local_date: &str) -> Result<DayPrint, String> {
    let valid_date = connection
        .query_row("SELECT COALESCE(date(?1) = ?1, 0)", [local_date], |row| {
            row.get::<_, bool>(0)
        })
        .map_err(|error| error.to_string())?;
    if !valid_date {
        return Err("Дата должна быть в формате YYYY-MM-DD".to_string());
    }
    let today = connection
        .query_row("SELECT date('now', 'localtime')", [], |row| {
            row.get::<_, String>(0)
        })
        .map_err(|error| error.to_string())?;
    if local_date > today.as_str() {
        return Err("Печать будущего дня недоступна".to_string());
    }

    let (useful_ms, neutral_ms, waste_ms) = if local_date == today.as_str() {
        connection
            .query_row(
                "SELECT
                    COALESCE(SUM(CASE WHEN c.kind = 'useful' THEN o.duration_ms ELSE 0 END), 0),
                    COALESCE(SUM(CASE WHEN c.kind = 'neutral' THEN o.duration_ms ELSE 0 END), 0),
                    COALESCE(SUM(CASE WHEN c.kind = 'waste' THEN o.duration_ms ELSE 0 END), 0)
                 FROM segment_day_overlaps o
                 LEFT JOIN categories c ON c.id = o.category_id
                 WHERE o.local_date = ?1",
                [local_date],
                |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, i64>(2)?,
                    ))
                },
            )
            .map_err(|error| error.to_string())?
    } else {
        connection
            .query_row(
                "SELECT
                    COALESCE(SUM(CASE WHEN c.kind = 'useful' THEN ds.duration_ms ELSE 0 END), 0),
                    COALESCE(SUM(CASE WHEN c.kind = 'neutral' THEN ds.duration_ms ELSE 0 END), 0),
                    COALESCE(SUM(CASE WHEN c.kind = 'waste' THEN ds.duration_ms ELSE 0 END), 0)
                 FROM daily_stats ds
                 LEFT JOIN categories c ON c.id = ds.category_id
                 WHERE ds.local_date = ?1",
                [local_date],
                |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, i64>(2)?,
                    ))
                },
            )
            .map_err(|error| error.to_string())?
    };
    let (useful_goal_min, waste_limit_min, observed_min) = connection
        .query_row(
            "SELECT useful_goal_min, waste_limit_min, observed_min
             FROM goal_history
             WHERE effective_local_date <= ?1
             ORDER BY effective_local_date DESC LIMIT 1",
            [local_date],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, i64>(2)?,
                ))
            },
        )
        .map_err(|error| error.to_string())?;
    let afk_ms = db::afk_duration_for_day(connection, local_date)?;
    let observed_ms = useful_ms + neutral_ms + waste_ms;
    let useful_passed = useful_ms >= useful_goal_min.saturating_mul(60_000);
    let waste_passed = waste_ms <= waste_limit_min.saturating_mul(60_000);
    let observed_passed = observed_ms >= observed_min.saturating_mul(60_000);
    let passed = useful_passed && waste_passed && observed_passed;
    let public_xp = useful_ms / 60_000;
    let lifetime_xp = if local_date == today.as_str() {
        connection
            .query_row(
                "SELECT COALESCE(SUM(xp), 0) FROM daily_stats WHERE local_date < ?1",
                [local_date],
                |row| row.get::<_, i64>(0),
            )
            .map_err(|error| error.to_string())?
            + public_xp
    } else {
        connection
            .query_row(
                "SELECT COALESCE(SUM(xp), 0) FROM daily_stats WHERE local_date <= ?1",
                [local_date],
                |row| row.get::<_, i64>(0),
            )
            .map_err(|error| error.to_string())?
    };
    let (rank, _, _) = rank_for_xp(lifetime_xp);
    let hourly_rate = db::setting(connection, "hourly_rate")?
        .filter(|value| !value.is_empty())
        .map(|value| value.parse::<f64>().map_err(|error| error.to_string()))
        .transpose()?;
    let burned_rubles = hourly_rate.map(|rate| {
        let amount = waste_ms as f64 / 3_600_000.0 * rate;
        (amount * 100.0).round() / 100.0
    });
    let currency = db::setting(connection, "currency")?.unwrap_or_else(|| "₴".to_string());

    let mut statement = connection
        .prepare(
            "SELECT s.app, COALESCE(c.name, 'Без категории'), COALESCE(c.kind, 'neutral'),
                    COALESCE(c.id, 0) = 0,
                    SUM(o.duration_ms) AS duration_ms
             FROM segment_day_overlaps o
             JOIN segments s ON s.id = o.segment_id
             LEFT JOIN categories c ON c.id = o.category_id
             WHERE o.local_date = ?1
             GROUP BY s.app, c.id
             ORDER BY duration_ms DESC, s.app ASC
             LIMIT 5",
        )
        .map_err(|error| error.to_string())?;
    let top_entries = statement
        .query_map([local_date], |row| {
            Ok(DayPrintEntry {
                app: row.get(0)?,
                category_name: row.get(1)?,
                category_kind: row.get(2)?,
                is_uncategorized: row.get(3)?,
                duration_ms: row.get(4)?,
            })
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    let challenge = connection
        .query_row(
            "SELECT code, useful_goal_min, waste_limit_min, observed_min
             FROM challenge_history WHERE local_date = ?1",
            [local_date],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, i64>(3)?,
                ))
            },
        )
        .optional()
        .map_err(|error| error.to_string())?;
    let challenge_passed = challenge.as_ref().map(|(_, useful, waste, observed)| {
        useful_ms >= useful.saturating_mul(60_000)
            && waste_ms <= waste.saturating_mul(60_000)
            && observed_ms >= observed.saturating_mul(60_000)
    });

    Ok(DayPrint {
        local_date: local_date.to_string(),
        useful_ms,
        neutral_ms,
        waste_ms,
        afk_ms,
        observed_ms,
        useful_goal_min,
        waste_limit_min,
        observed_min,
        useful_passed,
        waste_passed,
        observed_passed,
        passed,
        public_xp,
        lifetime_xp,
        rank,
        burned_rubles,
        currency,
        top_entries,
        challenge_code: challenge.map(|(code, _, _, _)| code),
        challenge_passed,
    })
}

#[tauri::command]
fn get_day_print(local_date: String) -> Result<DayPrint, String> {
    let connection = db::open()?;
    load_day_print(&connection, &local_date)
}

#[tauri::command]
fn get_day_print_dates() -> Result<Vec<String>, String> {
    let connection = db::open()?;
    let mut statement = connection
        .prepare(
            "WITH RECURSIVE calendar(local_date, position) AS (
                SELECT date('now', 'localtime', '-35 days'), 0
                UNION ALL
                SELECT date(local_date, '+1 day'), position + 1
                FROM calendar WHERE position < 35
             ), bounds AS (
                SELECT local_date,
                       CAST(strftime('%s', local_date || ' 00:00:00', 'utc') AS INTEGER) * 1000 AS day_start_ms,
                       CAST(strftime('%s', local_date || ' 00:00:00', '+1 day', 'utc') AS INTEGER) * 1000 AS day_end_ms
                FROM calendar
             )
             SELECT local_date
             FROM bounds
             WHERE EXISTS (
                       SELECT 1 FROM segment_day_overlaps o WHERE o.local_date = bounds.local_date
                   )
                OR EXISTS (
                       SELECT 1 FROM segments s
                       WHERE s.status = 'away'
                         AND s.ts_end > bounds.day_start_ms
                         AND s.ts_start < bounds.day_end_ms
                   )
             ORDER BY local_date DESC
             LIMIT 36",
        )
        .map_err(|error| error.to_string())?;
    let records = statement
        .query_map([], |row| row.get(0))
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    drop(statement);
    drop(connection);
    Ok(records)
}

#[tauri::command]
fn get_week_summary() -> Result<WeekSummary, String> {
    let connection = db::open()?;
    let mut statement = connection
        .prepare(
            "WITH RECURSIVE dates(local_date, position) AS (
                SELECT date('now', 'localtime', '-6 days'), 0
                UNION ALL
                SELECT date(local_date, '+1 day'), position + 1 FROM dates WHERE position < 6
             ) SELECT local_date FROM dates ORDER BY local_date",
        )
        .map_err(|error| error.to_string())?;
    let dates = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    drop(statement);
    let days = dates
        .iter()
        .map(|date| load_day_print(&connection, date))
        .collect::<Result<Vec<_>, _>>()?;
    let useful_ms = days.iter().map(|day| day.useful_ms).sum();
    let neutral_ms = days.iter().map(|day| day.neutral_ms).sum();
    let waste_ms = days.iter().map(|day| day.waste_ms).sum();
    let afk_ms = days.iter().map(|day| day.afk_ms).sum();
    let strongest_day = days
        .iter()
        .filter(|day| day.observed_ms > 0)
        .max_by_key(|day| day.useful_ms)
        .map(|day| day.local_date.clone());
    let burned_rubles = if days.iter().any(|day| day.burned_rubles.is_some()) {
        Some(days.iter().filter_map(|day| day.burned_rubles).sum())
    } else {
        None
    };
    let lifetime_xp = days.last().map_or(0, |day| day.lifetime_xp);
    let (rank, _, _) = rank_for_xp(lifetime_xp);
    let currency = days
        .first()
        .map(|day| day.currency.clone())
        .unwrap_or_else(|| "₴".to_string());
    Ok(WeekSummary {
        passed_count: days.iter().filter(|day| day.passed).count(),
        week_xp: days.iter().map(|day| day.public_xp).sum(),
        waste_days: days
            .iter()
            .filter(|day| day.waste_ms > day.waste_limit_min.saturating_mul(60_000))
            .count(),
        days,
        useful_ms,
        neutral_ms,
        waste_ms,
        afk_ms,
        lifetime_xp,
        rank,
        strongest_day,
        burned_rubles,
        currency,
    })
}

#[tauri::command]
fn import_challenge(code: String) -> Result<ImportedChallenge, String> {
    let connection = db::open()?;
    let (useful_goal_min, waste_limit_min, observed_min) =
        db::import_challenge(&connection, &code)?;
    Ok(ImportedChallenge {
        code,
        useful_goal_min,
        waste_limit_min,
        observed_min,
    })
}

#[tauri::command]
async fn save_png(
    app: tauri::AppHandle,
    file_name: String,
    png_bytes: Vec<u8>,
) -> Result<bool, String> {
    if !file_name.ends_with(".png")
        || file_name
            .chars()
            .any(|character| matches!(character, '/' | '\\'))
        || png_bytes.len() > 20 * 1024 * 1024
        || !png_bytes.starts_with(&[137, 80, 78, 71, 13, 10, 26, 10])
    {
        return Err("Некорректный PNG-файл".to_string());
    }
    let selected = app
        .dialog()
        .file()
        .add_filter("PNG", &["png"])
        .set_file_name(&file_name)
        .blocking_save_file();
    let Some(path) = selected else {
        return Ok(false);
    };
    let path = path.into_path().map_err(|error| error.to_string())?;
    std::fs::write(path, png_bytes).map_err(|error| error.to_string())?;
    Ok(true)
}

#[derive(Serialize)]
struct Category {
    id: i64,
    name: String,
    color: String,
    icon: String,
    kind: String,
    goal_multiplier: f64,
    sort_order: i64,
    parent_id: Option<i64>,
    score: f64,
    inherit_color: bool,
    inherit_score: bool,
    effective_color: String,
    effective_score: f64,
    full_path: String,
}

impl From<db::CategoryRecord> for Category {
    fn from(category: db::CategoryRecord) -> Self {
        Self {
            id: category.id,
            name: category.name,
            color: category.color,
            icon: category.icon,
            kind: category.kind,
            goal_multiplier: category.goal_multiplier,
            sort_order: category.sort_order,
            parent_id: category.parent_id,
            score: category.score,
            inherit_color: category.inherit_color,
            inherit_score: category.inherit_score,
            effective_color: category.effective_color,
            effective_score: category.effective_score,
            full_path: category.full_path,
        }
    }
}

#[derive(Serialize)]
struct Rule {
    id: i64,
    match_type: String,
    pattern: String,
    category_id: i64,
    priority: i64,
    match_mode: String,
    case_insensitive: bool,
}

#[derive(Serialize)]
struct RulePreview {
    matched_values: i64,
    total_values: i64,
    matched_duration_ms: i64,
    broad_warning: bool,
}

#[derive(Serialize)]
struct ScoringCategory {
    category_id: i64,
    name: String,
    full_path: String,
    effective_color: String,
    icon: String,
    duration_ms: i64,
    points: f64,
}

#[derive(Serialize)]
struct TodayScoring {
    total_score: f64,
    productive_percent: f64,
    top_productive: Vec<ScoringCategory>,
    top_distracting: Vec<ScoringCategory>,
    top_categories: Vec<ScoringCategory>,
}

impl From<db::ScoringCategoryRecord> for ScoringCategory {
    fn from(record: db::ScoringCategoryRecord) -> Self {
        Self {
            category_id: record.category_id,
            name: record.name,
            full_path: record.full_path,
            effective_color: record.effective_color,
            icon: record.icon,
            duration_ms: record.duration_ms,
            points: record.points,
        }
    }
}

#[derive(Serialize)]
struct AppToday {
    app: String,
    duration_ms: i64,
    useful_ms: i64,
    neutral_ms: i64,
    waste_ms: i64,
}

#[tauri::command]
fn get_today_segments() -> Result<Vec<Segment>, String> {
    let connection = db::open()?;
    let mut statement = connection
        .prepare(
            "WITH bounds AS (
                SELECT CAST(strftime('%s', date('now', 'localtime') || ' 00:00:00', 'utc') AS INTEGER) * 1000 AS day_start_ms,
                       CAST(strftime('%s', date('now', 'localtime') || ' 00:00:00', '+1 day', 'utc') AS INTEGER) * 1000 AS day_end_ms
             )
             SELECT segments.id,
                    MAX(segments.ts_start, bounds.day_start_ms),
                    MIN(segments.ts_end, bounds.day_end_ms),
                    segments.app, segments.window_title, segments.domain,
                    COALESCE(segments.category_id, 0), segments.status
             FROM segments CROSS JOIN bounds
             WHERE segments.ts_end > bounds.day_start_ms
               AND segments.ts_start < bounds.day_end_ms
             ORDER BY segments.ts_start ASC",
        )
        .map_err(|error| error.to_string())?;
    let segments = statement
        .query_map([], |row| {
            Ok(Segment {
                id: row.get(0)?,
                ts_start: row.get(1)?,
                ts_end: row.get(2)?,
                app: row.get(3)?,
                window_title: row.get(4)?,
                domain: row.get(5)?,
                category_id: row.get(6)?,
                status: row.get(7)?,
            })
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    Ok(segments)
}

#[tauri::command]
fn get_today_cumulative() -> Result<TodayCumulative, String> {
    let connection = db::open()?;
    let cumulative = db::today_cumulative(&connection, db::now_ms())?;
    Ok(TodayCumulative {
        points: cumulative
            .points
            .into_iter()
            .map(|point| CumulativePoint {
                timestamp_ms: point.timestamp_ms,
                hour: point.hour,
                useful_ms: point.useful_ms,
                waste_ms: point.waste_ms,
                is_current: point.is_current,
            })
            .collect(),
        useful_goal_min: cumulative.useful_goal_min,
        waste_limit_min: cumulative.waste_limit_min,
    })
}

#[tauri::command]
fn get_today_stats() -> Result<TodayStats, String> {
    let connection = db::open()?;
    connection
        .query_row(
            "SELECT
                COALESCE(SUM(CASE WHEN c.kind = 'useful' THEN o.duration_ms ELSE 0 END), 0),
                COALESCE(SUM(CASE WHEN c.kind = 'neutral' THEN o.duration_ms ELSE 0 END), 0),
                COALESCE(SUM(CASE WHEN c.kind = 'waste' THEN o.duration_ms ELSE 0 END), 0)
             FROM segment_day_overlaps o
             LEFT JOIN categories c ON c.id = o.category_id
             WHERE o.local_date = date('now', 'localtime')",
            [],
            |row| {
                let useful_ms = row.get(0)?;
                let neutral_ms = row.get(1)?;
                let waste_ms = row.get(2)?;
                Ok(TodayStats {
                    useful_ms,
                    neutral_ms,
                    waste_ms,
                    observed_ms: useful_ms + neutral_ms + waste_ms,
                })
            },
        )
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn get_categories() -> Result<Vec<Category>, String> {
    let connection = db::open()?;
    Ok(db::list_categories(&connection)?
        .into_iter()
        .map(Category::from)
        .collect())
}

#[tauri::command]
fn create_category(
    name: String,
    color: String,
    icon: String,
    kind: String,
    parent_id: Option<i64>,
    score: f64,
    inherit_color: bool,
    inherit_score: bool,
) -> Result<Category, String> {
    validate_category_icon(&icon)?;
    db::create_category(db::CategoryValues {
        name: &name,
        color: &color,
        icon: &icon,
        kind: &kind,
        parent_id,
        score,
        inherit_color,
        inherit_score,
    })
    .map(Category::from)
}

#[tauri::command]
fn update_category(
    id: i64,
    name: String,
    color: String,
    icon: String,
    kind: String,
    parent_id: Option<i64>,
    score: f64,
    inherit_color: bool,
    inherit_score: bool,
) -> Result<Category, String> {
    validate_category_icon(&icon)?;
    db::update_category(
        id,
        db::CategoryValues {
            name: &name,
            color: &color,
            icon: &icon,
            kind: &kind,
            parent_id,
            score,
            inherit_color,
            inherit_score,
        },
    )
    .map(Category::from)
}

#[tauri::command]
fn delete_category(id: i64) -> Result<(), String> {
    db::delete_category(id)
}

#[tauri::command]
fn get_rules() -> Result<Vec<Rule>, String> {
    let connection = db::open()?;
    let mut statement = connection
        .prepare(
            "SELECT id, match_type, pattern, category_id, priority, match_mode, case_insensitive
             FROM rules
             ORDER BY priority DESC,
                      CASE match_type WHEN 'domain' THEN 3 WHEN 'title' THEN 2 ELSE 1 END DESC,
                      id ASC",
        )
        .map_err(|error| error.to_string())?;
    let rules = statement
        .query_map([], |row| {
            Ok(Rule {
                id: row.get(0)?,
                match_type: row.get(1)?,
                pattern: row.get(2)?,
                category_id: row.get(3)?,
                priority: row.get(4)?,
                match_mode: row.get(5)?,
                case_insensitive: row.get::<_, i64>(6)? == 1,
            })
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    Ok(rules)
}

fn rule_duplicate_error(connection: &rusqlite::Connection) -> String {
    match db::setting(connection, "language")
        .ok()
        .flatten()
        .as_deref()
    {
        Some("ua") => "Таке правило вже існує для цієї категорії".to_string(),
        Some("en") => "This rule already exists for this category".to_string(),
        _ => "Такое правило уже существует для этой категории".to_string(),
    }
}

fn ensure_rule_unique(
    connection: &rusqlite::Connection,
    excluded_rule_id: Option<i64>,
    category_id: i64,
    match_type: &str,
    match_mode: &str,
    pattern: &str,
    case_insensitive: bool,
) -> Result<(), String> {
    let duplicate_exists = connection
        .query_row(
            "SELECT 1 FROM rules
             WHERE category_id = ?1
               AND match_type = ?2
               AND match_mode = ?3
               AND pattern = ?4
               AND case_insensitive = ?5
               AND (?6 IS NULL OR id <> ?6)
             LIMIT 1",
            params![
                category_id,
                match_type,
                match_mode,
                pattern,
                i64::from(case_insensitive),
                excluded_rule_id,
            ],
            |_| Ok(true),
        )
        .optional()
        .map_err(|error| error.to_string())?
        .unwrap_or(false);
    if duplicate_exists {
        Err(rule_duplicate_error(connection))
    } else {
        Ok(())
    }
}

fn rule_write_error(connection: &rusqlite::Connection, error: rusqlite::Error) -> String {
    let message = error.to_string();
    if message.contains("UNIQUE constraint failed: rules.category_id") {
        rule_duplicate_error(connection)
    } else {
        message
    }
}

#[tauri::command]
fn create_rule(
    match_type: String,
    pattern: String,
    category_id: i64,
    priority: i64,
    match_mode: String,
    case_insensitive: bool,
) -> Result<Rule, String> {
    if category_id == 0 {
        return Err("Без категории нельзя привязать".to_string());
    }
    if !matches!(match_type.as_str(), "exe" | "title" | "domain" | "any") {
        return Err("invalid match type".to_string());
    }
    let normalized = rules::normalize_pattern(&pattern);
    rules::RuleSet::compile(vec![rules::RuleDefinition {
        id: 0,
        match_type: match_type.clone(),
        pattern: normalized.clone(),
        category_id,
        priority,
        match_mode: match_mode.clone(),
        case_insensitive,
    }])?;

    let mut connection = db::open()?;
    let category_exists = connection
        .query_row(
            "SELECT 1 FROM categories WHERE id = ?1",
            [category_id],
            |_| Ok(true),
        )
        .optional()
        .map_err(|error| error.to_string())?
        .unwrap_or(false);
    if !category_exists {
        return Err("category does not exist".to_string());
    }
    ensure_rule_unique(
        &connection,
        None,
        category_id,
        &match_type,
        &match_mode,
        &normalized,
        case_insensitive,
    )?;

    connection
        .execute(
            "INSERT INTO rules (
                match_type, pattern, category_id, priority, created_at, match_mode, case_insensitive
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                match_type,
                normalized,
                category_id,
                priority,
                db::now_ms(),
                match_mode,
                i64::from(case_insensitive),
            ],
        )
        .map_err(|error| rule_write_error(&connection, error))?;
    let id = connection.last_insert_rowid();
    db::bump_rules_revision(&connection)?;
    // Правило изменилось — сразу перекрашиваем историю (не-manual сегменты),
    // иначе старые сегменты висят без категории до ручной перекраски.
    db::reclassify_history(&mut connection, false, None, None)?;
    Ok(Rule {
        id,
        match_type,
        pattern: normalized,
        category_id,
        priority,
        match_mode,
        case_insensitive,
    })
}

#[tauri::command]
fn update_rule(
    id: i64,
    match_type: String,
    pattern: String,
    category_id: i64,
    priority: i64,
    match_mode: String,
    case_insensitive: bool,
) -> Result<(), String> {
    if id <= 0 {
        return Err("invalid rule id".to_string());
    }
    if category_id == 0 {
        return Err("Без категории нельзя привязать".to_string());
    }

    let normalized = rules::normalize_pattern(&pattern);
    rules::RuleSet::compile(vec![rules::RuleDefinition {
        id,
        match_type: match_type.clone(),
        pattern: normalized.clone(),
        category_id,
        priority,
        match_mode: match_mode.clone(),
        case_insensitive,
    }])?;
    let mut connection = db::open()?;
    ensure_rule_unique(
        &connection,
        Some(id),
        category_id,
        &match_type,
        &match_mode,
        &normalized,
        case_insensitive,
    )?;
    let updated = connection
        .execute(
            "UPDATE rules SET match_type = ?1, pattern = ?2, category_id = ?3,
                              priority = ?4, match_mode = ?5, case_insensitive = ?6
             WHERE id = ?7",
            params![
                match_type,
                normalized,
                category_id,
                priority,
                match_mode,
                i64::from(case_insensitive),
                id,
            ],
        )
        .map_err(|error| rule_write_error(&connection, error))?;
    if updated == 0 {
        return Err("rule does not exist".to_string());
    }
    db::bump_rules_revision(&connection)?;
    // Правило изменилось — сразу перекрашиваем историю (не-manual сегменты).
    db::reclassify_history(&mut connection, false, None, None)?;
    Ok(())
}

#[tauri::command]
fn delete_rule(id: i64) -> Result<(), String> {
    if id <= 0 {
        return Err("invalid rule id".to_string());
    }
    let mut connection = db::open()?;
    connection
        .execute("DELETE FROM rules WHERE id = ?1", [id])
        .map_err(|error| error.to_string())?;
    db::bump_rules_revision(&connection)?;
    // Правило удалено — возвращаем затронутые сегменты следующему матчу (или Без категории).
    db::reclassify_history(&mut connection, false, None, None)?;
    Ok(())
}

#[tauri::command]
fn preview_rule(
    match_type: String,
    pattern: String,
    match_mode: String,
    case_insensitive: bool,
) -> Result<RulePreview, String> {
    let connection = db::open()?;
    let preview = rules::RuleSet::preview(
        &connection,
        rules::RuleDefinition {
            id: 0,
            match_type,
            pattern: rules::normalize_pattern(&pattern),
            category_id: 1,
            priority: 0,
            match_mode,
            case_insensitive,
        },
        db::now_ms(),
    )?;
    Ok(RulePreview {
        matched_values: preview.matched_values,
        total_values: preview.total_values,
        matched_duration_ms: preview.matched_duration_ms,
        broad_warning: preview.broad_warning,
    })
}

#[tauri::command]
fn get_today_scoring() -> Result<TodayScoring, String> {
    let connection = db::open()?;
    let scoring = db::today_scoring(&connection)?;
    Ok(TodayScoring {
        total_score: scoring.total_score,
        productive_percent: scoring.productive_percent,
        top_productive: scoring
            .top_productive
            .into_iter()
            .map(ScoringCategory::from)
            .collect(),
        top_distracting: scoring
            .top_distracting
            .into_iter()
            .map(ScoringCategory::from)
            .collect(),
        top_categories: scoring
            .top_categories
            .into_iter()
            .map(ScoringCategory::from)
            .collect(),
    })
}

#[tauri::command]
fn get_settings() -> Result<HashMap<String, String>, String> {
    let connection = db::open()?;
    let mut statement = connection
        .prepare("SELECT key, value FROM settings ORDER BY key")
        .map_err(|error| error.to_string())?;
    let settings = statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<HashMap<_, _>, _>>()
        .map_err(|error| error.to_string())?;
    Ok(settings)
}

#[tauri::command]
fn set_setting(key: String, value: String, app: tauri::AppHandle) -> Result<(), String> {
    let valid = match key.as_str() {
        "useful_goal_min" | "waste_limit_min" | "observed_min" | "idle_timeout_min" => {
            value.parse::<u32>().is_ok_and(|number| number <= 1440)
        }
        "hourly_rate" => value.is_empty() || value.parse::<f64>().is_ok_and(|number| number >= 0.0),
        "theme" => matches!(value.as_str(), "dawn" | "dark"),
        "language" => matches!(value.as_str(), "ru" | "ua" | "en"),
        "currency" => matches!(value.as_str(), "₴" | "$" | "€" | "₽"),
        "onboarding_done"
        | "tray_only"
        | "mini_observed_explained_v1"
        | "mini_privacy_now"
        | "mini_click_through"
        | "mini_corner_tuck" => matches!(value.as_str(), "0" | "1"),
        "mini_mode" => matches!(value.as_str(), "auto" | "compact" | "detailed"),
        "mini_text_size" => matches!(value.as_str(), "normal" | "large"),
        "mini_opacity" => value
            .parse::<u8>()
            .is_ok_and(|opacity| (60..=100).contains(&opacity)),
        "last_day_print_seen" => local_date_format_is_valid(&value),
        "kind_label_useful" | "kind_label_neutral" | "kind_label_waste" | "kind_label_observed" => {
            !value.trim().is_empty() && value.chars().count() <= 80
        }
        "extension_chrome_id" | "extension_edge_id" => {
            value.is_empty()
                || (value.len() == 32
                    && value
                        .chars()
                        .all(|character| ('a'..='p').contains(&character)))
        }
        _ => false,
    };
    if !valid {
        return Err("invalid setting or value".to_string());
    }

    if key == "mini_opacity" {
        let opacity = value.parse::<u8>().map_err(|error| error.to_string())?;
        let mini = app
            .get_webview_window("mini")
            .ok_or_else(|| "mini-window is unavailable".to_string())?;
        let connection = db::open()?;
        let previous_opacity = db::setting(&connection, "mini_opacity")?
            .and_then(|saved| saved.parse::<u8>().ok())
            .filter(|saved| (60..=100).contains(saved))
            .unwrap_or(100);
        tray::apply_mini_opacity(&mini, opacity)?;
        if let Err(error) = db::set_setting(&connection, &key, &value) {
            let _ = tray::apply_mini_opacity(&mini, previous_opacity);
            return Err(error);
        }
        return Ok(());
    }

    if key == "mini_click_through" {
        let enabled = value == "1";
        tray::set_mini_click_through(&app, enabled)?;
        return Ok(());
    }
    if key == "mini_corner_tuck" {
        let tucked = value == "1";
        tray::set_mini_tuck(&app, tucked)?;
        return Ok(());
    }

    let connection = db::open()?;
    db::set_setting(&connection, &key, &value)
}

#[tauri::command]
fn set_segment_category(
    segment_id: i64,
    category_id: Option<i64>,
    remember: bool,
    rule_priority: Option<i64>,
) -> Result<(), String> {
    if segment_id <= 0 {
        return Err("invalid segment id".to_string());
    }
    let mut connection = db::open()?;
    if let Some(id) = category_id {
        let exists = connection
            .query_row("SELECT 1 FROM categories WHERE id = ?1", [id], |_| Ok(true))
            .optional()
            .map_err(|error| error.to_string())?
            .unwrap_or(false);
        if !exists {
            return Err("category does not exist".to_string());
        }
    }
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    let app = transaction
        .query_row(
            "SELECT app FROM segments WHERE id = ?1",
            [segment_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "segment does not exist".to_string())?;
    transaction
        .execute(
            "UPDATE segments SET category_id = ?1, manual_category = 1 WHERE id = ?2",
            params![category_id, segment_id],
        )
        .map_err(|error| error.to_string())?;
    if remember {
        if let Some(id) = category_id.filter(|id| *id != 0) {
            db::upsert_exe_rule(&transaction, &app, id, rule_priority.unwrap_or(0))?;
        }
    }
    for local_date in db::segment_local_dates(&transaction, segment_id)? {
        db::refresh_daily_stats(&transaction, &local_date)?;
    }
    transaction.commit().map_err(|error| error.to_string())
}

#[tauri::command]
fn reclassify_history(
    overwrite_manual: bool,
    manual_match_type: Option<String>,
    manual_pattern: Option<String>,
    confirmed: bool,
) -> Result<ReclassificationSummary, String> {
    if !confirmed {
        return Err("historical replay requires explicit confirmation".to_string());
    }
    let mut connection = db::open()?;
    let summary = db::reclassify_history(
        &mut connection,
        overwrite_manual,
        manual_match_type.as_deref(),
        manual_pattern.as_deref(),
    )?;
    Ok(ReclassificationSummary {
        changed_segments: summary.changed_segments,
        changed_duration_ms: summary.changed_duration_ms,
    })
}

#[tauri::command]
fn preview_reclassify_history(overwrite_manual: bool) -> Result<ReclassificationSummary, String> {
    let mut connection = db::open()?;
    let summary = db::preview_reclassify_history(&mut connection, overwrite_manual)?;
    Ok(ReclassificationSummary {
        changed_segments: summary.changed_segments,
        changed_duration_ms: summary.changed_duration_ms,
    })
}

#[tauri::command]
fn get_classification_match_stats(
    match_type: String,
    pattern: String,
    match_mode: Option<String>,
    case_insensitive: Option<bool>,
) -> Result<ClassificationMatchStats, String> {
    let connection = db::open()?;
    let stats = db::classification_match_stats_with_mode(
        &connection,
        &match_type,
        &pattern,
        match_mode.as_deref().unwrap_or("legacy"),
        case_insensitive.unwrap_or(true),
    )?;
    Ok(ClassificationMatchStats {
        match_count: stats.match_count,
        manual_count: stats.manual_count,
    })
}

#[tauri::command]
fn get_db_size_mb() -> Result<f64, String> {
    let path = db::database_path()?;
    let bytes = match std::fs::metadata(path) {
        Ok(metadata) => metadata.len(),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(0.0),
        Err(error) => return Err(error.to_string()),
    };
    let size_mb = bytes as f64 / (1024.0 * 1024.0);
    Ok((size_mb * 10.0).round() / 10.0)
}

#[tauri::command]
fn get_apps_today() -> Result<Vec<AppToday>, String> {
    let connection = db::open()?;
    let mut statement = connection
        .prepare(
            "SELECT s.app,
                    SUM(o.duration_ms) AS duration_ms,
                    SUM(CASE WHEN c.kind = 'useful' THEN o.duration_ms ELSE 0 END),
                    SUM(CASE WHEN c.kind = 'neutral' THEN o.duration_ms ELSE 0 END),
                    SUM(CASE WHEN c.kind = 'waste' THEN o.duration_ms ELSE 0 END)
             FROM segment_day_overlaps o
             JOIN segments s ON s.id = o.segment_id
             LEFT JOIN categories c ON c.id = o.category_id
             WHERE o.local_date = date('now', 'localtime')
             GROUP BY s.app
             ORDER BY duration_ms DESC",
        )
        .map_err(|error| error.to_string())?;
    let apps = statement
        .query_map([], |row| {
            Ok(AppToday {
                app: row.get(0)?,
                duration_ms: row.get(1)?,
                useful_ms: row.get(2)?,
                neutral_ms: row.get(3)?,
                waste_ms: row.get(4)?,
            })
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    Ok(apps)
}

#[tauri::command]
fn set_tracking_paused(paused: bool, state: tauri::State<'_, TrackingControl>) {
    state.paused.store(paused, Ordering::Relaxed);
}

#[tauri::command]
fn get_tracking_paused(state: tauri::State<'_, TrackingControl>) -> bool {
    state.paused.load(Ordering::Relaxed)
}

#[tauri::command]
fn get_live_segment() -> Result<Option<LiveSegment>, String> {
    let connection = db::open()?;
    connection
        .query_row(
            "SELECT s.id, s.ts_start, s.ts_end, s.app, s.window_title, s.domain, s.status,
                    COALESCE(c.name, 'Без категории'), COALESCE(c.kind, 'neutral'),
                    COALESCE(c.id, 0) = 0
             FROM segments s
             LEFT JOIN categories c ON c.id = s.category_id
             WHERE s.id = CAST((SELECT value FROM settings WHERE key = 'active_segment_id') AS INTEGER)
               AND s.status IN ('active', 'away')",
            [],
            |row| {
                Ok(LiveSegment {
                    id: row.get(0)?,
                    ts_start: row.get(1)?,
                    ts_end: row.get(2)?,
                    app: row.get(3)?,
                    window_title: row.get(4)?,
                    domain: row.get(5)?,
                    status: row.get(6)?,
                    category_name: row.get(7)?,
                    category_kind: row.get(8)?,
                    is_uncategorized: row.get(9)?,
                })
            },
        )
        .optional()
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn show_dashboard(app: tauri::AppHandle) {
    tray::show_dashboard(&app);
}

#[tauri::command]
fn show_mini(app: tauri::AppHandle) -> Result<(), String> {
    tray::show_mini(&app)
}

#[tauri::command]
fn minimize_mini(app: tauri::AppHandle) -> Result<(), String> {
    tray::minimize_mini(&app)
}

#[tauri::command]
fn hide_mini(app: tauri::AppHandle) -> Result<(), String> {
    tray::hide_mini(&app)
}

#[tauri::command]
fn set_mini_pinned(pinned: bool, app: tauri::AppHandle) -> Result<(), String> {
    tray::set_mini_pinned(&app, pinned)
}

#[tauri::command]
fn get_mini_state(app: tauri::AppHandle) -> Result<tray::MiniState, String> {
    tray::get_mini_state(&app)
}

#[tauri::command]
fn save_mini_geometry(app: tauri::AppHandle) -> Result<(), String> {
    tray::save_mini_geometry(&app)
}

#[tauri::command]
fn resize_mini(
    width: f64,
    height: f64,
    force: Option<bool>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    tray::resize_mini(&app, width, height, force.unwrap_or(false))
}

#[tauri::command]
fn set_mini_resizable(resizable: bool, app: tauri::AppHandle) -> Result<(), String> {
    tray::set_mini_resizable(&app, resizable)
}

#[tauri::command]
fn tuck_mini_position(tucked: bool, app: tauri::AppHandle) -> Result<(), String> {
    tray::tuck_mini_position(&app, tucked)
}

#[tauri::command]
fn reset_mini_geometry(app: tauri::AppHandle) -> Result<(), String> {
    tray::reset_mini_geometry(&app)
}

#[tauri::command]
fn pin_mini_corner(corner: String, app: tauri::AppHandle) -> Result<(), String> {
    tray::pin_mini_corner(&app, &corner)
}

#[tauri::command]
fn start_mini_drag(window: tauri::WebviewWindow) -> Result<(), String> {
    if window.label() != "mini" {
        return Err("dragging is only available for the mini-window".to_string());
    }
    let connection = db::open()?;
    if db::setting(&connection, "mini_corner")?.is_some_and(|corner| !corner.is_empty()) {
        return Ok(());
    }
    window.start_dragging().map_err(|error| error.to_string())
}

#[tauri::command]
fn get_autostart(app: tauri::AppHandle) -> Result<bool, String> {
    app.autolaunch()
        .is_enabled()
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn set_autostart(app: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    let autolaunch = app.autolaunch();
    if enabled {
        autolaunch.enable()
    } else {
        autolaunch.disable()
    }
    .map_err(|error| error.to_string())
}

#[derive(serde::Serialize)]
struct UpdateInfo {
    version: String,
}

#[derive(Clone, serde::Serialize)]
struct UpdateProgress {
    downloaded: u64,
    total: u64,
}

#[tauri::command]
async fn check_for_updates(app: tauri::AppHandle) -> Result<Option<UpdateInfo>, String> {
    let updater = app.updater().map_err(|error| error.to_string())?;
    let update = updater.check().await.map_err(|error| error.to_string())?;
    Ok(update.map(|update| UpdateInfo {
        version: update.version,
    }))
}

#[tauri::command]
async fn download_and_install_update(app: tauri::AppHandle, version: String) -> Result<(), String> {
    let updater = app.updater().map_err(|error| error.to_string())?;
    let update = updater
        .check()
        .await
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "update is no longer available".to_string())?;

    if update.version != version {
        return Err(format!(
            "available update changed from {version} to {}",
            update.version
        ));
    }

    let progress_app = app.clone();
    let mut downloaded = 0_u64;
    update
        .download_and_install(
            move |chunk_length, content_length| {
                downloaded = downloaded.saturating_add(chunk_length as u64);
                let _ = progress_app.emit(
                    "update://progress",
                    UpdateProgress {
                        downloaded,
                        total: content_length.unwrap_or(0),
                    },
                );
            },
            || {},
        )
        .await
        .map_err(|error| error.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let paused = Arc::new(AtomicBool::new(false));
    let service_handles: ServiceHandles = Arc::new(Mutex::new(None));
    let setup_handles = Arc::clone(&service_handles);
    let setup_paused = Arc::clone(&paused);

    let mut builder = tauri::Builder::default();

    #[cfg(desktop)]
    {
        // Single-instance должен быть первым плагином: только primary запускает сервисы.
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            tray::show_dashboard(app);
        }));
    }

    builder = builder
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec![]),
        ))
        .manage(TrackingControl {
            paused: Arc::clone(&paused),
        })
        .on_window_event(|window, event| match event {
            tauri::WindowEvent::CloseRequested { api, .. } => {
                api.prevent_close();
                if window.label() == "mini" {
                    let _ = tray::save_mini_geometry(window.app_handle());
                    if let Ok(connection) = db::open() {
                        let _ = db::set_setting(&connection, "mini_visible", "0");
                    }
                }
                let _ = window.hide();
            }
            tauri::WindowEvent::Focused(false) if window.label() == "mini" => {
                if !window.is_minimized().unwrap_or(false) {
                    let _ = tray::save_mini_geometry(window.app_handle());
                    let _ = tray::enforce_mini_topmost(window);
                }
            }
            _ => {}
        })
        .setup(move |app| {
            db::initialize().map_err(std::io::Error::other)?;
            let stop = Arc::new(AtomicBool::new(false));
            let (sender, receiver) = mpsc::channel();
            let watcher_handle =
                watcher::spawn(receiver, Arc::clone(&stop), Arc::clone(&setup_paused));
            let http_handle = http::spawn(sender, Arc::clone(&stop));
            let tray_handle =
                tray::install(app.handle(), Arc::clone(&setup_paused), Arc::clone(&stop))
                    .map_err(std::io::Error::other)?;
            tray::restore_window_state(app.handle()).map_err(std::io::Error::other)?;
            let mut handles = setup_handles
                .lock()
                .map_err(|_| std::io::Error::other("service handles are poisoned"))?;
            *handles = Some((stop, watcher_handle, http_handle, tray_handle));
            Ok(())
        });

    let app = builder
        .invoke_handler(tauri::generate_handler![
            get_today_segments,
            get_today_stats,
            get_today_scoring,
            get_today_cumulative,
            get_progress_overview,
            get_daily_series,
            get_afk_series,
            mini_hourly,
            get_day_print,
            get_day_print_dates,
            get_week_summary,
            import_challenge,
            save_png,
            get_categories,
            create_category,
            update_category,
            delete_category,
            get_rules,
            create_rule,
            update_rule,
            delete_rule,
            preview_rule,
            get_settings,
            set_setting,
            set_segment_category,
            reclassify_history,
            preview_reclassify_history,
            get_classification_match_stats,
            get_db_size_mb,
            get_apps_today,
            set_tracking_paused,
            get_tracking_paused,
            get_live_segment,
            show_dashboard,
            show_mini,
            minimize_mini,
            hide_mini,
            set_mini_pinned,
            get_mini_state,
            save_mini_geometry,
            resize_mini,
            set_mini_resizable,
            tuck_mini_position,
            reset_mini_geometry,
            pin_mini_corner,
            start_mini_drag,
            get_autostart,
            set_autostart,
            check_for_updates,
            download_and_install_update,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Tauri application");

    let exit_handles = Arc::clone(&service_handles);
    app.run(move |app, event| {
        if matches!(
            event,
            tauri::RunEvent::Exit | tauri::RunEvent::ExitRequested { .. }
        ) {
            let _ = tray::save_mini_geometry(app);
            if let Ok(handles) = exit_handles.lock() {
                if let Some((stop, _, _, _)) = handles.as_ref() {
                    stop.store(true, Ordering::Relaxed);
                }
            }
        }
    });
    if let Ok(mut handles) = service_handles.lock() {
        if let Some((stop, watcher_handle, http_handle, tray_handle)) = handles.take() {
            stop.store(true, Ordering::Relaxed);
            let _ = watcher_handle.join();
            let _ = http_handle.join();
            let _ = tray_handle.join();
        }
    };
}
