export interface DailySeriesDay {
  local_date: string;
  useful_ms: number;
  neutral_ms: number;
  waste_ms: number;
  observed_ms: number;
  useful_goal_min: number;
  waste_limit_min: number;
  observed_min: number;
  passed: boolean;
  useful_xp: number;
  useful_ma_7d_ms: number;
}

export interface AfkDay {
  local_date: string;
  afk_ms: number;
}

import { localeForLang, type Lang } from "./i18n";

export function formatLocalDate(
  localDate: string,
  options: Intl.DateTimeFormatOptions,
  lang: Lang = "ru",
): string {
  return new Intl.DateTimeFormat(localeForLang(lang), options).format(new Date(`${localDate}T12:00:00`));
}
