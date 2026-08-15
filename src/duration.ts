import type { Translate } from "./i18n";

export function localizedDuration(milliseconds: number, t: Translate): string {
  const totalMinutes = Math.max(0, Math.floor(milliseconds / 60_000));
  if (milliseconds > 0 && totalMinutes === 0) return t("duration.lessMinute");
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return t("duration.minutes", { minutes });
  return minutes === 0 ? t("duration.hours", { hours }) : t("duration.hoursMinutes", { hours, minutes });
}
