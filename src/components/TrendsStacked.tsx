import { useState } from "react";
import { formatLocalDate, type DailySeriesDay } from "../trends";
import type { KindLabels } from "../share";
import { ChartTooltip } from "./ChartTooltip";
import { useI18n } from "../i18nContext";

interface TrendsStackedProps {
  days: DailySeriesDay[];
  range: 7 | 30;
  onRangeChange: (range: 7 | 30) => void;
  formatDuration: (milliseconds: number) => string;
  kindLabels: KindLabels;
}

const WIDTH = 1000;
const HEIGHT = 320;
const LEFT = 58;
const RIGHT = 18;
const TOP = 18;
const BOTTOM = 46;
const PLOT_WIDTH = WIDTH - LEFT - RIGHT;
const PLOT_HEIGHT = HEIGHT - TOP - BOTTOM;

export function TrendsStacked({ days, range, onRangeChange, formatDuration, kindLabels }: TrendsStackedProps) {
  const { lang, t } = useI18n();
  const visibleDays = days.slice(-range);
  const latestDay = visibleDays[visibleDays.length - 1];
  const [activeDate, setActiveDate] = useState(latestDay?.local_date ?? "");
  const [tooltip, setTooltip] = useState({ x: 0, y: 0, visible: false });
  const activeDay = visibleDays.find((day) => day.local_date === activeDate) ?? latestDay;
  const largestValue = Math.max(
    60 * 60_000,
    ...visibleDays.map((day) => Math.max(day.observed_ms, day.useful_goal_min * 60_000)),
  );
  const yMax = Math.ceil(largestValue / 3_600_000) * 3_600_000;
  const y = (value: number) => TOP + (1 - value / yMax) * PLOT_HEIGHT;
  const slotWidth = PLOT_WIDTH / Math.max(visibleDays.length, 1);
  const barWidth = Math.min(range === 7 ? 72 : 20, slotWidth * 0.68);
  const x = (index: number) => LEFT + slotWidth * index + slotWidth / 2;
  const yTicks = [0, yMax / 2, yMax];
  const usefulGoalLabel = t("trends.goalLabel", { label: kindLabels.useful });

  return (
    <section className="card trends-card" aria-labelledby="stacked-title">
      <div className="card-heading trends-heading">
        <div><span className="eyebrow">{t("trends.compositionEyebrow")}</span><h2 id="stacked-title">{t("trends.compositionTitle")}</h2></div>
        <div className="segmented-control" aria-label={t("trends.period")}>
          {([7, 30] as const).map((option) => (
            <button
              type="button"
              key={option}
              aria-pressed={range === option}
              onClick={() => onRangeChange(option)}
            >
              {t("common.days", { count: option })}
            </button>
          ))}
        </div>
      </div>

      <div className="trends-legend" aria-label={t("chart.legend")}>
        <span className="kind-useful"><i />{kindLabels.useful}</span>
        <span className="kind-neutral"><i />{kindLabels.neutral}</span>
        <span className="kind-waste"><i />{kindLabels.waste}</span>
      </div>

      <div
        className={`trends-plot ${range === 30 ? "is-dense" : ""}`}
        onMouseLeave={() => setTooltip((current) => ({ ...current, visible: false }))}
        onScroll={() => setTooltip((current) => ({ ...current, visible: false }))}
      >
        <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img" aria-label={t("trends.compositionAria", { days: range })}>
          {yTicks.map((tick) => (
            <g className="trends-grid-tick" key={tick}>
              <line x1={LEFT} x2={WIDTH - RIGHT} y1={y(tick)} y2={y(tick)} />
              <text x={LEFT - 9} y={y(tick) + 4}>{formatDuration(tick)}</text>
            </g>
          ))}
          {visibleDays.map((day, index) => {
            const usefulTop = y(day.useful_ms);
            const neutralTop = y(day.useful_ms + day.neutral_ms);
            const totalTop = y(day.observed_ms);
            const bottom = y(0);
            const showLabel = range === 7 || index % 5 === 0 || index === visibleDays.length - 1;
            const tooltip = [
              formatLocalDate(day.local_date, { weekday: "long", day: "numeric", month: "long" }, lang),
              `${kindLabels.useful}: ${formatDuration(day.useful_ms)}`,
              `${kindLabels.neutral}: ${formatDuration(day.neutral_ms)}`,
              t("trends.limitTooltip", { label: kindLabels.waste, duration: formatDuration(day.waste_ms), limit: day.waste_limit_min }),
              t("trends.accountedTooltip", { duration: formatDuration(day.observed_ms) }),
              `${usefulGoalLabel}: ${day.useful_goal_min}${t("common.minutesShort")}`,
              t("trends.statusTooltip", { status: day.passed ? t("trends.dayPassed") : t("trends.dayNotPassed") }),
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
                <rect className="trends-hit-area" x={x(index) - slotWidth / 2} y={TOP} width={slotWidth} height={PLOT_HEIGHT} />
                <rect className="trend-stack kind-useful" x={x(index) - barWidth / 2} y={usefulTop} width={barWidth} height={bottom - usefulTop} />
                <rect className="trend-stack kind-neutral" x={x(index) - barWidth / 2} y={neutralTop} width={barWidth} height={usefulTop - neutralTop} />
                <rect className="trend-stack kind-waste" x={x(index) - barWidth / 2} y={totalTop} width={barWidth} height={neutralTop - totalTop} />
                {showLabel && (
                  <text className="trends-x-label" x={x(index)} y={HEIGHT - 18}>
                    {formatLocalDate(day.local_date, range === 7 ? { weekday: "short" } : { day: "2-digit", month: "2-digit" }, lang)}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
      </div>

      {activeDay && (
        <ChartTooltip {...tooltip}>
          <strong>{formatLocalDate(activeDay.local_date, { weekday: "short", day: "numeric", month: "short" }, lang)}</strong>
          <span className="kind-useful">{kindLabels.useful} {formatDuration(activeDay.useful_ms)}</span>
          <span className="kind-neutral">{kindLabels.neutral} {formatDuration(activeDay.neutral_ms)}</span>
          <span className="kind-waste">{kindLabels.waste} {formatDuration(activeDay.waste_ms)} / {activeDay.waste_limit_min}{t("common.minutesShort")}</span>
          <span>{t("common.goal")} {activeDay.useful_goal_min}{t("common.minutesShort")} · XP +{activeDay.useful_xp}</span>
          <b className={activeDay.passed ? "is-passed" : ""}>{activeDay.passed ? t("trends.passedShort") : t("trends.notPassedShort")}</b>
        </ChartTooltip>
      )}
    </section>
  );
}
