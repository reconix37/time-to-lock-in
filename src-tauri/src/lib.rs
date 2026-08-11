// Time To Lock In — точка входа и команды локального хранилища.

mod db;
mod http;
mod tray;
mod watcher;

use rusqlite::{params, OptionalExtension};
use serde::Serialize;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use tauri::Manager;

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
    let rank_index = RANKS
        .iter()
        .rposition(|(_, threshold)| lifetime_xp >= *threshold)
        .unwrap_or(0);
    let (current_rank, current_rank_threshold) = RANKS[rank_index];
    let next = RANKS.get(rank_index + 1).copied();

    Ok(ProgressOverview {
        today,
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

#[derive(Serialize)]
struct Category {
    id: i64,
    name: String,
    color: String,
    icon: String,
    kind: String,
    goal_multiplier: f64,
    sort_order: i64,
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
    let mut statement = connection
        .prepare(
            "SELECT id, name, color, icon, kind, goal_multiplier, sort_order
             FROM categories ORDER BY sort_order ASC, name ASC",
        )
        .map_err(|error| error.to_string())?;
    let categories = statement
        .query_map([], |row| {
            Ok(Category {
                id: row.get(0)?,
                name: row.get(1)?,
                color: row.get(2)?,
                icon: row.get(3)?,
                kind: row.get(4)?,
                goal_multiplier: row.get(5)?,
                sort_order: row.get(6)?,
            })
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    Ok(categories)
}

#[tauri::command]
fn create_category(name: String, color: String, kind: String) -> Result<Category, String> {
    db::create_category(&name, &color, &kind).map(Category::from)
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
            "SELECT id, match_type, pattern, category_id, priority
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
            })
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    Ok(rules)
}

#[tauri::command]
fn create_rule(
    match_type: String,
    pattern: String,
    category_id: i64,
    priority: i64,
) -> Result<Rule, String> {
    if category_id == 0 {
        return Err("Без категории нельзя привязать".to_string());
    }
    if !matches!(match_type.as_str(), "exe" | "title" | "domain") {
        return Err("invalid match type".to_string());
    }
    let normalized = pattern.trim().to_lowercase();
    if normalized.is_empty() || normalized.chars().count() > 500 {
        return Err("pattern must contain 1–500 characters".to_string());
    }

    let connection = db::open()?;
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

    connection
        .execute(
            "INSERT INTO rules (match_type, pattern, category_id, priority, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![match_type, normalized, category_id, priority, db::now_ms()],
        )
        .map_err(|error| error.to_string())?;
    Ok(Rule {
        id: connection.last_insert_rowid(),
        match_type,
        pattern: normalized,
        category_id,
        priority,
    })
}

#[tauri::command]
fn update_rule(id: i64, category_id: i64) -> Result<(), String> {
    if id <= 0 {
        return Err("invalid rule id".to_string());
    }
    if category_id == 0 {
        return Err("Без категории нельзя привязать".to_string());
    }

    let connection = db::open()?;
    let updated = connection
        .execute(
            "UPDATE rules SET category_id = ?1 WHERE id = ?2",
            params![category_id, id],
        )
        .map_err(|error| error.to_string())?;
    if updated == 0 {
        return Err("rule does not exist".to_string());
    }
    Ok(())
}

#[tauri::command]
fn delete_rule(id: i64) -> Result<(), String> {
    if id <= 0 {
        return Err("invalid rule id".to_string());
    }
    let connection = db::open()?;
    connection
        .execute("DELETE FROM rules WHERE id = ?1", [id])
        .map_err(|error| error.to_string())?;
    Ok(())
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
fn set_setting(key: String, value: String) -> Result<(), String> {
    let valid = match key.as_str() {
        "useful_goal_min" | "waste_limit_min" | "observed_min" | "idle_timeout_min" => {
            value.parse::<u32>().is_ok_and(|number| number <= 1440)
        }
        "hourly_rate" => value.is_empty() || value.parse::<f64>().is_ok_and(|number| number >= 0.0),
        "theme" => matches!(value.as_str(), "dawn" | "dark"),
        "onboarding_done" | "tray_only" => matches!(value.as_str(), "0" | "1"),
        "kind_label_useful" | "kind_label_neutral" | "kind_label_waste" => {
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

    let connection = db::open()?;
    db::set_setting(&connection, &key, &value)
}

#[tauri::command]
fn set_segment_category(
    segment_id: i64,
    category_id: Option<i64>,
    remember: bool,
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
            "UPDATE segments SET category_id = ?1 WHERE id = ?2",
            params![category_id, segment_id],
        )
        .map_err(|error| error.to_string())?;
    if remember {
        if let Some(id) = category_id.filter(|id| *id != 0) {
            db::upsert_exe_rule(&transaction, &app, id)?;
        }
    }
    for local_date in db::segment_local_dates(&transaction, segment_id)? {
        db::refresh_daily_stats(&transaction, &local_date)?;
    }
    transaction.commit().map_err(|error| error.to_string())
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
                    COALESCE(c.name, 'Без категории'), COALESCE(c.kind, 'neutral')
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
fn set_mini_pinned(pinned: bool, app: tauri::AppHandle) -> Result<(), String> {
    tray::set_mini_pinned(&app, pinned)
}

#[tauri::command]
fn fix_mini_window(app: tauri::AppHandle) -> Result<(), String> {
    tray::fix_mini_window(&app)
}

#[tauri::command]
fn start_mini_drag(window: tauri::WebviewWindow) -> Result<(), String> {
    if window.label() != "mini" {
        return Err("dragging is only available for the mini-window".to_string());
    }
    window.start_dragging().map_err(|error| error.to_string())
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
                    let _ = tray::save_mini_position(window.app_handle());
                } else if window.label() == "main" {
                    let _ = tray::remember_tray_only();
                }
                let _ = window.hide();
            }
            tauri::WindowEvent::Focused(false) if window.label() == "mini" => {
                let _ = tray::save_mini_position(window.app_handle());
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
            get_today_cumulative,
            get_progress_overview,
            get_daily_series,
            get_categories,
            create_category,
            delete_category,
            get_rules,
            create_rule,
            update_rule,
            delete_rule,
            get_settings,
            set_setting,
            set_segment_category,
            get_db_size_mb,
            get_apps_today,
            set_tracking_paused,
            get_tracking_paused,
            get_live_segment,
            show_dashboard,
            set_mini_pinned,
            fix_mini_window,
            start_mini_drag,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Tauri application");

    let exit_handles = Arc::clone(&service_handles);
    app.run(move |app, event| {
        if matches!(
            event,
            tauri::RunEvent::Exit | tauri::RunEvent::ExitRequested { .. }
        ) {
            let _ = tray::save_mini_position(app);
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
