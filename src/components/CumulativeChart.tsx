import { useLayoutEffect, useRef, useState, type ReactNode, type MouseEvent as ReactMouseEvent } from "react";
import type { KindLabels } from "../share";
import { ChartTooltip } from "./ChartTooltip";
import { localeForLang } from "../i18n";
import { useI18n } from "../i18nContext";

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
  fullDay?: boolean;
  /** Доп. контент под сводкой — наполняет карточку (Today переносит категории дня сюда). */
  footer?: ReactNode;
}

// Поля графика (внутренние отступы). Плотные — чтобы кривая заполняла карточку.
const LEFT = 44;
const RIGHT = 12;
const TOP = 14;
const BOTTOM = 26;

// Запасное вьюбокс на первый кадр, пока ResizeObserver не прислал реальный размер контейнера.
const FALLBACK_WIDTH = 880;
const FALLBACK_HEIGHT = 260;

// Часовые деления для белых «палок» на оси X (каждые 2 часа)
const X_GRID_HOURS = Array.from({ length: 13 }, (_, index) => index * 2);
const X_LABEL_HOURS = [0, 6, 12, 18, 24];

function pointHour(point: CumulativePoint): number {
  if (!point.is_current) return point.hour;
  const date = new Date(point.timestamp_ms);
  return date.getHours() + date.getMinutes() / 60 + date.getSeconds() / 3600;
}

