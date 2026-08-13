import { useState } from "react";
import { formatLocalDate, type DailySeriesDay } from "../trends";
import type { KindLabels } from "../share";
import { ChartTooltip } from "./ChartTooltip";
import { useI18n } from "../i18nContext";

interface TrendsTrendProps {
  sourceDays: DailySeriesDay[];
  formatDuration: (milliseconds: number) => string;
  kindLabels: KindLabels;
}

const WIDTH = 1000;
const HEIGHT = 300;
const LEFT = 58;
const RIGHT = 18;
const TOP = 18;
const BOTTOM = 46;
const PLOT_WIDTH = WIDTH - LEFT - RIGHT;
const PLOT_HEIGHT = HEIGHT - TOP - BOTTOM;

function smoothPath(points: Array<[number, number]>): string {
  if (points.length === 0) return "";
  if (points.length === 1) return `M ${points[0][0]} ${points[0][1]}`;
  return points.slice(1).reduce((path, point, index) => {
    const previous = points[index];
    const midpoint = (previous[0] + point[0]) / 2;
    return `${path} C ${midpoint} ${previous[1]}, ${midpoint} ${point[1]}, ${point[0]} ${point[1]}`;
  }, `M ${points[0][0]} ${points[0][1]}`);
}

export function TrendsTrend({ sourceDays, formatDuration, kindLabels }: TrendsTrendProps) {
  const { lang, t } = useI18n();
  const days = sourceDays.slice(-30);
  const latestDay = days[days.length - 1];
  const [activeDate, setActiveDate] = useState(latestDay?.local_date ?? "");
  const [tooltip, setTooltip] = useState({ x: 0, y: 0, visible: false });
  const activeDay = days.find((day) => day.local_date === activeDate) ?? latestDay;
  const largestValue = Math.max(
    60 * 60_000,
    ...days.flatMap((day) => [day.useful_ms, day.useful_ma_7d_ms]),
  );
  const yMax = Math.ceil(largestValue / 3_600_000) * 3_600_000;
  const y = (value: number) => TOP + (1 - value / yMax) * PLOT_HEIGHT;
  const slotWidth = PLOT_WIDTH / Math.max(days.length, 1);
  const x = (index: number) => LEFT + slotWidth * index + slotWidth / 2;
  const averagePath = smoothPath(days.map((day, index) => [x(index), y(day.useful_ma_7d_ms)]));
  const yTicks = [0, yMax / 2, yMax];
  const trendTitle = t("trends.customTrend", { label: kindLabels.useful });

  return (
    <section className="card trends-card" aria-labelledby="useful-trend-title">
      <div className="card-heading trends-heading">
        <div><span className="eyebrow">{t("trends.direction")}</span><h2 id="useful-trend-title">{trendTitle}</h2></div>
        <span className="mono-meta">{t("trends.fullWindow")}</span>
      </div>
      <div className="trends-legend" aria-label={t("chart.legend")}>
        <span className="kind-useful"><i />{t("trends.perDay", { label: kindLabels.useful })}</span>
        <span className="is-average"><i />{t("trends.average")}</span>
      </div>

      <div
        className="trends-plot is-dense"
        onMouseLeave={() => setTooltip((current) => ({ ...current, visible: false }))}
        onScroll={() => setTooltip((current) => ({ ...current, visible: false }))}
      >
        <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img" aria-label={t("trends.averageAria", { label: kindLabels.useful })}>
          {yTicks.map((tick) => (
            <g className="trends-grid-tick" key={tick}>
              <line x1={LEFT} x2={WIDTH - RIGHT} y1={y(tick)} y2={y(tick)} />
              <text x={LEFT - 9} y={y(tick) + 4}>{formatDuration(tick)}</text>
            </g>
          ))}
          {days.map((day, index) => {
            const showLabel = index % 5 === 0 || index === days.length - 1;
            const tooltip = [
              formatLocalDate(day.local_date, { weekday: "long", day: "numeric", month: "long" }, lang),
              `${kindLabels.useful}: ${formatDuration(day.useful_ms)}`,
              t("trends.averageTooltip", { duration: formatDuration(day.useful_ma_7d_ms) }),
              t("trends.goalTooltip", { goal: day.useful_goal_min }),
              `${t("common.publicXp")}: +${day.useful_xp}`,
            ].join("\n");
            return (
              <g
                className={`trends-day ${activeDay?.local_date === day.local_date ? "is-active" : ""}`}
                key={day.local_date}
                role="button"
                tabIndex={0}
                aria-label={tooltip.split("\n").join(". ")}
                onFocus={() => setActiveDate(day.local_date)}
                onMouseEnter={() => setActiveDate(day.local_date)}
                onMouseMove={(event) => setTooltip({ x: event.clientX, y: event.clientY, visible: true })}
                onClick={() => setActiveDate(day.local_date)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") setActiveDate(day.local_date);
                }}
              >
                <rect className="trends-hit-area" x={LEFT + slotWidth * index} y={TOP} width={slotWidth} height={PLOT_HEIGHT} />
                <rect
                  className="trend-useful-bar"
                  x={x(index) - Math.min(17, slotWidth * 0.55) / 2}
                  y={y(day.useful_ms)}
                  width={Math.min(17, slotWidth * 0.55)}
                  height={y(0) - y(day.useful_ms)}
                />
                {showLabel && <text className="trends-x-label" x={x(index)} y={HEIGHT - 18}>{formatLocalDate(day.local_date, { day: "2-digit", month: "2-digit" }, lang)}</text>}
              </g>
            );
          })}
          <path className="trend-average-line" d={averagePath} />
          {days.map((day, index) => (
            <circle className="trend-average-point" key={day.local_date} cx={x(index)} cy={y(day.useful_ma_7d_ms)} r={activeDay?.local_date === day.local_date ? 4 : 2} />
          ))}
        </svg>
      </div>

      {activeDay && (
        <ChartTooltip {...tooltip}>
          <strong>{formatLocalDate(activeDay.local_date, { weekday: "short", day: "numeric", month: "short" }, lang)}</strong>
          <span className="kind-useful">{kindLabels.useful} {formatDuration(activeDay.useful_ms)}</span>
          <span className="is-average">MA7 {formatDuration(activeDay.useful_ma_7d_ms)}</span>
          <span>{t("common.goal")} {activeDay.useful_goal_min}{t("common.minutesShort")} · XP +{activeDay.useful_xp}</span>
        </ChartTooltip>
      )}
    </section>
  );
}
