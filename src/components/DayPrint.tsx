import { useState } from "react";
import type { DayPrintData, DayPrintEntry, KindLabels, WeekSummaryData } from "../share";
import type { Category } from "./CategoryManager";
import { localeForLang } from "../i18n";
import { useI18n } from "../i18nContext";
import { formatLocalDate } from "../trends";

interface DayPrintProps {
  data: DayPrintData | null;
  mode: "day" | "week";
  week: WeekSummaryData | null;
  todayDate: string;
  categories: Category[];
  saving: boolean;
  selectedDayCode: string | null;
  availableDates: string[];
  selectedDate: string;
  busyAction: "day" | "week" | "challenge" | null;
  message: string | null;
  formatDuration: (milliseconds: number) => string;
  kindLabels: KindLabels;
  observedLabel?: string;
  onDateChange: (localDate: string) => void;
  onModeChange: (mode: "day" | "week") => void;
  onMoveEntry: (app: string, from: number, to: number) => void;
  onAcceptChallenge: (code: string) => void;
  onShareDay: () => void;
  onShareWeek: () => void;
  onShareChallenge: (code: string) => void;
}

function EntryCategory({ entry, categories, saving, onMove }: {
  entry: DayPrintEntry;
  categories: Category[];
  saving: boolean;
  onMove: DayPrintProps["onMoveEntry"];
}) {
  const { t } = useI18n();
  const [selected, setSelected] = useState(entry.category_id);
  return <div className="verdict-category">
    <select aria-label={t("verdict.categoryFor", { app: entry.app })} disabled={saving}
      value={selected} onChange={(event) => setSelected(Number(event.target.value))}>
      {categories.map((category) => <option key={category.id} value={category.id}>
        {category.id === 0 ? t("common.uncategorized") : category.full_path}
      </option>)}
    </select>
    {selected !== entry.category_id && <button type="button" disabled={saving}
      title={t("verdict.moveScope")}
      onClick={() => onMove(entry.app, entry.category_id, selected)}>{t("verdict.move")}</button>}
  </div>;
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
  mode, week, todayDate, categories, saving, selectedDayCode,
  availableDates,
  selectedDate,
  busyAction,
  message,
  formatDuration,
  kindLabels,
  observedLabel,
  onDateChange,
  onModeChange, onMoveEntry, onAcceptChallenge,
  onShareDay,
  onShareWeek,
  onShareChallenge,
}: DayPrintProps) {
  const { lang, t } = useI18n();
  const [showChallenges, setShowChallenges] = useState(false);
  const [challenge, setChallenge] = useState("TF-60-30-90");
  const locale = localeForLang(lang);
  const empty = !data || (data.observed_ms === 0 && data.afk_ms === 0 && data.top_entries.length === 0);
  const dateIndex = availableDates.indexOf(selectedDate);
  const formatDay = (date: string) => formatLocalDate(date, { day: "numeric", month: "short", year: "numeric" }, lang);
  const [goalUseful, goalWaste, goalObserved] = challenge.split("-").slice(1).map(Number);
  return (
    <section className="day-print-section" aria-labelledby="day-print-title">
      <div className="day-print-toolbar">
        <div>
          <span className="eyebrow">{t("print.eyebrow")}</span>
          <h2 id="day-print-title">{t("print.title")}</h2>
        </div>
        <div className="verdict-navigation">
        <div className="segmented-control" role="group" aria-label={t("print.title")}>
          <button type="button" aria-pressed={mode === "day"} onClick={() => onModeChange("day")}>{t("print.day")}</button>
          <button type="button" aria-pressed={mode === "week"} onClick={() => onModeChange("week")}>{t("verdict.week")}</button>
        </div>
        <button type="button" aria-label={t("verdict.previous")} disabled={dateIndex < 0 || dateIndex >= availableDates.length - 1} onClick={() => onDateChange(availableDates[dateIndex + 1])}>‹</button>
        <label>
          <span>{t("print.day")}</span>
          <select className="with-chevron" value={selectedDate} onChange={(event) => onDateChange(event.target.value)}>
            {availableDates.map((date) => <option key={date} value={date}>{formatLocalDate(date, { day: "numeric", month: "long", year: "numeric" }, lang)}</option>)}
          </select>
        </label>
        <button type="button" aria-label={t("verdict.next")} disabled={dateIndex <= 0} onClick={() => onDateChange(availableDates[dateIndex - 1])}>›</button>
        <button type="button" onClick={() => onDateChange(todayDate)} disabled={selectedDate === todayDate}>{t("verdict.today")}</button>
        </div>
      </div>

      {mode === "week" && week && <div className="day-print-terminal">
        <p className="day-print-command">{formatDay(week.days[0]?.local_date ?? selectedDate)} — {formatDay(selectedDate)}</p>
        <p className="day-print-status">{week.passed_count} / {week.days.length} · +{week.week_xp} XP</p>
        <div className="day-print-conditions">
          <strong>{kindLabels.useful} · {formatDuration(week.useful_ms)}</strong>
          <strong>{kindLabels.waste} · {formatDuration(week.waste_ms)}</strong>
          <strong>{kindLabels.observed} · {formatDuration(week.useful_ms + week.neutral_ms + week.waste_ms)}</strong>
        </div>
        <div className="day-print-totals"><span>{kindLabels.neutral} {formatDuration(week.neutral_ms)}</span><span>AFK: {formatDuration(week.afk_ms)}</span></div>
        <div className="verdict-week-days">{week.days.map((day) =>
          <button type="button" key={day.local_date} onClick={() => { onDateChange(day.local_date); onModeChange("day"); }}>
            {formatDay(day.local_date)} · {formatDuration(day.useful_ms)} · {day.observed_ms === 0 ? "—" : day.passed ? "✓" : "×"}
          </button>)}</div>
      </div>}
      {((mode === "week" && !week) || (mode === "day" && !data)) && <p role="status">…</p>}
      {mode === "day" && data && <div className="day-print-terminal">
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
          {data.top_entries.map((entry) => (
            <div className="day-print-entry" key={`${data.local_date}-${entry.app}-${entry.category_id}`}>
              <span>{entry.app.replace(/\.exe$/i, "")}</span>
              <EntryCategory entry={entry} categories={categories} saving={saving} onMove={onMoveEntry} />
              <code>{formatDuration(entry.duration_ms)}</code>
            </div>
          ))}
          {data.top_entries.length === 0 && <p className="day-print-empty">{t("print.noEntries")}</p>}
        </div>
        <p className="day-print-privacy">{t("print.privacy")}</p>
      </div>}

      <div className="share-actions" aria-label={t("print.shareLabel")}>
        {mode === "day" && <button type="button" className="share-primary" disabled={empty || busyAction !== null} onClick={onShareDay}>
          {busyAction === "day" ? t("print.drawing") : t("print.shareDay")}
        </button>}
        {mode === "week" && <button type="button" disabled={!week || busyAction !== null} onClick={onShareWeek}>
          {busyAction === "week" ? t("print.drawing") : t("print.shareWeek")}
        </button>}
        <button type="button" aria-expanded={showChallenges} onClick={() => setShowChallenges(!showChallenges)}>{t("verdict.challenges")}</button>
        {message && <span role="status">{message}</span>}
      </div>
      {showChallenges && <div className="day-print-terminal verdict-challenges">
        <div className="segmented-control">
          <button type="button" aria-pressed={challenge === "TF-60-30-90"} onClick={() => setChallenge("TF-60-30-90")}>{t("verdict.focus")}</button>
          <button type="button" aria-pressed={challenge === "TF-120-15-150"} onClick={() => setChallenge("TF-120-15-150")}>{t("verdict.lowScroll")}</button>
          {selectedDayCode && !empty && <button type="button" aria-pressed={challenge === selectedDayCode} onClick={() => setChallenge(selectedDayCode)}>{t("verdict.beatDay")}</button>}
        </div>
        <div className="day-print-conditions">
          <strong>{kindLabels.useful} ≥ {formatDuration(goalUseful * 60_000)}</strong>
          <strong>{kindLabels.waste} ≤ {formatDuration(goalWaste * 60_000)}</strong>
          <strong>{kindLabels.observed} ≥ {formatDuration(goalObserved * 60_000)}</strong>
        </div>
        <div className="share-actions">
          <button className="share-primary" type="button" disabled={saving} onClick={() => onAcceptChallenge(challenge)}>✓ {t("verdict.acceptToday")}</button>
          <button type="button" disabled={busyAction !== null} onClick={() => onShareChallenge(challenge)}>{t("verdict.exportChallenge")}</button>
        </div>
      </div>}
    </section>
  );
}
