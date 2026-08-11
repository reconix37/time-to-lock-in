import { useState } from "react";
import type { ProgressDay } from "../progress";
import type { KindLabels } from "../share";
import { ChartTooltip } from "./ChartTooltip";

interface CalendarHeatmapProps {
  days: ProgressDay[];
  todayDate: string;
  formatDuration: (milliseconds: number) => string;
  kindLabels: KindLabels;
}

type HeatMode = "useful" | "waste";

function dateLabel(localDate: string): string {
  return new Intl.DateTimeFormat("ru-RU", { weekday: "long", day: "numeric", month: "long" })
    .format(new Date(`${localDate}T12:00:00`));
}

function thresholdPercent(value: number, thresholdMinutes: number): number {
  return thresholdMinutes > 0 ? Math.round(value / (thresholdMinutes * 60_000) * 100) : 0;
}

export function CalendarHeatmap({ days, todayDate, formatDuration, kindLabels }: CalendarHeatmapProps) {
  const [mode, setMode] = useState<HeatMode>("useful");
  const [activeDate, setActiveDate] = useState("");
  const [tooltip, setTooltip] = useState({ x: 0, y: 0, visible: false });
  const activeDay = days.find((day) => day.local_date === activeDate);
  const monthLabels = days.filter((_, index) => index % 7 === 0).map((day, index) => ({
    key: day.local_date,
    column: index + 1,
    label: new Intl.DateTimeFormat("ru-RU", { month: "short" }).format(new Date(`${day.local_date}T12:00:00`)),
  })).filter((month, index, labels) => index === 0 || month.label !== labels[index - 1].label);

  return (
    <section className={`card heatmap-card heatmap-mode-${mode}`} aria-labelledby="heatmap-title">
      <div className="card-heading heatmap-heading">
        <div><span className="eyebrow">История · 12 недель</span><h2 id="heatmap-title">Календарь прогресса</h2></div>
        <div className="segmented-control" role="group" aria-label="Показатель календаря">
          <button type="button" aria-pressed={mode === "useful"} onClick={() => setMode("useful")}>{kindLabels.useful}</button>
          <button type="button" aria-pressed={mode === "waste"} onClick={() => setMode("waste")}>{kindLabels.waste}</button>
        </div>
      </div>
      <div
        className="heatmap-scroll"
        onMouseLeave={() => setTooltip((current) => ({ ...current, visible: false }))}
        onScroll={() => setTooltip((current) => ({ ...current, visible: false }))}
      >
        <div className="heatmap-months" aria-hidden="true">
          {monthLabels.map((month) => <span key={month.key} style={{ gridColumn: month.column }}>{month.label}</span>)}
        </div>
        <div className="heatmap-body">
          <div className="heatmap-weekdays" aria-hidden="true">{["пн", "вт", "ср", "чт", "пт", "сб", "вс"].map((day) => <span key={day}>{day}</span>)}</div>
          <div className="heatmap-grid" role="img" aria-label={`Календарь: ${mode === "useful" ? kindLabels.useful : kindLabels.waste}`}>
            {days.map((day) => {
              const value = mode === "useful" ? day.useful_ms : day.waste_ms;
              const level = mode === "useful" ? day.useful_level : day.waste_level;
              const threshold = mode === "useful" ? day.useful_goal_min : day.waste_limit_min;
              const percent = thresholdPercent(value, threshold);
              const modeLabel = mode === "useful" ? kindLabels.useful : kindLabels.waste;
              const title = day.future
                ? `${dateLabel(day.local_date)} · будущий день`
                : `${dateLabel(day.local_date)} · ${modeLabel}: ${formatDuration(value)} из ${threshold}м · ${percent}% · ${day.passed ? "день зачтён" : "не зачтён"}`;
              return (
                <span
                  key={day.local_date}
                  className={`heat-cell level-${day.future ? 0 : level} ${day.local_date === todayDate ? "is-today" : ""} ${day.future ? "is-future" : ""}`}
                  aria-label={title}
                  onMouseMove={(event) => {
                    setActiveDate(day.local_date);
                    setTooltip({ x: event.clientX, y: event.clientY, visible: true });
                  }}
                >
                  {day.passed && <i className="pass-dot" aria-label="День зачтён" />}
                </span>
              );
            })}
          </div>
        </div>
      </div>
      <ChartTooltip {...tooltip}>
        {activeDay && (
          <>
            <strong>{dateLabel(activeDay.local_date)}</strong>
            {activeDay.future ? (
              <span>Будущий день</span>
            ) : (
              <>
                <span className={`kind-${mode}`}>
                  {mode === "useful" ? kindLabels.useful : kindLabels.waste}: {formatDuration(mode === "useful" ? activeDay.useful_ms : activeDay.waste_ms)} из {mode === "useful" ? activeDay.useful_goal_min : activeDay.waste_limit_min}м
                </span>
                <span>{thresholdPercent(
                  mode === "useful" ? activeDay.useful_ms : activeDay.waste_ms,
                  mode === "useful" ? activeDay.useful_goal_min : activeDay.waste_limit_min,
                )}% порога</span>
                <b className={activeDay.passed ? "is-passed" : ""}>{activeDay.passed ? "День зачтён" : "Не зачтён"}</b>
              </>
            )}
          </>
        )}
      </ChartTooltip>
      <div className="heatmap-legend"><span>0</span>{[1, 2, 3, 4].map((level) => <i key={level} className={`heat-cell level-${level}`} />)}<span>≥100% порога</span><b><i className="pass-dot" /> день зачтён</b></div>
    </section>
  );
}
