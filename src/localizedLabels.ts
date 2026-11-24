import type { Lang } from "./i18n";

export function localizedKind(value: string | undefined, fallback: string): string {
  const stock = ["Полезное", "Нейтральное", "Потери", "Наблюдение", "Корисне", "Нейтральне", "Втрати", "Спостереження", "Useful", "Neutral", "Waste", "Observed", "Tracked"];
  return !value || stock.includes(value) ? fallback : value;
}

const ranks = ["Хомяк", "Стажёр", "Кодер", "Фокусник", "Тайм-ниндзя", "Киберсамурай", "Архитектор времени", "Повелитель времени"];
const englishRanks = ["Hamster", "Intern", "Coder", "Focus Mage", "Time Ninja", "Cyber Samurai", "Time Architect", "Time Lord"];
const ukrainianRanks = ["Хом’як", "Стажер", "Кодер", "Фокусник", "Тайм-ніндзя", "Кіберсамурай", "Архітектор часу", "Володар часу"];

export function localizedRank(name: string, lang: Lang): string {
  const index = ranks.indexOf(name);
  const translated = lang === "en" ? englishRanks : lang === "ua" ? ukrainianRanks : ranks;
  return translated[index] ?? name;
}
