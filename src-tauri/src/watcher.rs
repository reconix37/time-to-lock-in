use crate::db;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc::Receiver, Arc};
use std::thread::{self, JoinHandle};
use std::time::Duration;

const POLL_INTERVAL: Duration = Duration::from_secs(5);
const BROWSER_EVENT_MAX_AGE_MS: i64 = 10_000;

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct BrowserEvent {
    pub ts: i64,
    pub domain: String,
    pub title: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct ActivityState {
    app: String,
    title: String,
    domain: String,
    status: &'static str,
}

struct ActiveSegment {
    id: i64,
    ts_start: i64,
    state: ActivityState,
}

fn is_task_switcher(state: &ActivityState) -> bool {
    if !state.app.eq_ignore_ascii_case("explorer.exe") {
        return false;
    }

    let title = state.title.to_lowercase();
    title.contains("переключение задач")
        || title.contains("task switching")
        || title.contains("switch to")
}

fn normalize_title(title: &str) -> String {
    let mut normalized = title.split_whitespace().collect::<Vec<_>>().join(" ");

    if let Some(open_index) = normalized.rfind('(') {
        if normalized.ends_with(')') {
            let suffix = &normalized[open_index + 1..normalized.len() - 1];
            let digits = suffix.strip_suffix('%').unwrap_or(suffix);
            if !digits.is_empty() && digits.chars().all(|character| character.is_ascii_digit()) {
                normalized.truncate(open_index);
                normalized = normalized.trim_end().to_string();
            }
        }
    }

    if let Some(dash_index) = normalized.rfind('-') {
        let suffix = normalized[dash_index + 1..].trim_start();
        if !suffix.is_empty() && suffix.chars().all(|character| character.is_ascii_digit()) {
            normalized.truncate(dash_index);
            normalized = normalized.trim_end().to_string();
        }
    }

    if let Some((separator_index, separator)) = normalized.char_indices().next_back() {
        let has_leading_space = normalized[..separator_index]
            .chars()
            .next_back()
            .is_some_and(char::is_whitespace);
        if has_leading_space && matches!(separator, '-' | '–' | '—' | '|') {
            normalized.truncate(separator_index);
            normalized = normalized.trim_end().to_string();
        }
    }

    normalized
}

pub fn spawn(
    receiver: Receiver<BrowserEvent>,
    stop: Arc<AtomicBool>,
    paused: Arc<AtomicBool>,
) -> JoinHandle<()> {
    thread::spawn(move || {
        if let Err(error) = run(receiver, &stop, &paused) {
            eprintln!("watcher stopped: {error}");
        }
    })
}

fn run(
    receiver: Receiver<BrowserEvent>,
    stop: &AtomicBool,
    paused: &AtomicBool,
) -> Result<(), String> {
    let mut connection = db::open()?;
    let mut current: Option<ActiveSegment> = None;
    let mut browser_event: Option<BrowserEvent> = None;

    while !stop.load(Ordering::Relaxed) {
        for event in receiver.try_iter() {
            if browser_event
                .as_ref()
                .map(|current_event| event.ts >= current_event.ts)
                .unwrap_or(true)
            {
                browser_event = Some(event);
            }
        }

        let now = db::now_ms();
        if paused.load(Ordering::Relaxed) {
            if let Some(segment) = current.take() {
                finish_segment(&mut connection, segment.id, now)?;
            }
            wait_for_next_tick(stop, paused, true);
            continue;
        }

        if let Some(state) = platform::sample(&connection, browser_event.as_ref(), now)? {
            if is_task_switcher(&state) {
                wait_for_next_tick(stop, paused, false);
                continue;
            }
            if current
                .as_ref()
                .is_some_and(|segment| !same_local_date(&connection, segment.ts_start, now))
            {
                if let Some(segment) = current.take() {
                    finish_segment(&mut connection, segment.id, now)?;
                }
            }
            match current.as_mut() {
                Some(segment) if segment.state == state => {
                    checkpoint(&connection, segment.id, now)?
                }
                Some(segment) => {
                    finish_segment(&mut connection, segment.id, now)?;
                    current = Some(start_segment(&mut connection, state, now)?);
                }
                None => current = Some(start_segment(&mut connection, state, now)?),
            }
        } else if let Some(segment) = current.take() {
            finish_segment(&mut connection, segment.id, now)?;
        }

        wait_for_next_tick(stop, paused, false);
    }

    if let Some(segment) = current {
        finish_segment(&mut connection, segment.id, db::now_ms())?;
    }
    Ok(())
}

fn wait_for_next_tick(stop: &AtomicBool, paused: &AtomicBool, expected_pause: bool) {
    let slices = POLL_INTERVAL.as_millis() / 100;
    for _ in 0..slices {
        if stop.load(Ordering::Relaxed) || paused.load(Ordering::Relaxed) != expected_pause {
            break;
        }
        thread::sleep(Duration::from_millis(100));
    }
}

fn start_segment(
    connection: &mut Connection,
    state: ActivityState,
    timestamp: i64,
) -> Result<ActiveSegment, String> {
    let category_id = classify(connection, &state)?;
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    transaction
        .execute(
            "INSERT INTO segments (ts_start, ts_end, app, window_title, domain, category_id, status)
             VALUES (?1, ?1, ?2, ?3, ?4, ?5, ?6)",
            params![timestamp, state.app, state.title, state.domain, category_id, state.status],
        )
        .map_err(|error| error.to_string())?;
    let id = transaction.last_insert_rowid();
    transaction
        .execute(
            "INSERT INTO settings (key, value) VALUES ('active_segment_id', ?1)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            [id.to_string()],
        )
        .map_err(|error| error.to_string())?;
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(ActiveSegment {
        id,
        ts_start: timestamp,
        state,
    })
}

fn checkpoint(connection: &Connection, id: i64, timestamp: i64) -> Result<(), String> {
    connection
        .execute(
            "UPDATE segments SET ts_end = ?1 WHERE id = ?2",
            params![timestamp, id],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn finish_segment(connection: &mut Connection, id: i64, timestamp: i64) -> Result<(), String> {
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    transaction
        .execute(
            "UPDATE segments SET ts_end = ?1 WHERE id = ?2",
            params![timestamp, id],
        )
        .map_err(|error| error.to_string())?;
    transaction
        .execute(
            "DELETE FROM settings WHERE key = 'active_segment_id' AND value = ?1",
            [id.to_string()],
        )
        .map_err(|error| error.to_string())?;
    for local_date in db::segment_local_dates(&transaction, id)? {
        db::refresh_daily_stats(&transaction, &local_date)?;
    }
    transaction.commit().map_err(|error| error.to_string())
}

fn same_local_date(connection: &Connection, first: i64, second: i64) -> bool {
    connection
        .query_row(
            "SELECT date(?1 / 1000, 'unixepoch', 'localtime') = date(?2 / 1000, 'unixepoch', 'localtime')",
            params![first, second],
            |row| row.get(0),
        )
        .unwrap_or(true)
}

fn classify(connection: &Connection, state: &ActivityState) -> Result<i64, String> {
    let domain = state.domain.to_lowercase();
    let title = state.title.to_lowercase();
    let app = state.app.to_lowercase();
    connection
        .query_row(
            "SELECT category_id FROM rules
             WHERE (match_type = 'domain' AND instr(?1, pattern) > 0)
                OR (match_type = 'title' AND instr(?2, pattern) > 0)
                OR (match_type = 'exe' AND instr(?3, pattern) = 1)
             ORDER BY priority DESC,
                      CASE match_type WHEN 'domain' THEN 3 WHEN 'title' THEN 2 ELSE 1 END DESC,
                      id ASC
             LIMIT 1",
            params![domain, title, app],
            |row| row.get(0),
        )
        .optional()
        .map(|category_id| category_id.unwrap_or(0))
        .map_err(|error| error.to_string())
}

#[cfg(windows)]
mod platform {
    use super::{normalize_title, ActivityState, BrowserEvent, BROWSER_EVENT_MAX_AGE_MS};
    use crate::db;
    use rusqlite::Connection;
    use std::mem::size_of;
    use std::path::Path;
    use windows::core::PWSTR;
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::SystemInformation::GetTickCount;
    use windows::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
        PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use windows::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};
    use windows::Win32::UI::WindowsAndMessaging::{
        GetForegroundWindow, GetWindowTextLengthW, GetWindowTextW, GetWindowThreadProcessId,
    };

    pub fn sample(
        connection: &Connection,
        browser_event: Option<&BrowserEvent>,
        now: i64,
    ) -> Result<Option<ActivityState>, String> {
        let hwnd = unsafe { GetForegroundWindow() };
        if hwnd.0.is_null() {
            return Ok(None);
        }

        let title = normalize_title(&window_title(hwnd));
        let (app, protected_window) = match process_name(hwnd) {
            Ok(app) if !app.is_empty() => (app, false),
            _ => ("system".to_string(), true),
        };
        let app_lower = app.to_lowercase();
        let idle_timeout_ms = db::setting(connection, "idle_timeout_min")?
            .and_then(|value| value.parse::<u64>().ok())
            .unwrap_or(5)
            .saturating_mul(60_000);
        let forced_away =
            protected_window || matches!(app_lower.as_str(), "lockapp.exe" | "logonui.exe");
        let idle = is_idle(idle_timeout_ms);

        if is_own_window(&app_lower) {
            return Ok(None);
        }

        let (domain, fused_title) = if matches!(app_lower.as_str(), "chrome.exe" | "msedge.exe") {
            browser_event
                .filter(|event| {
                    let age = now.saturating_sub(event.ts);
                    (0..=BROWSER_EVENT_MAX_AGE_MS).contains(&age)
                })
                .map(|event| (event.domain.clone(), normalize_title(&event.title)))
                .unwrap_or_else(|| (String::new(), title.clone()))
        } else {
            (String::new(), title.clone())
        };
        let media_playing =
            fused_title.contains('▶') || fused_title.to_lowercase().contains("(playing)");

        Ok(Some(ActivityState {
            app,
            title: fused_title,
            domain,
            status: if forced_away || (idle && !media_playing) {
                "away"
            } else {
                "active"
            },
        }))
    }

    fn window_title(hwnd: windows::Win32::Foundation::HWND) -> String {
        let length = unsafe { GetWindowTextLengthW(hwnd) };
        if length <= 0 {
            return String::new();
        }
        let mut buffer = vec![0_u16; length as usize + 1];
        let copied = unsafe { GetWindowTextW(hwnd, &mut buffer) };
        String::from_utf16_lossy(&buffer[..copied.max(0) as usize])
    }

    fn process_name(hwnd: windows::Win32::Foundation::HWND) -> Result<String, String> {
        let mut process_id = 0_u32;
        unsafe { GetWindowThreadProcessId(hwnd, Some(&mut process_id)) };
        if process_id == 0 {
            return Ok(String::new());
        }

        let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, process_id) }
            .map_err(|error| error.to_string())?;
        let mut buffer = vec![0_u16; 32_768];
        let mut size = buffer.len() as u32;
        let result = unsafe {
            QueryFullProcessImageNameW(
                process,
                PROCESS_NAME_WIN32,
                PWSTR(buffer.as_mut_ptr()),
                &mut size,
            )
        };
        unsafe { CloseHandle(process) }.map_err(|error| error.to_string())?;
        result.map_err(|error| error.to_string())?;

        let path = String::from_utf16_lossy(&buffer[..size as usize]);
        Ok(Path::new(&path)
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or(&path)
            .to_string())
    }

    fn is_idle(timeout_ms: u64) -> bool {
        let mut info = LASTINPUTINFO {
            cbSize: size_of::<LASTINPUTINFO>() as u32,
            dwTime: 0,
        };
        if !unsafe { GetLastInputInfo(&mut info) }.as_bool() {
            return false;
        }
        let elapsed = unsafe { GetTickCount() }.wrapping_sub(info.dwTime) as u64;
        elapsed >= timeout_ms
    }

    fn is_own_window(app: &str) -> bool {
        matches!(app, "time-to-lock-in.exe" | "time_to_lock_in.exe")
    }
}

