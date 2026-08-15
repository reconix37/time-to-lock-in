import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";

const params = new URLSearchParams(window.location.search);
const large = params.get("large") === "1";
const requestedLanguage = params.get("lang");
const language = requestedLanguage === "ua" || requestedLanguage === "en" ? requestedLanguage : "ru";
const kindLabels = {
  ru: { useful: "Заебись с очень длинной меткой", neutral: "Нейтрально", waste: "Пиздец" },
  ua: { useful: "Корисне з дуже довгою міткою", neutral: "Нейтральне", waste: "Втрати" },
  en: { useful: "Useful with a very long label", neutral: "Neutral", waste: "Waste" },
}[language];
mockWindows("mini");
mockIPC((command) => {
  if (command === "get_settings") return {
    language,
    mini_mode: "auto",
    mini_text_size: large ? "large" : "normal",
    mini_pinned: "1",
    mini_privacy_now: "0",
    mini_opacity: "100",
    tray_only: "0",
    kind_label_useful: kindLabels.useful,
    kind_label_neutral: kindLabels.neutral,
    kind_label_waste: kindLabels.waste,
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
  if (command === "get_mini_state") return {
    pinned: true,
    corner: null,
    resizable: true,
    position_x: 0,
    position_y: 0,
  };
  if (command === "get_today_scoring") return {
    total_score: -13.7,
    productive_percent: 40.5,
    top_productive: [
      { category_id: 2, name: "Video", full_path: "Work > Video", effective_color: "#286983", duration_ms: 102 * 60_000, points: 5.8 },
      { category_id: 4, name: "3D", full_path: "Work > 3D", effective_color: "#56949f", duration_ms: 44 * 60_000, points: 1.4 },
    ],
    top_distracting: [
      { category_id: 3, name: "Socials", full_path: "Waste > Socials", effective_color: "#b4637a", duration_ms: 58 * 60_000, points: -18.7 },
      { category_id: 5, name: "Games", full_path: "Waste > Games", effective_color: "#907aa9", duration_ms: 31 * 60_000, points: -2.2 },
    ],
    top_categories: [
      { category_id: 2, name: "Video", full_path: "Work > Video", effective_color: "#286983", duration_ms: 102 * 60_000, points: 5.8 },
      { category_id: 3, name: "Socials", full_path: "Waste > Socials", effective_color: "#b4637a", duration_ms: 58 * 60_000, points: -18.7 },
      { category_id: 4, name: "3D", full_path: "Work > 3D", effective_color: "#56949f", duration_ms: 44 * 60_000, points: 1.4 },
      { category_id: 5, name: "Games", full_path: "Waste > Games", effective_color: "#907aa9", duration_ms: 31 * 60_000, points: -2.2 },
    ],
  };
  if (["resize_mini", "save_mini_geometry", "show_dashboard", "start_mini_drag", "minimize_mini", "hide_mini"].includes(command)) return undefined;
  return undefined;
}, { shouldMockEvents: true });

await import("../src/main");
