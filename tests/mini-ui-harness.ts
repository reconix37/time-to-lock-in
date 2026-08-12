import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";

const large = new URLSearchParams(window.location.search).get("large") === "1";
mockWindows("mini");
mockIPC((command) => {
  if (command === "get_settings") return {
    language: "ru",
    mini_mode: "auto",
    mini_text_size: large ? "large" : "normal",
    mini_pinned: "1",
    mini_privacy_now: "0",
    tray_only: "0",
    mini_observed_explained_v1: "1",
    kind_label_useful: "Заебись с очень длинной меткой",
    kind_label_neutral: "Нейтрально",
    kind_label_waste: "Пиздец",
  };
  if (command === "get_progress_overview") return {
    today: {
      local_date: "2026-08-12",
      useful_ms: 198 * 60_000,
      neutral_ms: 72 * 60_000,
      waste_ms: 34 * 60_000,
      observed_ms: 284 * 60_000,
      useful_goal_min: 120,
      waste_limit_min: 60,
      observed_min: 60,
      useful_passed: true,
      waste_passed: true,
      observed_passed: true,
      passed: true,
      useful_level: 4,
      waste_level: 1,
      future: false,
    },
    today_afk_ms: 0,
    lifetime_xp: 2114,
    current_rank: "Кодер",
    current_rank_threshold: 2000,
    next_rank: "Фокусник",
    next_rank_threshold: 5000,
    calendar: [],
  };
  if (command === "get_live_segment") return {
    id: 1,
    ts_start: Date.now() - 60_000,
    ts_end: Date.now(),
    app: "Visual Studio Code.exe",
    window_title: "Time To Lock In",
    domain: "",
    status: "active",
    category_name: "Заебись",
    category_kind: "useful",
    is_uncategorized: false,
  };
  if (command === "get_tracking_paused") return false;
  if (command === "mini_hourly") return Array.from({ length: 12 }, (_, index) => ({
    hour_ts: Date.now() - (11 - index) * 3_600_000,
    useful_ms: index % 2 === 0 ? 25 * 60_000 : 10 * 60_000,
    neutral_ms: 5 * 60_000,
    waste_ms: index % 3 === 0 ? 8 * 60_000 : 0,
  }));
  return undefined;
}, { shouldMockEvents: true });

await import("../src/main");
