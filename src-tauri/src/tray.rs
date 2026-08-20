use crate::db;
use rusqlite::OptionalExtension;
use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::sync::Mutex;
use std::thread::{self, JoinHandle};
use std::time::Duration;
use tauri::image::Image;
use tauri::menu::{CheckMenuItem, Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, LogicalSize, Manager, PhysicalPosition, WebviewWindow};

const MINI_MIN_WIDTH: f64 = 300.0;
const MINI_MIN_HEIGHT: f64 = 228.0;
const MINI_MAX_WIDTH: f64 = 480.0;
const MINI_MAX_HEIGHT: f64 = 340.0;
const MINI_MARGIN: i32 = 16;
const MINI_CORNER_MARGIN: i32 = 0;

/// Частичный «клики сквозь» (Windows): окно в режиме click-through остаётся
/// кликабельным только в верхней полосе («шапка» + меню брови), остальное —
/// прозрачно для мыши. Через Win32 subclass + WM_NCHITTEST возвращаем HTCLIENT
/// в полосе и HTTRANSPARENT за её пределами.
#[cfg(target_os = "windows")]
mod click_through {
    use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
    use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, POINT, WPARAM};
    use windows::Win32::Graphics::Gdi::ScreenToClient;
    use windows::Win32::UI::Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass};
    use windows::Win32::UI::WindowsAndMessaging::{HTCLIENT, HTTRANSPARENT, WM_NCHITTEST};

    static ENABLED: AtomicBool = AtomicBool::new(false);
    static BAND_PX: AtomicU32 = AtomicU32::new(72);

    unsafe extern "system" fn mini_proc(
        hwnd: HWND,
        msg: u32,
        wparam: WPARAM,
        lparam: LPARAM,
        uidsubclass: usize,
        dwrefdata: usize,
    ) -> LRESULT {
        if msg == WM_NCHITTEST && ENABLED.load(Ordering::SeqCst) {
            let signed = |v: i32| if v >= 0x8000 { v - 0x10000 } else { v };
            let x = signed((lparam.0 & 0xffff) as i32);
            let y = signed(((lparam.0 >> 16) & 0xffff) as i32);
            let mut pt = POINT { x, y };
            if ScreenToClient(hwnd, &mut pt).as_bool() {
                let band = BAND_PX.load(Ordering::SeqCst) as i32;
                if (0..=band).contains(&pt.y) {
                    return LRESULT(HTCLIENT as isize);
                }
            }
            return LRESULT(HTTRANSPARENT as isize);
        }
        DefSubclassProc(hwnd, msg, wparam, lparam)
    }

    pub fn apply(hwnd: HWND, enabled: bool, band_logical: f64, scale: f64) {
        BAND_PX.store(
            (band_logical * scale).round().max(0.0) as u32,
            Ordering::SeqCst,
        );
        ENABLED.store(enabled, Ordering::SeqCst);
        unsafe {
            if enabled {
                let _ = SetWindowSubclass(hwnd, Some(mini_proc), 1, 0);
            } else {
                let _ = RemoveWindowSubclass(hwnd, Some(mini_proc), 1);
            }
        }
    }

    pub fn set_band(band_logical: f64, scale: f64) {
        BAND_PX.store(
            (band_logical * scale).round().max(0.0) as u32,
            Ordering::SeqCst,
        );
    }
}

#[derive(Serialize)]
pub struct MiniState {
    pinned: bool,
    corner: Option<String>,
    resizable: bool,
    position_x: i32,
    position_y: i32,
}

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
    click_through: &'static str,
    loading: &'static str,
}

static CLICK_THROUGH_ITEM: Mutex<Option<CheckMenuItem<tauri::Wry>>> = Mutex::new(None);

pub fn enforce_mini_topmost(mini: &tauri::Window) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use raw_window_handle::{HasWindowHandle, RawWindowHandle};
        use windows::Win32::Foundation::HWND;
        use windows::Win32::UI::WindowsAndMessaging::{
            SetWindowPos, HWND_TOPMOST, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE,
        };

        let connection = db::open()?;
        let pinned = db::setting(&connection, "mini_pinned")?.as_deref() == Some("1");
        drop(connection);
        if !pinned {
            return Ok(());
        }

        let raw_handle = mini.window_handle().map_err(|error| error.to_string())?;
        let RawWindowHandle::Win32(win32_handle) = raw_handle.as_raw() else {
            return Err("mini-window does not expose a Win32 handle".to_string());
        };
        let hwnd = HWND(win32_handle.hwnd.get() as *mut std::ffi::c_void);
        unsafe {
            SetWindowPos(
                hwnd,
                HWND_TOPMOST,
                0,
                0,
                0,
                0,
                SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
            )
        }
        .map_err(|error| error.to_string())?;
    }

    #[cfg(not(target_os = "windows"))]
    let _ = mini;

    Ok(())
}

