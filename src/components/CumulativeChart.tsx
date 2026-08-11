import { useState, type MouseEvent as ReactMouseEvent } from "react";
import type { KindLabels } from "../share";
import { ChartTooltip } from "./ChartTooltip";

export interface CumulativePoint {
  timestamp_ms: number;
  hour: number;
  useful_ms: number;
  waste_ms: number;
  is_current: boolean;
}

export interface TodayCumulative {
  points: CumulativePoint[];
  useful_goal_min: number;
  waste_limit_min: number;
}

interface CumulativeChartProps {
  data: TodayCumulative;
  formatDuration: (milliseconds: number) => string;
  kindLabels: KindLabels;
}

const WIDTH = 760;
const HEIGHT = 260;
const LEFT = 52;
const RIGHT = 18;
const TOP = 24;
const BOTTOM = 34;
const PLOT_WIDTH = WIDTH - LEFT - RIGHT;
const PLOT_HEIGHT = HEIGHT - TOP - BOTTOM;

function pointHour(point: CumulativePoint): number {
  if (!point.is_current) return point.hour;
  const date = new Date(point.timestamp_ms);
  return date.getHours() + date.getMinutes() / 60 + date.getSeconds() / 3600;
}

export function CumulativeChart({ data, formatDuration, kindLabels }: CumulativeChartProps) {
  const [activePoint, setActivePoint] = useState<CumulativePoint>();
  const [tooltip, setTooltip] = useState({ x: 0, y: 0, visible: false });
  const currentPoint = data.points.find((point) => point.is_current);
  const visiblePoints = data.points.filter((point) =>
    point.is_current || currentPoint === undefined || point.timestamp_ms <= currentPoint.timestamp_ms,
  );
  const usefulGoalMs = data.useful_goal_min * 60_000;
  const wasteLimitMs = data.waste_limit_min * 60_000;
  const largestValue = Math.max(
    usefulGoalMs,
    wasteLimitMs,
    ...visiblePoints.flatMap((point) => [point.useful_ms, point.waste_ms]),
    60_000,
  );
  const yMax = largestValue * 1.12;
  const x = (point: CumulativePoint) => LEFT + pointHour(point) / 24 * PLOT_WIDTH;
  const y = (value: number) => TOP + (1 - value / yMax) * PLOT_HEIGHT;
  const path = (key: "useful_ms" | "waste_ms") => visiblePoints
    .map((point, index) => `${index === 0 ? "M" : "L"} ${x(point).toFixed(2)} ${y(point[key]).toFixed(2)}`)
    .join(" ");
  const yTicks = [0, yMax / 2, yMax];
  const handleMouseMove = (event: ReactMouseEvent<SVGRectElement>) => {
    const svg = event.currentTarget.ownerSVGElement;
    if (svg === null || visiblePoints.length === 0) return;

    const bounds = svg.getBoundingClientRect();
    const svgX = (event.clientX - bounds.left) / bounds.width * WIDTH;
    const nearestPoint = visiblePoints.reduce((nearest, point) =>
      Math.abs(x(point) - svgX) < Math.abs(x(nearest) - svgX) ? point : nearest,
    );
    setActivePoint(nearestPoint);
    setTooltip({ x: event.clientX, y: event.clientY, visible: true });
  };

  return (
    <section className="card cumulative-card" aria-labelledby="cumulative-title">
      <div className="card-heading cumulative-heading">
        <div><span className="eyebrow">Сегодня · по часам</span><h2 id="cumulative-title">Как росло время</h2></div>
        <div className="cumulative-legend" aria-label="Легенда графика">
          <span className="kind-useful"><i />{kindLabels.useful}</span>
          <span className="kind-waste"><i />{kindLabels.waste}</span>
          <span className="is-reference"><i />Цель / лимит</span>
        </div>
      </div>
      <div
        className="cumulative-plot"
        onMouseLeave={() => setTooltip((current) => ({ ...current, visible: false }))}
        onScroll={() => setTooltip((current) => ({ ...current, visible: false }))}
      >
        <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img" aria-label={`Накопительно: ${kindLabels.useful} ${formatDuration(currentPoint?.useful_ms ?? 0)}, ${kindLabels.waste} ${formatDuration(currentPoint?.waste_ms ?? 0)}`}>
          {yTicks.map((tick) => (
            <g className="cumulative-y-tick" key={tick}>
              <line x1={LEFT} x2={WIDTH - RIGHT} y1={y(tick)} y2={y(tick)} />
              <text x={LEFT - 8} y={y(tick) + 4}>{formatDuration(tick)}</text>
            </g>
          ))}
          {[0, 6, 12, 18, 24].map((hour) => (
            <g className="cumulative-x-tick" key={hour}>
              <line x1={LEFT + hour / 24 * PLOT_WIDTH} x2={LEFT + hour / 24 * PLOT_WIDTH} y1={TOP} y2={HEIGHT - BOTTOM} />
              <text x={LEFT + hour / 24 * PLOT_WIDTH} y={HEIGHT - 10}>{String(hour).padStart(2, "0")}</text>
            </g>
          ))}
          <line className="cumulative-reference kind-useful" x1={LEFT} x2={WIDTH - RIGHT} y1={y(usefulGoalMs)} y2={y(usefulGoalMs)} />
          <line className="cumulative-reference kind-waste" x1={LEFT} x2={WIDTH - RIGHT} y1={y(wasteLimitMs)} y2={y(wasteLimitMs)} />
          <path className="cumulative-line kind-useful" d={path("useful_ms")} />
          <path className="cumulative-line kind-waste" d={path("waste_ms")} />
          {currentPoint && (
            <>
              <circle className="cumulative-current kind-useful" cx={x(currentPoint)} cy={y(currentPoint.useful_ms)} r="4" />
              <circle className="cumulative-current kind-waste" cx={x(currentPoint)} cy={y(currentPoint.waste_ms)} r="4" />
            </>
          )}
          <rect
            className="chart-hit-area"
            x={LEFT}
            y={TOP}
            width={PLOT_WIDTH}
            height={PLOT_HEIGHT}
            onMouseMove={handleMouseMove}
          />
        </svg>
      </div>
      <ChartTooltip {...tooltip}>
        {activePoint && (
          <>
            <strong>{new Intl.DateTimeFormat("ru-RU", { hour: "2-digit", minute: "2-digit" }).format(activePoint.timestamp_ms)}</strong>
            <span className="kind-useful">{kindLabels.useful}: {formatDuration(activePoint.useful_ms)}</span>
            <span className="kind-waste">{kindLabels.waste}: {formatDuration(activePoint.waste_ms)}</span>
            <span>Цель {data.useful_goal_min}м · Лимит {data.waste_limit_min}м</span>
          </>
        )}
      </ChartTooltip>
      <div className="cumulative-summary">
        <span className="kind-useful">{kindLabels.useful} <strong>{formatDuration(currentPoint?.useful_ms ?? 0)}</strong> · цель {data.useful_goal_min}м</span>
        <span className="kind-waste">{kindLabels.waste} <strong>{formatDuration(currentPoint?.waste_ms ?? 0)}</strong> · лимит {data.waste_limit_min}м</span>
      </div>
    </section>
  );
}
