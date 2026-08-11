const BROWSER_SUFFIX = /\s+-\s+(?:Google Chrome|Microsoft Edge|Opera|Firefox)\s*$/i;
const CONTENT_PLATFORM_SUFFIX = /\s+-\s+YouTube\s*$/i;
const LEADING_COUNTER = /^\(\d+\)\s*/;
const WORDS = /[\p{L}\p{N}]+/gu;
const NOISE_WORDS = new Set([
  "смотреть",
  "смотрите",
  "сериал",
  "фильм",
  "онлайн",
  "бесплатно",
  "в",
  "хорошем",
  "качестве",
  "все",
  "watch",
  "online",
  "free",
  "hd",
  "full",
  "film",
  "movie",
  "series",
  "in",
  "good",
  "quality",
  "4k",
  "1080p",
  "720p",
]);
const EPISODE_WORDS = new Set([
  "серия",
  "серии",
  "серий",
  "эпизод",
  "episode",
  "episodes",
]);

export function nextRulePriority(rules: readonly { priority: number }[]): number {
  return Math.max(0, ...rules.map((rule) => rule.priority)) + 1;
}

function isEpisodeNumber(tokens: string[], index: number): boolean {
  if (!/^\d+$/.test(tokens[index])) return false;

  const previous = tokens[index - 1]?.toLowerCase();
  const next = tokens[index + 1]?.toLowerCase();
  return EPISODE_WORDS.has(previous) || EPISODE_WORDS.has(next);
}

export function titleRulePattern(title: string): string {
  const cleanedTitle = title
    .trim()
    .replace(LEADING_COUNTER, "")
    .replace(BROWSER_SUFFIX, "")
    .trim();

  const tokens = cleanedTitle.replace(CONTENT_PLATFORM_SUFFIX, "").match(WORDS) ?? [];
  // Номер сезона значим; удаляем только номер, стоящий рядом с маркером серии.
  const core = tokens.filter((token, index) => {
    const normalized = token.toLowerCase();
    return !NOISE_WORDS.has(normalized)
      && !EPISODE_WORDS.has(normalized)
      && !isEpisodeNumber(tokens, index);
  });

  // Правило из одних стоп-слов не должно превращаться в пустой паттерн.
  return core.length > 0 ? core.join(" ") : cleanedTitle;
}