pub fn apply_mini_opacity(mini: &WebviewWindow, opacity: u8) -> Result<(), String> {
    if !(60..=100).contains(&opacity) {
        return Err("invalid mini-window opacity".to_string());
    }

    #[cfg(target_os = "windows")]
    {
        use raw_window_handle::{HasWindowHandle, RawWindowHandle};
        use windows::Win32::Foundation::{COLORREF, HWND};
        use windows::Win32::UI::WindowsAndMessaging::{
            GetWindowLongPtrW, SetLayeredWindowAttributes, SetWindowLongPtrW, GWL_EXSTYLE,
            LWA_ALPHA, WS_EX_LAYERED,
        };

        let raw_handle = mini.window_handle().map_err(|error| error.to_string())?;
        let RawWindowHandle::Win32(win32_handle) = raw_handle.as_raw() else {
            return Err("mini-window does not expose a Win32 handle".to_string());
        };
        let hwnd = HWND(win32_handle.hwnd.get() as *mut std::ffi::c_void);
        let alpha = ((u16::from(opacity) * 255) / 100) as u8;
        unsafe {
            let extended_style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
            SetWindowLongPtrW(hwnd, GWL_EXSTYLE, extended_style | WS_EX_LAYERED.0 as isize);
            SetLayeredWindowAttributes(hwnd, COLORREF(0), alpha, LWA_ALPHA)
        }
        .map_err(|error| error.to_string())?;
    }

    #[cfg(not(target_os = "windows"))]
    let _ = mini;

    Ok(())
}

fn saved_mini_opacity(connection: &rusqlite::Connection) -> Result<u8, String> {
    Ok(parse_mini_opacity(
        db::setting(connection, "mini_opacity")?.as_deref(),
    ))
}

fn parse_mini_opacity(value: Option<&str>) -> u8 {
    value
        .and_then(|opacity| opacity.parse::<u8>().ok())
        .filter(|opacity| (60..=100).contains(opacity))
        .unwrap_or(100)
}

fn valid_mini_corner(corner: &str) -> bool {
    matches!(corner, "tl" | "tr" | "bl" | "br")
}

fn should_restore_mini(
    visible: bool,
    onboarding_done: bool,
    tray_only: bool,
    corner_pinned: bool,
) -> bool {
    visible || (onboarding_done && (!tray_only || corner_pinned))
}

