import { useState } from "react";
import { formatLocalDate, type AfkDay } from "../trends";
import { ChartTooltip } from "./ChartTooltip";

interface AfkStripProps {
  days: AfkDay[];
  formatDuration: (milliseconds: number) => string;
}

export function AfkStrip({ days, formatDuration }: AfkStripProps) {
  const visibleDays = days.slice(-7);
  const latestDay = visibleDays[visibleDays.length - 1];
  const [activeDate, setActiveDate] = useState(latestDay?.local_date ?? "");
  const [tooltip, setTooltip] = useState({ x: 0, y: 0, visible: false });
  const activeDay = visibleDays.find((day) => day.local_date === activeDate) ?? latestDay;
  const maximum = Math.max(...visibleDays.map((day) => day.afk_ms), 1);

  return (
    <section className="card afk-strip-card" aria-labelledby="afk-strip-title">
      <div className="card-heading trends-heading">
        <div><span className="eyebrow">Перерывы</span><h2 id="afk-strip-title">AFK по дням</h2></div>
        <span className="mono-meta">7 дней</span>
      </div>
      <div
        className="afk-strip"
        onMouseLeave={() => setTooltip((current) => ({ ...current, visible: false }))}
      >
        {visibleDays.map((day) => {
          const label = formatLocalDate(day.local_date, { weekday: "short" });
          return (
            <button
              type="button"
              className={activeDay?.local_date === day.local_date ? "is-active" : ""}
              key={day.local_date}
              aria-label={`${label}: AFK ${formatDuration(day.afk_ms)}`}
              onFocus={() => setActiveDate(day.local_date)}
              onMouseEnter={() => setActiveDate(day.local_date)}
              onMouseMove={(event) => setTooltip({ x: event.clientX, y: event.clientY, visible: true })}
            >
              <span className="afk-bar-rail" aria-hidden="true">
                <i style={{ height: `${Math.max(day.afk_ms > 0 ? 5 : 0, day.afk_ms / maximum * 100)}%` }} />
              </span>
              <small>{label}</small>
            </button>
          );
        })}
      </div>
      {activeDay && (
        <ChartTooltip {...tooltip}>
          <strong>{formatLocalDate(activeDay.local_date, { weekday: "short", day: "numeric", month: "short" })}</strong>
          <span className="is-afk">AFK {formatDuration(activeDay.afk_ms)}</span>
        </ChartTooltip>
      )}
    </section>
  );
}
