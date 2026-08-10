// Time To Lock In — точка входа и команды локального хранилища.

mod db;
mod http;
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
struct Category {
    id: i64,
    name: String,
    color: String,
    icon: String,
    kind: String,
    goal_multiplier: f64,
    sort_order: i64,
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
            "SELECT id, ts_start, ts_end, app, window_title, domain, COALESCE(category_id, 0), status
             FROM segments
             WHERE date(ts_start / 1000, 'unixepoch', 'localtime') = date('now', 'localtime')
             ORDER BY ts_start ASC",
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
fn get_today_stats() -> Result<TodayStats, String> {
    let connection = db::open()?;
    connection
        .query_row(
            "SELECT
                COALESCE(SUM(CASE WHEN c.kind = 'useful' THEN MAX(0, s.ts_end - s.ts_start) ELSE 0 END), 0),
                COALESCE(SUM(CASE WHEN c.kind = 'neutral' THEN MAX(0, s.ts_end - s.ts_start) ELSE 0 END), 0),
                COALESCE(SUM(CASE WHEN c.kind = 'waste' THEN MAX(0, s.ts_end - s.ts_start) ELSE 0 END), 0)
             FROM segments s
             LEFT JOIN categories c ON c.id = COALESCE(s.category_id, 0)
             WHERE date(s.ts_start / 1000, 'unixepoch', 'localtime') = date('now', 'localtime')
               AND s.status IN ('active', 'crashed')",
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
        .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
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
        "extension_chrome_id" | "extension_edge_id" => {
            value.is_empty()
                || (value.len() == 32 && value.chars().all(|character| ('a'..='p').contains(&character)))
        }
        _ => false,
    };
    if !valid {
        return Err("invalid setting or value".to_string());
    }

    let connection = db::open()?;
    connection
        .execute(
            "INSERT INTO settings (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, value],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
fn set_segment_category(segment_id: i64, category_id: Option<i64>) -> Result<(), String> {
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
    let local_date = connection
        .query_row(
            "SELECT date(ts_start / 1000, 'unixepoch', 'localtime') FROM segments WHERE id = ?1",
            [segment_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "segment does not exist".to_string())?;
    let transaction = connection.transaction().map_err(|error| error.to_string())?;
    transaction
        .execute(
            "UPDATE segments SET category_id = ?1 WHERE id = ?2",
            params![category_id, segment_id],
        )
        .map_err(|error| error.to_string())?;
    db::refresh_daily_stats(&transaction, &local_date)?;
    transaction.commit().map_err(|error| error.to_string())
}

#[tauri::command]
fn get_apps_today() -> Result<Vec<AppToday>, String> {
    let connection = db::open()?;
    let mut statement = connection
        .prepare(
            "SELECT s.app,
                    SUM(MAX(0, s.ts_end - s.ts_start)) AS duration_ms,
                    SUM(CASE WHEN c.kind = 'useful' THEN MAX(0, s.ts_end - s.ts_start) ELSE 0 END),
                    SUM(CASE WHEN c.kind = 'neutral' THEN MAX(0, s.ts_end - s.ts_start) ELSE 0 END),
                    SUM(CASE WHEN c.kind = 'waste' THEN MAX(0, s.ts_end - s.ts_start) ELSE 0 END)
             FROM segments s
             LEFT JOIN categories c ON c.id = s.category_id
             WHERE date(s.ts_start / 1000, 'unixepoch', 'localtime') = date('now', 'localtime')
               AND s.status IN ('active', 'crashed')
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
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
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
        .setup(move |_app| {
            db::initialize().map_err(std::io::Error::other)?;
            let stop = Arc::new(AtomicBool::new(false));
            let (sender, receiver) = mpsc::channel();
            let watcher_handle = watcher::spawn(
                receiver,
                Arc::clone(&stop),
                Arc::clone(&setup_paused),
            );
            let http_handle = http::spawn(sender, Arc::clone(&stop));
            let mut handles = setup_handles
                .lock()
                .map_err(|_| std::io::Error::other("service handles are poisoned"))?;
            *handles = Some((stop, watcher_handle, http_handle));
            Ok(())
        });

    let app = builder
        .invoke_handler(tauri::generate_handler![
            get_today_segments,
            get_today_stats,
            get_categories,
            get_rules,
            create_rule,
            delete_rule,
            get_settings,
            set_setting,
            set_segment_category,
            get_apps_today,
            set_tracking_paused,
            get_tracking_paused,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Tauri application");

    let exit_handles = Arc::clone(&service_handles);
    app.run(move |_, event| {
        if matches!(event, tauri::RunEvent::Exit | tauri::RunEvent::ExitRequested { .. }) {
            if let Ok(handles) = exit_handles.lock() {
                if let Some((stop, _, _)) = handles.as_ref() {
                    stop.store(true, Ordering::Relaxed);
                }
            }
        }
    });
    if let Ok(mut handles) = service_handles.lock() {
        if let Some((stop, watcher_handle, http_handle)) = handles.take() {
            stop.store(true, Ordering::Relaxed);
            let _ = watcher_handle.join();
            let _ = http_handle.join();
        }
    };
}
