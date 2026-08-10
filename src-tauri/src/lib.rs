// Time To Lock In — точка входа.
// Инфраструктура: плагины (sql, autostart, single-instance, dialog).
// Вотчер/сегменты/API расширения — в watcher.rs, http.rs (вертикальный слайс).

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            tauri_plugin_sql::Builder::default()
                .add_migrations(
                    "sqlite:time_to_lock_in.db",
                    vec![
                        tauri_plugin_sql::Migration {
                            version: 1,
                            description: "init",
                            sql: include_str!("../migrations/001_init.sql"),
                        },
                    ],
                )
                .build(),
        )
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec![]),
        ));

    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // Второй запуск — фокус на существующее главное окно
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.show();
                let _ = win.set_focus();
            }
        }));
    }

    builder
        .invoke_handler(tauri::generate_handler![])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
