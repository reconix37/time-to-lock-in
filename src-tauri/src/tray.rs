use crate::db;
use rusqlite::OptionalExtension;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::Duration;
use tauri::image::Image;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, LogicalSize, Manager, PhysicalPosition, WebviewWindow};

const MINI_MIN_WIDTH: f64 = 300.0;
const MINI_MIN_HEIGHT: f64 = 228.0;
const MINI_MAX_WIDTH: f64 = 480.0;
const MINI_MAX_HEIGHT: f64 = 340.0;
const MINI_MARGIN: i32 = 16;

struct TraySnapshot {
    useful_ms: i64,
    neutral_ms: i64,
    waste_ms: i64,
    live_kind: String,
    away: bool,
    useful_label: String,
    neutral_label: String,
    waste_label: String,
    observed_label: String,
}

struct TrayLabels {
    open: &'static str,
    pause: &'static str,
    resume: &'static str,
    exit: &'static str,
    loading: &'static str,
}

fn tray_labels(language: &str) -> TrayLabels {
    match language {
        "ua" => TrayLabels {
            open: "Відкрити дашборд",
            pause: "Пауза",
            resume: "Продовжити",
            exit: "Вихід",
            loading: "TTLI — статистика завантажується",
        },
        "en" => TrayLabels {
            open: "Open dashboard",
            pause: "Pause",
            resume: "Resume",
            exit: "Exit",
            loading: "TTLI — loading statistics",
        },
        _ => TrayLabels {
            open: "Открыть дашборд",
            pause: "Пауза",
            resume: "Продолжить",
            exit: "Выход",
            loading: "TTLI — статистика загружается",
        },
    }
}

pub fn install(
    app: &AppHandle,
    paused: Arc<AtomicBool>,
    stop: Arc<AtomicBool>,
) -> Result<JoinHandle<()>, String> {
    let connection = db::open()?;
    let language = db::setting(&connection, "language")?.unwrap_or_else(|| "ru".to_string());
    drop(connection);
    let labels = tray_labels(&language);
    let open_item = MenuItem::with_id(app, "open", labels.open, true, None::<&str>)
        .map_err(|error| error.to_string())?;
    let pause_item = MenuItem::with_id(app, "pause", labels.pause, true, None::<&str>)
        .map_err(|error| error.to_string())?;
    let exit_item = MenuItem::with_id(app, "exit", labels.exit, true, None::<&str>)
        .map_err(|error| error.to_string())?;
    let menu = Menu::with_items(app, &[&open_item, &pause_item, &exit_item])
        .map_err(|error| error.to_string())?;

    let menu_paused = Arc::clone(&paused);
    let tray = TrayIconBuilder::with_id("ttli-tray")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .tooltip(labels.loading)
        .icon(counter_icon(0, "neutral", false))
        .on_menu_event(move |app, event| match event.id().as_ref() {
            "open" => show_dashboard(app),
            "pause" => {
                let next = !menu_paused.load(Ordering::Relaxed);
                menu_paused.store(next, Ordering::Relaxed);
            }
            "exit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| match event {
            TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Down,
                ..
            } => toggle_mini(tray.app_handle()),
            TrayIconEvent::DoubleClick {
                button: MouseButton::Left,
                ..
            } => show_dashboard(tray.app_handle()),
            _ => {}
        })
        .build(app)
        .map_err(|error| error.to_string())?;

    Ok(spawn_updater(
        tray,
        pause_item,
        paused,
        stop,
        labels.pause,
        labels.resume,
    ))
}

