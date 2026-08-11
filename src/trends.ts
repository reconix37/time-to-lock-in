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

export function formatLocalDate(localDate: string, options: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat("ru-RU", options).format(new Date(`${localDate}T12:00:00`));
}
