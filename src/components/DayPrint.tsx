import type { DayPrintData, KindLabels } from "../share";
import { localeForLang } from "../i18n";
import { useI18n } from "../i18nContext";
import { formatLocalDate } from "../trends";

interface DayPrintProps {
  data: DayPrintData;
  availableDates: string[];
  selectedDate: string;
  busyAction: "day" | "week" | "challenge" | null;
  message: string | null;
  formatDuration: (milliseconds: number) => string;
  kindLabels: KindLabels;
  observedLabel?: string;
  onDateChange: (localDate: string) => void;
  onShareDay: () => void;
  onShareWeek: () => void;
  onShareChallenge: () => void;
}

function ConditionLine({ label, value, threshold, passed, limit = false, empty = false }: {
  label: string;
  value: number;
  threshold: number;
  passed: boolean;
  limit?: boolean;
  empty?: boolean;
}) {
  const { t } = useI18n();
  return (
    <div className="day-print-condition">
      <span className={empty ? "" : passed ? "is-ok" : "is-bad"} aria-label={empty ? undefined : passed ? t("print.conditionComplete") : t("print.conditionIncomplete")}>{empty ? "·" : passed ? "✓" : "×"}</span>
      <strong>{label}</strong>
      <code>{Math.floor(value / 60_000)}{t("common.minutesShort")} {limit ? "≤" : "≥"} {threshold}{t("common.minutesShort")}</code>
    </div>
  );
}

export function DayPrint({
  data,
  availableDates,
  selectedDate,
  busyAction,
  message,
  formatDuration,
  kindLabels,
  observedLabel,
  onDateChange,
  onShareDay,
  onShareWeek,
  onShareChallenge,
}: DayPrintProps) {
  const { lang, t } = useI18n();
  const locale = localeForLang(lang);
  const empty = data.observed_ms === 0 && data.afk_ms === 0 && data.top_entries.length === 0;
  return (
    <section className="day-print-section" aria-labelledby="day-print-title">
      <div className="day-print-toolbar">
        <div>
          <span className="eyebrow">{t("print.eyebrow")}</span>
          <h2 id="day-print-title">{t("print.title")}</h2>
        </div>
        <label>
          <span>{t("print.day")}</span>
          <select value={selectedDate} onChange={(event) => onDateChange(event.target.value)}>
            {availableDates.map((date) => <option key={date} value={date}>{formatLocalDate(date, { day: "numeric", month: "long", year: "numeric" }, lang)}</option>)}
          </select>
        </label>
      </div>

      <div className="day-print-terminal">
        <p className="day-print-command">{t("print.dailyLog", { date: formatLocalDate(data.local_date, { day: "2-digit", month: "2-digit", year: "numeric" }, lang) })}</p>
        <p className={`day-print-status ${empty ? "" : data.passed ? "is-ok" : "is-bad"}`}>
          {t("print.status")} {empty ? t("print.noData") : data.passed ? t("print.statusPassed") : t("print.statusFailed")} · +{data.public_xp} XP
        </p>
        <div className="day-print-conditions">
          <ConditionLine label={kindLabels.useful.toLocaleUpperCase(locale)} value={data.useful_ms} threshold={data.useful_goal_min} passed={data.useful_passed} empty={empty} />
          <ConditionLine label={kindLabels.waste.toLocaleUpperCase(locale)} value={data.waste_ms} threshold={data.waste_limit_min} passed={data.waste_passed} limit empty={empty} />
          <ConditionLine label={(observedLabel ?? kindLabels.observed).toLocaleUpperCase(locale)} value={data.observed_ms} threshold={data.observed_min} passed={data.observed_passed} empty={empty} />
        </div>
        {data.challenge_passed !== null && (
          <p className={`day-print-challenge ${empty ? "" : data.challenge_passed ? "is-ok" : "is-bad"}`}>
            {empty ? t("print.challengePending") : data.challenge_passed ? t("print.challengePassed") : t("print.challengeFailed")} · {data.challenge_code}
          </p>
        )}
        <div className="day-print-totals">
          <span>{kindLabels.neutral} {formatDuration(data.neutral_ms)}</span>
          <span>AFK: {formatDuration(data.afk_ms)}</span>
          {data.burned_rubles !== null && <strong>{t("print.burned", { currency: data.currency, amount: data.burned_rubles.toLocaleString(locale, { maximumFractionDigits: 2 }) })}</strong>}
        </div>
        <div className="day-print-entries">
          {data.top_entries.slice(0, 5).map((entry) => (
            <p className="day-print-entry" key={`${entry.app}-${entry.category_name}`}>
              <span>{entry.app.replace(/\.exe$/i, "")}</span>
              <b className={`kind-${entry.category_kind}`}>{entry.is_uncategorized ? t("common.uncategorized") : entry.category_name}</b>
              <code>{formatDuration(entry.duration_ms)}</code>
            </p>
          ))}
          {data.top_entries.length === 0 && <p className="day-print-empty">{t("print.noEntries")}</p>}
        </div>
        <p className="day-print-privacy">{t("print.privacy")}</p>
      </div>

      <div className="share-actions" aria-label={t("print.shareLabel")}>
        <button className="share-primary" disabled={empty || busyAction !== null} onClick={onShareDay}>
          {busyAction === "day" ? t("print.drawing") : t("print.shareDay")}
        </button>
        <button disabled={empty || busyAction !== null} onClick={onShareWeek}>
          {busyAction === "week" ? t("print.drawing") : t("print.shareWeek")}
        </button>
        <button disabled={empty || busyAction !== null} onClick={onShareChallenge}>
          {busyAction === "challenge" ? t("print.drawing") : t("print.challenge")}
        </button>
        {message && <span role="status">{message}</span>}
      </div>
    </section>
  );
}