pub fn restore_window_state(app: &AppHandle) -> Result<(), String> {
    let connection = db::open()?;
    let tray_only = db::setting(&connection, "tray_only")?.as_deref() != Some("0");
    let pinned = db::setting(&connection, "mini_pinned")?.as_deref() == Some("1");
    drop(connection);

    if let Some(mini) = app.get_webview_window("mini") {
        mini.set_always_on_top(pinned)
            .map_err(|error| error.to_string())?;
        clamp_mini_window(&mini)?;
    }
    if tray_only {
        if let Some(main) = app.get_webview_window("main") {
            main.hide().map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

pub fn show_dashboard(app: &AppHandle) {
    if let Ok(connection) = db::open() {
        let _ = db::set_setting(&connection, "tray_only", "0");
    }
    if let Some(mini) = app.get_webview_window("mini") {
        let _ = mini.hide();
    }
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.unminimize();
        let _ = main.show();
        let _ = main.set_focus();
    }
}

pub fn remember_tray_only() -> Result<(), String> {
    let connection = db::open()?;
    db::set_setting(&connection, "tray_only", "1")
}

pub fn toggle_mini(app: &AppHandle) {
    let Some(mini) = app.get_webview_window("mini") else {
        return;
    };
    if mini.is_visible().unwrap_or(false) {
        let _ = mini.hide();
    } else {
        let _ = show_mini(app);
    }
}

pub fn show_mini(app: &AppHandle) -> Result<(), String> {
    let mini = app
        .get_webview_window("mini")
        .ok_or_else(|| "mini-window is unavailable".to_string())?;
    clamp_mini_window(&mini)?;
    mini.show().map_err(|error| error.to_string())?;
    mini.set_focus().map_err(|error| error.to_string())
}

pub fn set_mini_pinned(app: &AppHandle, pinned: bool) -> Result<(), String> {
    let mini = app
        .get_webview_window("mini")
        .ok_or_else(|| "mini-window is unavailable".to_string())?;
    mini.set_always_on_top(pinned)
        .map_err(|error| error.to_string())?;
    let connection = db::open()?;
    db::set_setting(&connection, "mini_pinned", if pinned { "1" } else { "0" })
}

pub fn save_mini_geometry(app: &AppHandle) -> Result<(), String> {
    let mini = app
        .get_webview_window("mini")
        .ok_or_else(|| "mini-window is unavailable".to_string())?;
    let position = mini.inner_position().map_err(|error| error.to_string())?;
    let scale_factor = mini.scale_factor().map_err(|error| error.to_string())?;
    let size = mini
        .inner_size()
        .map_err(|error| error.to_string())?
        .to_logical::<f64>(scale_factor);
    let connection = db::open()?;
    db::set_setting(
        &connection,
        "mini_window_pos",
        &format!("{},{}", position.x, position.y),
    )?;
    db::set_setting(
        &connection,
        "mini_window_size",
        &format!("{:.0},{:.0}", size.width, size.height),
    )
}

fn clamp_mini_window(window: &WebviewWindow) -> Result<(), String> {
    let monitors = window
        .available_monitors()
        .map_err(|error| error.to_string())?;
    if monitors.is_empty() {
        return Ok(());
    }

    let connection = db::open()?;
    let saved_position =
        db::setting(&connection, "mini_window_pos")?.and_then(|value| parse_position(&value));
    let saved_size =
        db::setting(&connection, "mini_window_size")?.and_then(|value| parse_size(&value));
    drop(connection);

    let default_monitor = window
        .primary_monitor()
        .map_err(|error| error.to_string())?
        .unwrap_or_else(|| monitors[0].clone());
    let current_position = window.inner_position().map_err(|error| error.to_string())?;
    let monitor_anchor = saved_position.unwrap_or(current_position);
    let monitor = monitors
        .iter()
        .find(|monitor| point_in_work_area(monitor_anchor, monitor.work_area()))
        .unwrap_or_else(|| {
            monitors
                .iter()
                .min_by_key(|monitor| {
                    distance_squared(monitor_anchor, monitor.work_area().position)
                })
                .unwrap_or(&default_monitor)
        });
    let area = monitor.work_area();
    let scale_factor = monitor.scale_factor();
    let area_logical = area.size.to_logical::<f64>(scale_factor);
    let current_size = window
        .inner_size()
        .map_err(|error| error.to_string())?
        .to_logical::<f64>(window.scale_factor().map_err(|error| error.to_string())?);
    let proposed_size = saved_size.unwrap_or(current_size);
    let max_width = MINI_MAX_WIDTH.min(area_logical.width).max(MINI_MIN_WIDTH);
    let max_height = MINI_MAX_HEIGHT
        .min(area_logical.height)
        .max(MINI_MIN_HEIGHT);
    let clamped_size = LogicalSize::new(
        proposed_size.width.clamp(MINI_MIN_WIDTH, max_width),
        proposed_size.height.clamp(MINI_MIN_HEIGHT, max_height),
    );
    window
        .set_size(clamped_size)
        .map_err(|error| error.to_string())?;
    let size = clamped_size.to_physical::<u32>(scale_factor);
    let proposed = saved_position.unwrap_or_else(|| {
        PhysicalPosition::new(
            area.position.x + area.size.width as i32 - size.width as i32 - MINI_MARGIN,
            area.position.y + area.size.height as i32 - size.height as i32 - MINI_MARGIN,
        )
    });

    let max_x = area.position.x + area.size.width.saturating_sub(size.width) as i32;
    let max_y = area.position.y + area.size.height.saturating_sub(size.height) as i32;
    let clamped = PhysicalPosition::new(
        proposed
            .x
            .clamp(area.position.x, max_x.max(area.position.x)),
        proposed
            .y
            .clamp(area.position.y, max_y.max(area.position.y)),
    );
    window
        .set_position(clamped)
        .map_err(|error| error.to_string())
}

fn parse_size(value: &str) -> Option<LogicalSize<f64>> {
    let (width, height) = value.split_once(',')?;
    let width = width.parse::<f64>().ok()?;
    let height = height.parse::<f64>().ok()?;
    (width.is_finite() && height.is_finite() && width > 0.0 && height > 0.0)
        .then_some(LogicalSize::new(width, height))
}

fn parse_position(value: &str) -> Option<PhysicalPosition<i32>> {
    let (x, y) = value.split_once(',')?;
    Some(PhysicalPosition::new(x.parse().ok()?, y.parse().ok()?))
}

fn point_in_work_area(point: PhysicalPosition<i32>, area: &tauri::PhysicalRect<i32, u32>) -> bool {
    point.x >= area.position.x
        && point.y >= area.position.y
        && point.x < area.position.x + area.size.width as i32
        && point.y < area.position.y + area.size.height as i32
}

fn distance_squared(point: PhysicalPosition<i32>, origin: PhysicalPosition<i32>) -> i64 {
    let dx = i64::from(point.x) - i64::from(origin.x);
    let dy = i64::from(point.y) - i64::from(origin.y);
    dx.saturating_mul(dx) + dy.saturating_mul(dy)
}

fn spawn_updater(
    tray: TrayIcon,
    pause_item: MenuItem<tauri::Wry>,
    paused: Arc<AtomicBool>,
    stop: Arc<AtomicBool>,
    pause_label: &'static str,
    resume_label: &'static str,
) -> JoinHandle<()> {
    thread::spawn(move || {
        while !stop.load(Ordering::Relaxed) {
            if let Ok(snapshot) = tray_snapshot() {
                let useful_minutes = snapshot.useful_ms / 60_000;
                let _ = tray.set_icon(Some(counter_icon(
                    useful_minutes,
                    &snapshot.live_kind,
                    snapshot.away,
                )));
                let _ = tray.set_tooltip(Some(format!(
                    "TTLI · {} {}м · {} {}м · {} {}м · {} {}м",
                    snapshot.useful_label,
                    useful_minutes,
                    snapshot.neutral_label,
                    snapshot.neutral_ms / 60_000,
                    snapshot.waste_label,
                    snapshot.waste_ms / 60_000,
                    snapshot.observed_label,
                    (snapshot.useful_ms + snapshot.neutral_ms + snapshot.waste_ms) / 60_000,
                )));
            }
            let is_paused = paused.load(Ordering::Relaxed);
            let _ = pause_item.set_text(if is_paused { resume_label } else { pause_label });

            for _ in 0..50 {
                if stop.load(Ordering::Relaxed) {
                    return;
                }
                thread::sleep(Duration::from_millis(100));
            }
        }
    })
}

fn tray_snapshot() -> Result<TraySnapshot, String> {
    let connection = db::open()?;
    let (useful_ms, neutral_ms, waste_ms) = connection
        .query_row(
            "SELECT
                COALESCE(SUM(CASE WHEN c.kind = 'useful' THEN o.duration_ms ELSE 0 END), 0),
                COALESCE(SUM(CASE WHEN c.kind = 'neutral' THEN o.duration_ms ELSE 0 END), 0),
                COALESCE(SUM(CASE WHEN c.kind = 'waste' THEN o.duration_ms ELSE 0 END), 0)
             FROM segment_day_overlaps o
             LEFT JOIN categories c ON c.id = o.category_id
             WHERE o.local_date = date('now', 'localtime')",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .map_err(|error| error.to_string())?;
    let live = connection
        .query_row(
            "SELECT COALESCE(c.kind, 'neutral'), s.status
             FROM segments s
             LEFT JOIN categories c ON c.id = s.category_id
             WHERE s.id = CAST((SELECT value FROM settings WHERE key = 'active_segment_id') AS INTEGER)",
            [],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    let (live_kind, status) = live.unwrap_or_else(|| ("neutral".to_string(), String::new()));
    let useful_label =
        db::setting(&connection, "kind_label_useful")?.unwrap_or_else(|| "Полезное".to_string());
    let neutral_label = db::setting(&connection, "kind_label_neutral")?
        .unwrap_or_else(|| "Нейтральное".to_string());
    let waste_label =
        db::setting(&connection, "kind_label_waste")?.unwrap_or_else(|| "Потери".to_string());
    let observed_label = db::setting(&connection, "kind_label_observed")?
        .unwrap_or_else(|| "Наблюдение".to_string());
    Ok(TraySnapshot {
        useful_ms,
        neutral_ms,
        waste_ms,
        live_kind,
        away: status == "away",
        useful_label,
        neutral_label,
        waste_label,
        observed_label,
    })
}

fn counter_icon(minutes: i64, live_kind: &str, away: bool) -> Image<'static> {
    const SIZE: usize = 32;
    let mut pixels = vec![0_u8; SIZE * SIZE * 4];
    for y in 3..29 {
        for x in 3..29 {
            if (x < 6 && y < 6) || (x > 25 && y < 6) || (x < 6 && y > 25) || (x > 25 && y > 25) {
                continue;
            }
            put_pixel(&mut pixels, x, y, [87, 82, 121, 255]);
        }
    }

    let text = minutes.clamp(0, 1440).to_string();
    let width = text.len() * 7 - 1;
    let start_x = (SIZE - width) / 2;
    for (index, digit) in text.bytes().enumerate() {
        draw_digit(&mut pixels, start_x + index * 7, 10, digit);
    }

    let dot = if away {
        [234, 157, 52, 255]
    } else {
        match live_kind {
            "useful" => [40, 105, 131, 255],
            "waste" => [180, 99, 122, 255],
            _ => [152, 147, 165, 255],
        }
    };
    for y in 23..28 {
        for x in 23..28 {
            put_pixel(&mut pixels, x, y, dot);
        }
    }
    Image::new_owned(pixels, SIZE as u32, SIZE as u32)
}

fn draw_digit(pixels: &mut [u8], x: usize, y: usize, digit: u8) {
    const DIGITS: [[u8; 5]; 10] = [
        [0b111, 0b101, 0b101, 0b101, 0b111],
        [0b010, 0b110, 0b010, 0b010, 0b111],
        [0b111, 0b001, 0b111, 0b100, 0b111],
        [0b111, 0b001, 0b111, 0b001, 0b111],
        [0b101, 0b101, 0b111, 0b001, 0b001],
        [0b111, 0b100, 0b111, 0b001, 0b111],
        [0b111, 0b100, 0b111, 0b101, 0b111],
        [0b111, 0b001, 0b010, 0b010, 0b010],
        [0b111, 0b101, 0b111, 0b101, 0b111],
        [0b111, 0b101, 0b111, 0b001, 0b111],
    ];
    let Some(rows) = digit
        .checked_sub(b'0')
        .and_then(|value| DIGITS.get(value as usize))
    else {
        return;
    };
    for (row, pattern) in rows.iter().enumerate() {
        for column in 0..3 {
            if pattern & (1 << (2 - column)) != 0 {
                for offset_y in 0..2 {
                    for offset_x in 0..2 {
                        put_pixel(
                            pixels,
                            x + column * 2 + offset_x,
                            y + row * 2 + offset_y,
                            [250, 244, 237, 255],
                        );
                    }
                }
            }
        }
    }
}

fn put_pixel(pixels: &mut [u8], x: usize, y: usize, color: [u8; 4]) {
    let index = (y * 32 + x) * 4;
    pixels[index..index + 4].copy_from_slice(&color);
}
