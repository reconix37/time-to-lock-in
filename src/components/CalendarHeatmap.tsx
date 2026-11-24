import { useState } from "react";
import type { ProgressDay } from "../progress";
import type { KindLabels } from "../share";
import { localeForLang } from "../i18n";
import { useI18n } from "../i18nContext";

interface CalendarHeatmapProps {
  days: ProgressDay[];
  todayDate: string;
  formatDuration: (milliseconds: number) => string;
  kindLabels: KindLabels;
  selectedDate: string;
  onDateSelect: (date: string) => void;
}

type HeatMode = "useful" | "waste";

function dateLabel(localDate: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { weekday: "long", day: "numeric", month: "long" })
    .format(new Date(`${localDate}T12:00:00`));
}

function thresholdPercent(value: number, thresholdMinutes: number): number {
  return thresholdMinutes > 0 ? Math.round(value / (thresholdMinutes * 60_000) * 100) : 0;
}

export function CalendarHeatmap({ days, todayDate, formatDuration, kindLabels, selectedDate, onDateSelect }: CalendarHeatmapProps) {
  const { lang, t } = useI18n();
  const locale = localeForLang(lang);
  const [mode, setMode] = useState<HeatMode>("useful");
  const [activeDate, setActiveDate] = useState("");
  const activeDay = days.find((day) => day.local_date === (activeDate || selectedDate));
  const monthLabels = days.filter((_, index) => index % 7 === 0).map((day, index) => ({
    key: day.local_date,
    column: index + 1,
    label: new Intl.DateTimeFormat(locale, { month: "short" }).format(new Date(`${day.local_date}T12:00:00`)),
  })).filter((month, index, labels) => index === 0 || month.label !== labels[index - 1].label);

  return (
    <section className={`card heatmap-card heatmap-mode-${mode}`} aria-labelledby="heatmap-title">
      <div className="card-heading heatmap-heading">
        <div><span className="eyebrow">{t("heatmap.eyebrow")}</span><h2 id="heatmap-title">{t("heatmap.title")}</h2></div>
        <div className="segmented-control" role="group" aria-label={t("heatmap.control")}>
          <button type="button" aria-pressed={mode === "useful"} onClick={() => setMode("useful")}>{kindLabels.useful}</button>
          <button type="button" aria-pressed={mode === "waste"} onClick={() => setMode("waste")}>{kindLabels.waste}</button>
        </div>
      </div>
      <div
        className="heatmap-scroll"
        onPointerLeave={() => setActiveDate("")}
      >
        <div className="heatmap-months" aria-hidden="true">
          {monthLabels.map((month) => <span key={month.key} style={{ gridColumn: month.column }}>{month.label}</span>)}
        </div>
        <div className="heatmap-body">
          <div className="heatmap-weekdays" aria-hidden="true">{t("heatmap.weekdays").split("|").map((day) => <span key={day}>{day}</span>)}</div>
          <div className="heatmap-grid" role="group" aria-label={t("heatmap.calendar", { label: mode === "useful" ? kindLabels.useful : kindLabels.waste })}>
            {days.map((day) => {
              const value = mode === "useful" ? day.useful_ms : day.waste_ms;
              const level = mode === "useful" ? day.useful_level : day.waste_level;
              const threshold = mode === "useful" ? day.useful_goal_min : day.waste_limit_min;
              const percent = thresholdPercent(value, threshold);
              const modeLabel = mode === "useful" ? kindLabels.useful : kindLabels.waste;
              const title = day.future
                ? `${dateLabel(day.local_date, locale)} · ${t("heatmap.future")}`
                : t("heatmap.dayTitle", { date: dateLabel(day.local_date, locale), label: modeLabel, duration: formatDuration(value), threshold, percent, status: day.passed ? t("trends.dayPassed") : t("heatmap.notPassed") });
              return (
                <button type="button"
                  key={day.local_date}
                  className={`heat-cell level-${day.future ? 0 : level} ${day.local_date === todayDate ? "is-today" : ""} ${day.future ? "is-future" : ""}`}
                  aria-label={title}
                  aria-pressed={day.local_date === selectedDate}
                  disabled={day.future}
                  onPointerEnter={() => setActiveDate(day.local_date)}
                  onFocus={() => setActiveDate(day.local_date)}
                  onBlur={() => setActiveDate("")}
                  onClick={() => onDateSelect(day.local_date)}
                >
                  {day.passed && <i className="pass-dot" aria-label={t("score.passed")} />}
                </button>
              );
            })}
          </div>
        </div>
      </div>
      <div className="heatmap-readout">
        {activeDay && (
          <>
            <strong>{dateLabel(activeDay.local_date, locale)}</strong>
            {activeDay.future ? (
              <span>{t("heatmap.futureTitle")}</span>
            ) : (
              <>
                <span className={`kind-${mode}`}>
                  {mode === "useful" ? kindLabels.useful : kindLabels.waste}: {formatDuration(mode === "useful" ? activeDay.useful_ms : activeDay.waste_ms)} / {mode === "useful" ? activeDay.useful_goal_min : activeDay.waste_limit_min}{t("common.minutesShort")}
                </span>
                <span>{t("heatmap.ofThreshold", { percent: thresholdPercent(
                  mode === "useful" ? activeDay.useful_ms : activeDay.waste_ms,
                  mode === "useful" ? activeDay.useful_goal_min : activeDay.waste_limit_min,
                ) })}</span>
                <b className={activeDay.passed ? "is-passed" : ""}>{activeDay.passed ? t("score.passed") : t("heatmap.notPassedTitle")}</b>
              </>
            )}
          </>
        )}
      </div>
      <div className="heatmap-legend"><span>0</span>{[1, 2, 3, 4].map((level) => <i key={level} className={`heat-cell level-${level}`} />)}<span>{t("heatmap.legendThreshold")}</span><b><i className="pass-dot" /> {t("heatmap.legendPassed")}</b></div>
    </section>
  );
}
