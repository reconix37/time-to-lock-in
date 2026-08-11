const BROWSER_SUFFIX = /\s+-\s+(?:Google Chrome|Microsoft Edge|Opera|Firefox)\s*$/i;
const LEADING_COUNTER = /^\(\d+\)\s*/;

export function titleRulePattern(title: string): string {
  return title
    .trim()
    .replace(LEADING_COUNTER, "")
    .replace(BROWSER_SUFFIX, "")
    .trim();
}
