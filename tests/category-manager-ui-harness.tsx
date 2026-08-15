import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { createRoot } from "react-dom/client";
import { CategoryManager, type Category, type Rule } from "../src/components/CategoryManager";
import { I18nProvider } from "../src/i18nContext";
import "../src/styles/tokens.css";
import "../src/App.css";
import "../src/category-manager.css";

const categories: Category[] = [
  { id: 0, name: "Uncategorized", color: "#9893a5", icon: "", kind: "neutral", goal_multiplier: 1, sort_order: 0, parent_id: null, score: 0, inherit_color: false, inherit_score: false, effective_color: "#9893a5", effective_score: 0, full_path: "Uncategorized" },
  { id: 1, name: "Work", color: "#286983", icon: "", kind: "useful", goal_multiplier: 1, sort_order: 1, parent_id: null, score: 10, inherit_color: false, inherit_score: false, effective_color: "#286983", effective_score: 10, full_path: "Work" },
  { id: 2, name: "Video", color: "#286983", icon: "", kind: "useful", goal_multiplier: 1, sort_order: 2, parent_id: 1, score: 5, inherit_color: true, inherit_score: false, effective_color: "#286983", effective_score: 5, full_path: "Work > Video" },
  { id: 3, name: "3D", color: "#286983", icon: "", kind: "useful", goal_multiplier: 1, sort_order: 3, parent_id: 1, score: 10, inherit_color: true, inherit_score: true, effective_color: "#286983", effective_score: 10, full_path: "Work > 3D" },
  { id: 4, name: "Waste", color: "#b4637a", icon: "", kind: "waste", goal_multiplier: 1, sort_order: 4, parent_id: null, score: -10, inherit_color: false, inherit_score: false, effective_color: "#b4637a", effective_score: -10, full_path: "Waste" },
];
const rules: Rule[] = [
  { id: 1, match_type: "domain", pattern: "youtube.com/watch?v=full-pattern-is-readable", category_id: 4, priority: 2, match_mode: "legacy", case_insensitive: true },
  { id: 2, match_type: "title", pattern: "\\bblender\\b|tutorial|course", category_id: 2, priority: 1, match_mode: "regex", case_insensitive: true },
];

mockWindows("main");
mockIPC((command) => {
  if (command === "get_settings") return { language: "ru" };
  if (command === "get_categories") return categories;
  if (command === "get_rules") return rules;
  if (command === "preview_reclassify_history") return { changed_segments: 37, changed_duration_ms: 12_240_000 };
  if (command === "preview_rule") return { matched_values: 12, total_values: 80, matched_duration_ms: 12_240_000, broad_warning: false };
  return undefined;
}, { shouldMockEvents: true });

createRoot(document.getElementById("root")!).render(
  <I18nProvider>
    <CategoryManager
      open
      categories={categories}
      kindLabels={{ useful: "Заебись", neutral: "Нутакое", waste: "Пиздец", observed: "Учтено" }}
      formatDuration={(durationMs) => `${Math.floor(durationMs / 3_600_000)}ч ${Math.floor((durationMs % 3_600_000) / 60_000)}м`}
      observedMs={17_040_000}
      appCount={8}
      uncategorizedMs={2_044_800}
      onClose={() => undefined}
      onCategoriesChange={() => undefined}
      onDashboardRefresh={async () => undefined}
    />
  </I18nProvider>,
);

const mode = new URLSearchParams(window.location.search).get("view");
window.setTimeout(() => {
  const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>("button"));
  if (mode === "allRules") buttons.find((button) => button.textContent?.trim() === "Все правила")?.click();
  if (mode === "newRule") buttons.find((button) => button.textContent?.trim() === "Добавить правило")?.click();
}, 200);
