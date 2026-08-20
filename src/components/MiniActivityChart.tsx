import { useI18n } from "../i18nContext";
import type { TodayCumulative } from "./CumulativeChart";

interface MiniActivityChartProps {
  data: TodayCumulative | null;
}

const W = 200;
const H = 66;
const L = 2;
const R = 2;
const T = 4;
const B = 10;

function pointHour(hour: number, timestampMs: number, isCurrent: boolean): number {
  if (!isCurrent) return hour;
  const date = new Date(timestampMs);
  return date.getHours() + date.getMinutes() / 60 + date.getSeconds() / 3600;
}

// Компактная внутридневная кривая «Полезное/Впустую» для мини-виджета (блок chart).
export function MiniActivityChart({ data }: MiniActivityChartProps) {
  const { t } = useI18n();
  if (data === null || data.points.length === 0) {
    return <div className="mini-chart-empty" aria-label={t("mini.noData")}>{t("mini.noData")}</div>;
  }
  const currentPoint = data.points.find((point) => point.is_current);
  const visible = data.points.filter((point) =>
    point.is_current || currentPoint === undefined || point.timestamp_ms <= currentPoint.timestamp_ms,
  );
  const yMax = Math.max(60_000, ...visible.flatMap((point) => [point.useful_ms, point.waste_ms]));
  const x = (point: { hour: number; timestamp_ms: number; is_current: boolean }) =>
    L + (pointHour(point.hour, point.timestamp_ms, point.is_current) / 24) * (W - L - R);
  const y = (value: number) => T + (1 - value / yMax) * (H - T - B);
  const path = (key: "useful_ms" | "waste_ms") => visible
    .map((point, index) => `${index === 0 ? "M" : "L"} ${x(point).toFixed(1)} ${y(point[key]).toFixed(1)}`)
    .join(" ");
  return (
    <svg className="mini-chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={t("mini.chartAria")}>
      <path className="cumulative-line kind-useful" d={path("useful_ms")} />
      <path className="cumulative-line kind-waste" d={path("waste_ms")} />
    </svg>
  );
}
