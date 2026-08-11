import type { DayPrintData, KindLabels } from "../share";

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

function conditionLine(label: string, value: number, threshold: number, passed: boolean, limit = false) {
  return (
    <div className="day-print-condition">
      <span className={passed ? "is-ok" : "is-bad"} aria-label={passed ? "выполнено" : "не выполнено"}>{passed ? "✓" : "×"}</span>
      <strong>{label}</strong>
      <code>{Math.floor(value / 60_000)}м {limit ? "≤" : "≥"} {threshold}м</code>
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
  observedLabel = "Наблюдение",
  onDateChange,
  onShareDay,
  onShareWeek,
  onShareChallenge,
}: DayPrintProps) {
  return (
    <section className="day-print-section" aria-labelledby="day-print-title">
      <div className="day-print-toolbar">
        <div>
          <span className="eyebrow">Печать дня</span>
          <h2 id="day-print-title">Терминальный вердикт</h2>
        </div>
        <label>
          <span>День</span>
          <select value={selectedDate} onChange={(event) => onDateChange(event.target.value)}>
            {availableDates.map((date) => <option key={date} value={date}>{date}</option>)}
          </select>
        </label>
      </div>

      <div className="day-print-terminal">
        <p className="day-print-command">TIMEFORGE // DAILY LOG — {data.local_date}</p>
        {data.top_entries.map((entry) => (
          <p className="day-print-entry" key={`${entry.app}-${entry.category_name}`}>
            <span>{entry.app.replace(/\.exe$/i, "")}</span>
            <b className={`kind-${entry.category_kind}`}>{entry.category_name}</b>
            <code>{formatDuration(entry.duration_ms)}</code>
          </p>
        ))}
        {data.top_entries.length === 0 && <p className="day-print-empty">Нет наблюдаемых сегментов.</p>}
        <div className="day-print-conditions">
          {conditionLine(kindLabels.useful.toLocaleUpperCase("ru-RU"), data.useful_ms, data.useful_goal_min, data.useful_passed)}
          {conditionLine(kindLabels.waste.toLocaleUpperCase("ru-RU"), data.waste_ms, data.waste_limit_min, data.waste_passed, true)}
          {conditionLine(observedLabel.toLocaleUpperCase("ru-RU"), data.observed_ms, data.observed_min, data.observed_passed)}
        </div>
        <p className={`day-print-status ${data.passed ? "is-ok" : "is-bad"}`}>
          STATUS: {data.passed ? "ДЕНЬ СИЛЫ" : "ДЕНЬ ЗОМБИ"} · +{data.public_xp} XP · {data.rank}
        </p>
        {data.challenge_passed !== null && (
          <p className={`day-print-challenge ${data.challenge_passed ? "is-ok" : "is-bad"}`}>
            CHALLENGE {data.challenge_passed ? "PASSED" : "FAILED"} · {data.challenge_code}
          </p>
        )}
        <div className="day-print-totals">
          <span>{kindLabels.useful} {formatDuration(data.useful_ms)}</span>
          <span>{kindLabels.neutral} {formatDuration(data.neutral_ms)}</span>
          <span>{kindLabels.waste} {formatDuration(data.waste_ms)}</span>
          {data.burned_rubles !== null && <strong>сожжено {data.currency} {data.burned_rubles.toLocaleString("ru-RU", { maximumFractionDigits: 2 })}</strong>}
        </div>
        <p className="day-print-privacy">Tracked locally. No screenshots.</p>
      </div>

      <div className="share-actions" aria-label="Поделиться результатом">
        <button className="share-primary" disabled={busyAction !== null} onClick={onShareDay}>
          {busyAction === "day" ? "Рисуем…" : "Скинуть Печать дня"}
        </button>
        <button disabled={busyAction !== null} onClick={onShareWeek}>
          {busyAction === "week" ? "Рисуем…" : "Скинуть Неделю"}
        </button>
        <button disabled={busyAction !== null} onClick={onShareChallenge}>
          {busyAction === "challenge" ? "Рисуем…" : "Челлендж"}
        </button>
        {message && <span role="status">{message}</span>}
      </div>
    </section>
  );
}