fn tray_labels(language: &str) -> TrayLabels {
    match language {
        "ua" => TrayLabels {
            open: "Відкрити дашборд",
            pause: "Зупинити відстеження",
            resume: "Відновити відстеження",
            exit: "Вихід",
            click_through: "Кліки наскрізь",
            loading: "TTLI — статистика завантажується",
        },
        "en" => TrayLabels {
            open: "Open dashboard",
            pause: "Stop tracking",
            resume: "Resume tracking",
            exit: "Exit",
            click_through: "Click-through",
            loading: "TTLI — loading statistics",
        },
        _ => TrayLabels {
            open: "Открыть дашборд",
            pause: "Остановить отслеживание",
            resume: "Возобновить отслеживание",
            exit: "Выход",
            click_through: "Клики сквозь",
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
    let connection = db::open()?;
    let click_through_enabled =
        db::setting(&connection, "mini_click_through")?.as_deref() == Some("1");
    drop(connection);
    let click_item = CheckMenuItem::with_id(
        app,
        "click_through",
        labels.click_through,
        true,
        click_through_enabled,
        None::<&str>,
    )
    .map_err(|error| error.to_string())?;
    let exit_item = MenuItem::with_id(app, "exit", labels.exit, true, None::<&str>)
        .map_err(|error| error.to_string())?;
    let menu = Menu::with_items(app, &[&open_item, &pause_item, &click_item, &exit_item])
        .map_err(|error| error.to_string())?;
    *CLICK_THROUGH_ITEM.lock().unwrap() = Some(click_item.clone());

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
            "click_through" => {
                if let Err(error) = toggle_mini_click_through(app) {
                    eprintln!("toggle click-through failed: {error}");
                }
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
    let onboarding_done = db::setting(&connection, "onboarding_done")?.as_deref() == Some("1");
    let pinned = db::setting(&connection, "mini_pinned")?.as_deref() == Some("1");
    let visible = db::setting(&connection, "mini_visible")?.as_deref() == Some("1");
    let corner = db::setting(&connection, "mini_corner")?.unwrap_or_default();
    let corner_tuck = db::setting(&connection, "mini_corner_tuck")?.as_deref() == Some("1");
    let opacity = saved_mini_opacity(&connection)?;
    drop(connection);

    if let Some(mini) = app.get_webview_window("mini") {
        if !pinned {
            mini.set_always_on_top(false)
                .map_err(|error| error.to_string())?;
        }
        clamp_mini_window(&mini)?;
        let corner_pinned = valid_mini_corner(&corner);
        if corner_pinned {
            move_mini_to_corner(&mini, &corner, corner_tuck)?;
            mini.set_resizable(false)
                .map_err(|error| error.to_string())?;
        }
        if should_restore_mini(visible, onboarding_done, tray_only, corner_pinned) {
            mini.unminimize().map_err(|error| error.to_string())?;
            mini.show().map_err(|error| error.to_string())?;
        }
        apply_mini_opacity(&mini, opacity)?;
        enforce_mini_topmost(&mini.as_ref().window())?;
    }
    if let Some(main) = app.get_webview_window("main") {
        if onboarding_done {
            main.hide().map_err(|error| error.to_string())?;
        } else {
            // Первый запуск — показать дашборд (окно создаётся скрытым, видимость управляется здесь)
            main.show().map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

pub fn show_dashboard(app: &AppHandle) {
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.unminimize();
        let _ = main.show();
        let _ = main.set_focus();
    }
}

pub fn toggle_mini(app: &AppHandle) {
    let Some(mini) = app.get_webview_window("mini") else {
        return;
    };
    if mini.is_minimized().unwrap_or(false) {
        let _ = show_mini(app);
    } else if mini.is_visible().unwrap_or(false) {
        let _ = mini.hide();
        if let Ok(connection) = db::open() {
            let _ = db::set_setting(&connection, "mini_visible", "0");
        }
    } else {
        let _ = show_mini(app);
    }
}

pub fn show_mini(app: &AppHandle) -> Result<(), String> {
    let mini = app
        .get_webview_window("mini")
        .ok_or_else(|| "mini-window is unavailable".to_string())?;
    mini.unminimize().map_err(|error| error.to_string())?;
    clamp_mini_window(&mini)?;
    let connection = db::open()?;
    let corner = db::setting(&connection, "mini_corner")?.unwrap_or_default();
    let corner_tuck = db::setting(&connection, "mini_corner_tuck")?.as_deref() == Some("1");
    if valid_mini_corner(&corner) {
        move_mini_to_corner(&mini, &corner, corner_tuck)?;
    }
    mini.show().map_err(|error| error.to_string())?;
    mini.set_focus().map_err(|error| error.to_string())?;
    let opacity = saved_mini_opacity(&connection)?;
    apply_mini_opacity(&mini, opacity)?;
    enforce_mini_topmost(&mini.as_ref().window())?;
    db::set_setting(&connection, "mini_visible", "1")
}

pub fn minimize_mini(app: &AppHandle) -> Result<(), String> {
    let mini = app
        .get_webview_window("mini")
        .ok_or_else(|| "mini-window is unavailable".to_string())?;
    let _ = save_mini_geometry(app);
    mini.minimize().map_err(|error| error.to_string())
}

pub fn hide_mini(app: &AppHandle) -> Result<(), String> {
    let mini = app
        .get_webview_window("mini")
        .ok_or_else(|| "mini-window is unavailable".to_string())?;
    let _ = save_mini_geometry(app);
    mini.hide().map_err(|error| error.to_string())?;
    let connection = db::open()?;
    db::set_setting(&connection, "mini_visible", "0")
}

pub fn set_mini_pinned(app: &AppHandle, pinned: bool) -> Result<(), String> {
    let mini = app
        .get_webview_window("mini")
        .ok_or_else(|| "mini-window is unavailable".to_string())?;
    let previous_pinned = mini.is_always_on_top().map_err(|error| error.to_string())?;
    mini.set_always_on_top(pinned)
        .map_err(|error| error.to_string())?;
    let connection = match db::open() {
        Ok(connection) => connection,
        Err(error) => {
            let _ = mini.set_always_on_top(previous_pinned);
            return Err(error);
        }
    };
    if let Err(error) = db::set_setting(&connection, "mini_pinned", if pinned { "1" } else { "0" })
    {
        let _ = mini.set_always_on_top(previous_pinned);
        return Err(error);
    }
    Ok(())
}

pub fn get_mini_state(app: &AppHandle) -> Result<MiniState, String> {
    let mini = app
        .get_webview_window("mini")
        .ok_or_else(|| "mini-window is unavailable".to_string())?;
    let resizable = mini.is_resizable().map_err(|error| error.to_string())?;
    let position = mini.inner_position().map_err(|error| error.to_string())?;
    let connection = db::open()?;
    let saved_corner = db::setting(&connection, "mini_corner")?.unwrap_or_default();
    let corner = (!resizable && matches!(saved_corner.as_str(), "tl" | "tr" | "bl" | "br"))
        .then_some(saved_corner);
    Ok(MiniState {
        pinned: mini.is_always_on_top().map_err(|error| error.to_string())?,
        corner,
        resizable,
        position_x: position.x,
        position_y: position.y,
    })
}

pub fn save_mini_geometry(app: &AppHandle) -> Result<(), String> {
    let mini = app
        .get_webview_window("mini")
        .ok_or_else(|| "mini-window is unavailable".to_string())?;
    let connection = db::open()?;
    // при corner-lock позиция — производная от угла (и tuck), не сохраняем абсолют
    let corner = db::setting(&connection, "mini_corner")?.unwrap_or_default();
    if valid_mini_corner(&corner) {
        return Ok(());
    }
    let position = mini.inner_position().map_err(|error| error.to_string())?;
    let scale_factor = mini.scale_factor().map_err(|error| error.to_string())?;
    let size = mini
        .inner_size()
        .map_err(|error| error.to_string())?
        .to_logical::<f64>(scale_factor);
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

pub fn resize_mini(app: &AppHandle, width: f64, height: f64, force: bool) -> Result<(), String> {
    if !width.is_finite() || !height.is_finite() {
        return Err("invalid mini-window size".to_string());
    }
    let mini = app
        .get_webview_window("mini")
        .ok_or_else(|| "mini-window is unavailable".to_string())?;
    let current = mini
        .inner_size()
        .map_err(|error| error.to_string())?
        .to_logical::<f64>(mini.scale_factor().map_err(|error| error.to_string())?);
    // Дробный DPI (например, 125%): 390 × 1.25 = 487.5 физических → Windows округляет
    // до 487 → обратно в логические 389.6 < 390 → ранний выход не срабатывал и
    // set_size уходил в бесконечный цикл resize (виджет дёргался, UI виснул).
    // Сравниваем округлённые значения — петля разрывается, защита от сжатия остаётся.
    let current_w = current.width.round();
    let current_h = current.height.round();
    if !force && current_w >= width && current_h >= height {
        return Ok(());
    }
    let size = if force {
        LogicalSize::new(
            width.clamp(MINI_MIN_WIDTH, MINI_MAX_WIDTH),
            height.clamp(MINI_MIN_HEIGHT, MINI_MAX_HEIGHT),
        )
    } else {
        LogicalSize::new(
            current
                .width
                .max(width)
                .clamp(MINI_MIN_WIDTH, MINI_MAX_WIDTH),
            current
                .height
                .max(height)
                .clamp(MINI_MIN_HEIGHT, MINI_MAX_HEIGHT),
        )
    };
    mini.set_size(size).map_err(|error| error.to_string())?;
    save_mini_geometry(app)?;
    clamp_mini_window(&mini)?;
    let connection = db::open()?;
    let corner = db::setting(&connection, "mini_corner")?.unwrap_or_default();
    let corner_tuck = db::setting(&connection, "mini_corner_tuck")?.as_deref() == Some("1");
    drop(connection);
    if corner.is_empty() {
        Ok(())
    } else {
        move_mini_to_corner(&mini, &corner, corner_tuck)
    }
}

pub fn set_mini_resizable(app: &AppHandle, resizable: bool) -> Result<(), String> {
    let mini = app
        .get_webview_window("mini")
        .ok_or_else(|| "mini-window is unavailable".to_string())?;
    mini.set_resizable(resizable)
        .map_err(|error| error.to_string())
}

const MINI_TUCK_PEEK: i32 = 36;

fn mini_tuck_active(connection: &rusqlite::Connection) -> Result<bool, String> {
    let corner = db::setting(connection, "mini_corner")?.unwrap_or_default();
    if !valid_mini_corner(&corner) {
        return Ok(false);
    }
    Ok(db::setting(connection, "mini_corner_tuck")?.as_deref() == Some("1"))
}

pub fn apply_mini_click_through(app: &AppHandle, enabled: bool) -> Result<(), String> {
    let mini = app
        .get_webview_window("mini")
        .ok_or_else(|| "mini-window is unavailable".to_string())?;
    // «клики сквозь» + tuck несовместимы: hover-reveal не работает, окно станет недосягаемым
    if enabled {
        let connection = db::open()?;
        if mini_tuck_active(&connection)? {
            let corner = db::setting(&connection, "mini_corner")?.unwrap_or_default();
            move_mini_to_corner(&mini, &corner, false)?;
        }
    }
    apply_click_through_window(&mini, enabled)
}

/// На Windows — частичный hit-test (кликабельна только «шапка»), иначе полный click-through.
#[cfg(target_os = "windows")]
fn apply_click_through_window(mini: &WebviewWindow, enabled: bool) -> Result<(), String> {
    let hwnd = mini_hwnd(mini)?;
    let scale = mini.scale_factor().map_err(|error| error.to_string())?;
    let band = if enabled { 72.0 } else { 0.0 };
    click_through::apply(hwnd, enabled, band, scale);
    Ok(())
}

#[cfg(not(target_os = "windows"))]
fn apply_click_through_window(mini: &WebviewWindow, enabled: bool) -> Result<(), String> {
    mini.set_ignore_cursor_events(enabled)
        .map_err(|error| error.to_string())
}

/// Фронт при открытии выпадающих панелей (настройки и т.п.) расширяет кликабельную полосу
/// выше дефолтной «шапки», чтобы кнопки попапа были доступны при click-through.
pub fn set_mini_hit_band(app: &AppHandle, height: f64) -> Result<(), String> {
    let mini = app
        .get_webview_window("mini")
        .ok_or_else(|| "mini-window is unavailable".to_string())?;
    #[cfg(target_os = "windows")]
    {
        let scale = mini.scale_factor().map_err(|error| error.to_string())?;
        if height > 0.0 {
            click_through::set_band(height, scale);
        }
    }
    let _ = &mini;
    Ok(())
}

#[cfg(target_os = "windows")]
fn mini_hwnd(mini: &WebviewWindow) -> Result<windows::Win32::Foundation::HWND, String> {
    use raw_window_handle::HasWindowHandle;
    let window_ref = mini.as_ref().window();
    let handle = window_ref
        .window_handle()
        .map_err(|error| error.to_string())?;
    let raw = handle.as_raw();
    if let raw_window_handle::RawWindowHandle::Win32(win) = raw {
        Ok(windows::Win32::Foundation::HWND(
            win.hwnd.get() as *mut core::ffi::c_void
        ))
    } else {
        Err("mini-window is not a Win32 window".to_string())
    }
}

pub fn sync_click_through_checked() {
    if let Ok(connection) = db::open() {
        if let Ok(Some(enabled)) = db::setting(&connection, "mini_click_through") {
            if let Some(item) = CLICK_THROUGH_ITEM.lock().unwrap().as_ref() {
                let _ = item.set_checked(enabled == "1");
            }
        }
    }
}

pub fn toggle_mini_click_through(app: &AppHandle) -> Result<(), String> {
    let connection = db::open()?;
    let enabled = db::setting(&connection, "mini_click_through")?.as_deref() == Some("1");
    let next = !enabled;
    apply_mini_click_through(app, next)?;
    db::set_setting(
        &connection,
        "mini_click_through",
        if next { "1" } else { "0" },
    )?;
    sync_click_through_checked();
    Ok(())
}

pub fn set_mini_click_through(app: &AppHandle, enabled: bool) -> Result<(), String> {
    apply_mini_click_through(app, enabled)?;
    let connection = db::open()?;
    db::set_setting(
        &connection,
        "mini_click_through",
        if enabled { "1" } else { "0" },
    )?;
    sync_click_through_checked();
    Ok(())
}

pub fn set_mini_tuck(app: &AppHandle, tucked: bool) -> Result<(), String> {
    let mini = app
        .get_webview_window("mini")
        .ok_or_else(|| "mini-window is unavailable".to_string())?;
    let connection = db::open()?;
    let corner = db::setting(&connection, "mini_corner")?.unwrap_or_default();
    if !valid_mini_corner(&corner) {
        return Err("mini-window is not corner-pinned".to_string());
    }
    db::set_setting(
        &connection,
        "mini_corner_tuck",
        if tucked { "1" } else { "0" },
    )?;
    move_mini_to_corner(&mini, &corner, tucked)
}

/// Позиционирование tuck без записи в БД — для hover-reveal (частые вызовы)
pub fn tuck_mini_position(app: &AppHandle, tucked: bool) -> Result<(), String> {
    let mini = app
        .get_webview_window("mini")
        .ok_or_else(|| "mini-window is unavailable".to_string())?;
    let connection = db::open()?;
    let corner = db::setting(&connection, "mini_corner")?.unwrap_or_default();
    if !valid_mini_corner(&corner) {
        return Ok(());
    }
    move_mini_to_corner(&mini, &corner, tucked)
}

fn move_mini_to_corner(window: &WebviewWindow, corner: &str, tucked: bool) -> Result<(), String> {
    let monitor = window
        .current_monitor()
        .map_err(|error| error.to_string())?
        .or(window
            .primary_monitor()
            .map_err(|error| error.to_string())?);
    let Some(monitor) = monitor else {
        return Ok(());
    };
    // Полный экран (включая панель задач Windows): виджет цепляется в САМЫЙ угол
    // поверх панели (жалоба A3), и tuck доезжает до края без зазора (жалоба C1).
    // work_area() исключает панель задач — потому не используем его здесь.
    let origin = *monitor.position();
    let screen_size = *monitor.size();
    let size = window.inner_size().map_err(|error| error.to_string())?;
    let screen_w = screen_size.width as i32;
    let screen_h = screen_size.height as i32;
    let w = size.width as i32;
    let h = size.height as i32;
    let position = if tucked {
        // Таб 36×36 торчит из выбранного угла экрана, остальное окно — за краем.
        // Для каждого угла — свой сдвиг, чтобы таб был в том же углу, что и пин.
        match corner {
            "tl" => {
                PhysicalPosition::new(origin.x - w + MINI_TUCK_PEEK, origin.y - h + MINI_TUCK_PEEK)
            }
            "tr" => PhysicalPosition::new(
                origin.x + screen_w - MINI_TUCK_PEEK,
                origin.y - h + MINI_TUCK_PEEK,
            ),
            "bl" => PhysicalPosition::new(
                origin.x - w + MINI_TUCK_PEEK,
                origin.y + screen_h - MINI_TUCK_PEEK,
            ),
            "br" => PhysicalPosition::new(
                origin.x + screen_w - MINI_TUCK_PEEK,
                origin.y + screen_h - MINI_TUCK_PEEK,
            ),
            _ => return Err("invalid mini-window corner".to_string()),
        }
    } else {
        let margin = MINI_CORNER_MARGIN;
        let right = origin.x + screen_w.saturating_sub(w) - margin;
        let bottom = origin.y + screen_h.saturating_sub(h) - margin;
        match corner {
            "tl" => PhysicalPosition::new(origin.x + margin, origin.y + margin),
            "tr" => PhysicalPosition::new(right, origin.y + margin),
            "bl" => PhysicalPosition::new(origin.x + margin, bottom),
            "br" => PhysicalPosition::new(right, bottom),
            _ => return Err("invalid mini-window corner".to_string()),
        }
    };
    window
        .set_position(position)
        .map_err(|error| error.to_string())
}

pub fn reset_mini_geometry(app: &AppHandle) -> Result<(), String> {
    let mini = app
        .get_webview_window("mini")
        .ok_or_else(|| "mini-window is unavailable".to_string())?;
    let connection = db::open()?;
    connection
        .execute(
            "DELETE FROM settings WHERE key IN ('mini_window_pos', 'mini_window_size')",
            [],
        )
        .map_err(|error| error.to_string())?;
    db::set_setting(&connection, "mini_corner", "")?;
    drop(connection);
    mini.set_resizable(true)
        .map_err(|error| error.to_string())?;
    mini.set_size(LogicalSize::new(300.0, 228.0))
        .map_err(|error| error.to_string())?;
    place_mini_at_default(&mini)?;
    save_mini_geometry(app)
}

pub fn pin_mini_corner(app: &AppHandle, corner: &str) -> Result<(), String> {
    if !valid_mini_corner(corner) {
        return Err("invalid mini-window corner".to_string());
    }
    let mini = app
        .get_webview_window("mini")
        .ok_or_else(|| "mini-window is unavailable".to_string())?;
    let previous_position = mini.inner_position().map_err(|error| error.to_string())?;
    let previous_resizable = mini.is_resizable().map_err(|error| error.to_string())?;
    let connection = db::open()?;
    let active_corner = db::setting(&connection, "mini_corner")?.unwrap_or_default();
    if active_corner == corner {
        mini.set_resizable(true)
            .map_err(|error| error.to_string())?;
        if let Err(error) = db::set_setting(&connection, "mini_corner", "") {
            let _ = mini.set_resizable(previous_resizable);
            return Err(error);
        }
        let _ = db::set_setting(&connection, "mini_corner_tuck", "0");
        return Ok(());
    }
    let tuck = db::setting(&connection, "mini_corner_tuck")?.as_deref() == Some("1");
    move_mini_to_corner(&mini, corner, tuck)?;
    if let Err(error) = mini.set_resizable(false) {
        let _ = mini.set_position(previous_position);
        return Err(error.to_string());
    }
    if let Err(error) = db::set_setting(&connection, "mini_corner", corner) {
        let _ = mini.set_position(previous_position);
        let _ = mini.set_resizable(previous_resizable);
        return Err(error);
    }
    Ok(())
}

fn place_mini_at_default(window: &WebviewWindow) -> Result<(), String> {
    let monitor = window
        .current_monitor()
        .map_err(|error| error.to_string())?
        .or(window
            .primary_monitor()
            .map_err(|error| error.to_string())?);
    let Some(monitor) = monitor else {
        return Ok(());
    };
    let area = monitor.work_area();
    let size = window.inner_size().map_err(|error| error.to_string())?;
    window
        .set_position(PhysicalPosition::new(
            area.position.x + area.size.width.saturating_sub(size.width) as i32 - MINI_MARGIN,
            area.position.y + area.size.height.saturating_sub(size.height) as i32 - MINI_MARGIN,
        ))
        .map_err(|error| error.to_string())
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
    // Дробный DPI (125%): физический 487.5 → 487 → логический 389.6. set_size с тем же
    // логическим размером на Windows может эмитить resize-событие → петля (виджет
    // дёргается, CPU горит). Если размер фактически тот же (с допуском на округление
    // физических пикселей) — окно не трогаем, позицию всё равно поправим ниже.
    let current_w = current_size.width.round();
    let current_h = current_size.height.round();
    let size_changed = (clamped_size.width - current_w).abs() >= 0.75
        || (clamped_size.height - current_h).abs() >= 0.75;
    if size_changed {
        window
            .set_size(clamped_size)
            .map_err(|error| error.to_string())?;
    }
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

#[cfg(test)]
mod tests {
    use super::{parse_mini_opacity, should_restore_mini, valid_mini_corner};

    #[test]
    fn opacity_defaults_to_fully_opaque_outside_supported_range() {
        assert_eq!(parse_mini_opacity(None), 100);
        assert_eq!(parse_mini_opacity(Some("59")), 100);
        assert_eq!(parse_mini_opacity(Some("101")), 100);
        assert_eq!(parse_mini_opacity(Some("80")), 80);
    }

    #[test]
    fn a_valid_corner_restores_mini_even_in_tray_only_mode() {
        assert!(should_restore_mini(false, true, true, true));
        assert!(!should_restore_mini(false, true, true, false));
        assert!(!should_restore_mini(false, false, true, true));
        assert!(valid_mini_corner("br"));
        assert!(!valid_mini_corner("bottom-right"));
    }
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