#[cfg(not(windows))]
mod platform {
    use super::{ActivityState, BrowserEvent};
    use rusqlite::Connection;

    pub fn sample(
        _connection: &Connection,
        _browser_event: Option<&BrowserEvent>,
        _now: i64,
    ) -> Result<Option<ActivityState>, String> {
        Ok(None)
    }
}

#[cfg(test)]
mod tests {
    use super::{is_task_switcher, normalize_title, ActivityState};

    #[test]
    fn normalizes_volatile_title_suffixes_and_whitespace() {
        for (title, expected) in [
            ("Telegram (42)", "Telegram"),
            ("Download (42%)", "Download"),
            ("Chat - 42", "Chat"),
            ("New  Chat - (42)", "New Chat"),
            ("Title —", "Title"),
            ("Title |", "Title"),
        ] {
            assert_eq!(normalize_title(title), expected);
        }
    }

    #[test]
    fn preserves_media_markers() {
        assert_eq!(normalize_title("Song (playing)"), "Song (playing)");
        assert_eq!(normalize_title("▶  Song"), "▶ Song");
    }

    #[test]
    fn recognizes_windows_task_switcher() {
        for title in ["Переключение задач", "Task Switching", "Switch To Desktop"]
        {
            assert!(is_task_switcher(&ActivityState {
                app: "EXPLORER.EXE".to_string(),
                title: title.to_string(),
                domain: String::new(),
                status: "active",
            }));
        }

        assert!(!is_task_switcher(&ActivityState {
            app: "other.exe".to_string(),
            title: "Task Switching".to_string(),
            domain: String::new(),
            status: "active",
        }));
    }
}