export function CumulativeChart({ data, formatDuration, kindLabels, fullDay = false, footer }: CumulativeChartProps) {
  const { lang, t } = useI18n();
  const plotRef = useRef<HTMLDivElement>(null);
  // Размер «вьюпорта» = фактический размер контейнера (px). График заполняет карточку целиком,
  // без пустых полей по бокам (прежний фикс. viewBox центрировался и оставлял letterboxing).
  const [box, setBox] = useState({ w: FALLBACK_WIDTH, h: FALLBACK_HEIGHT });

  const crosshairRef = useRef<SVGLineElement>(null);
  const activeKeyRef = useRef<number | undefined>(undefined);

  useLayoutEffect(() => {
    const el = plotRef.current;
    if (el === null) return;
    const apply = () => setBox({ w: el.clientWidth, h: el.clientHeight });
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const [activePoint, setActivePoint] = useState<CumulativePoint>();
  const [tooltip, setTooltip] = useState({ x: 0, y: 0, visible: false });
  const [pinnedPoint, setPinnedPoint] = useState<CumulativePoint | undefined>(undefined);
  const currentPoint = fullDay ? undefined : data.points.find((point) => point.is_current);
  const dayPoints = fullDay ? data.points.filter((point) => !point.is_current) : data.points;
  const visiblePoints = fullDay
    ? dayPoints
    : data.points.filter((point) =>
        point.is_current || currentPoint === undefined || point.timestamp_ms <= currentPoint.timestamp_ms,
      );
  const headlinePoint = currentPoint ?? (dayPoints.length > 0 ? dayPoints[dayPoints.length - 1] : undefined);
  const usefulGoalMs = data.useful_goal_min * 60_000;
  const wasteLimitMs = data.waste_limit_min * 60_000;
  const largestValue = Math.max(
    usefulGoalMs,
    wasteLimitMs,
    ...visiblePoints.flatMap((point) => [point.useful_ms, point.waste_ms]),
    60_000,
  );
  const yMax = largestValue * 1.05;
  const W = box.w;
  const H = box.h;
  const PLOT_WIDTH = W - LEFT - RIGHT;
  const PLOT_HEIGHT = H - TOP - BOTTOM;
  const x = (point: CumulativePoint) => LEFT + pointHour(point) / 24 * PLOT_WIDTH;
  const y = (value: number) => TOP + (1 - value / yMax) * PLOT_HEIGHT;
  // На текущем дне кривую не тянем к current_point по пустому плато: если между концом
  // последнего сегмента и «сейчас» нет деятельности, часовые точки дают одинаковые значения
  // и строят горизонтальный хвост от максимума к current. Обрезаем повторяющиеся концевые
  // точки (лесенка-плато внутри дня и прошлые дни не трогаем — только tail текущего дня).
  const trimTrailingFlat = (key: "useful_ms" | "waste_ms") => {
    const list = [...visiblePoints];
    while (list.length > 1 && list[list.length - 1][key] === list[list.length - 2][key]) list.pop();
    return list;
  };
  const path = (key: "useful_ms" | "waste_ms") => (fullDay ? visiblePoints : trimTrailingFlat(key))
    .map((point, index) => `${index === 0 ? "M" : "L"} ${x(point).toFixed(2)} ${y(point[key]).toFixed(2)}`)
    .join(" ");
  const yTicks = [yMax * 0.25, yMax * 0.5, yMax * 0.75];

  const handleMouseMove = (event: ReactMouseEvent<SVGRectElement>) => {
    const svg = event.currentTarget.ownerSVGElement;
    if (svg === null || visiblePoints.length === 0) return;

    const bounds = svg.getBoundingClientRect();
    const svgX = (event.clientX - bounds.left) / bounds.width * W;
    // кросхейр следует строго за мышью, не прыгая по точкам (зажат в границы графика).
    // Пишем напрямую в DOM через ref — никаких ре-рендеров React на каждый кадр.
    const line = crosshairRef.current;
    if (line !== null) {
      const clamped = Math.min(Math.max(svgX, LEFT), W - RIGHT);
      line.setAttribute("x1", String(clamped));
      line.setAttribute("x2", String(clamped));
      line.style.display = "";
    }

    // Активную точку и тултип обновляем ТОЛЬКО при смене точки (не на каждом mousemove).
    const nearestPoint = visiblePoints.reduce((nearest, point) =>
      Math.abs(x(point) - svgX) < Math.abs(x(nearest) - svgX) ? point : nearest,
    );
    if (activeKeyRef.current !== nearestPoint.timestamp_ms) {
      activeKeyRef.current = nearestPoint.timestamp_ms;
      setActivePoint(nearestPoint);
      setTooltip({ x: event.clientX, y: event.clientY, visible: true });
    }
  };

  const handleMouseLeave = () => {
    const line = crosshairRef.current;
    if (line !== null) line.style.display = "none";
    setTooltip((current) => ({ ...current, visible: false }));
  };

  const handleClick = () => {
    // клик закрепляет метку времени; повторный клик по той же точке снимает её
    setPinnedPoint((current) => (current === activePoint || activePoint === undefined ? undefined : activePoint));
  };

  const hourLabel = (point: CumulativePoint) =>
    new Intl.DateTimeFormat(localeForLang(lang), { hour: "2-digit", minute: "2-digit" }).format(point.timestamp_ms);

  return (
    <section className="card cumulative-card" aria-labelledby="cumulative-title">
      <div className="card-heading cumulative-heading">
        <div><span className="eyebrow">{t("chart.cumulativeEyebrow")}</span><h2 id="cumulative-title">{t("chart.cumulativeTitle")}</h2></div>
        <div className="cumulative-legend" aria-label={t("chart.legend")}>
          <span className="kind-useful"><i />{kindLabels.useful}</span>
          <span className="kind-waste"><i />{kindLabels.waste}</span>
        </div>
      </div>
      <div
        className="cumulative-plot"
        ref={plotRef}
        onMouseLeave={handleMouseLeave}
        onScroll={() => setTooltip((current) => ({ ...current, visible: false }))}
      >
        <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={t("chart.cumulativeLabel", { usefulLabel: kindLabels.useful, useful: formatDuration(headlinePoint?.useful_ms ?? 0), wasteLabel: kindLabels.waste, waste: formatDuration(headlinePoint?.waste_ms ?? 0) })}>
          {yTicks.map((tick) => (
            <g className="cumulative-y-tick" key={tick}>
              <line x1={LEFT} x2={W - RIGHT} y1={y(tick)} y2={y(tick)} />
              <text x={LEFT - 8} y={y(tick) + 4}>{formatDuration(tick)}</text>
            </g>
          ))}
          {X_GRID_HOURS.map((hour) => (
            <line
              key={hour}
              className="cumulative-x-grid"
              x1={LEFT + hour / 24 * PLOT_WIDTH}
              x2={LEFT + hour / 24 * PLOT_WIDTH}
              y1={TOP}
              y2={H - BOTTOM}
            />
          ))}
          {X_LABEL_HOURS.map((hour) => (
            <text key={hour} className="cumulative-x-label" x={LEFT + hour / 24 * PLOT_WIDTH} y={H - 8}>{String(hour).padStart(2, "0")}</text>
          ))}
          <path className="cumulative-line kind-useful" d={path("useful_ms")} />
          <path className="cumulative-line kind-waste" d={path("waste_ms")} />
          {pinnedPoint && (
            <g className="cumulative-pin">
              <line x1={x(pinnedPoint)} x2={x(pinnedPoint)} y1={TOP} y2={H - BOTTOM} />
              <text x={x(pinnedPoint)} y={H - 14}>{hourLabel(pinnedPoint)}</text>
            </g>
          )}
          <g className="cumulative-crosshair">
            <line ref={crosshairRef} y1={TOP} y2={H - BOTTOM} />
          </g>
          <rect
            className="chart-hit-area"
            x={LEFT}
            y={TOP}
            width={PLOT_WIDTH}
            height={PLOT_HEIGHT}
            onMouseMove={handleMouseMove}
            onClick={handleClick}
          />
        </svg>
      </div>
      <ChartTooltip {...tooltip}>
        {activePoint && (
          <>
            <strong>{new Intl.DateTimeFormat(localeForLang(lang), { hour: "2-digit", minute: "2-digit" }).format(activePoint.timestamp_ms)}</strong>
            <span className="kind-useful">{kindLabels.useful}: {formatDuration(activePoint.useful_ms)}</span>
            <span className="kind-waste">{kindLabels.waste}: {formatDuration(activePoint.waste_ms)}</span>
            <span>{t("chart.goalLimitValues", { goal: data.useful_goal_min, limit: data.waste_limit_min })}</span>
          </>
        )}
      </ChartTooltip>
      <div className="cumulative-summary">
        <span className="kind-useful">{kindLabels.useful} <strong>{formatDuration(headlinePoint?.useful_ms ?? 0)}</strong> · {t("chart.goalValue", { goal: data.useful_goal_min })}</span>
        <span className="kind-waste">{kindLabels.waste} <strong>{formatDuration(headlinePoint?.waste_ms ?? 0)}</strong> · {t("chart.limitValue", { limit: data.waste_limit_min })}</span>
      </div>
      {footer}
    </section>
  );
}