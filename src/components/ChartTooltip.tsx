import { useLayoutEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";

interface ChartTooltipProps {
  x: number;
  y: number;
  visible: boolean;
  children: ReactNode;
}

const CURSOR_OFFSET = 12;
const VIEWPORT_MARGIN = 8;

export function ChartTooltip({ x, y, visible, children }: ChartTooltipProps) {
  const tooltipRef = useRef<HTMLDivElement>(null);

  // Позицию пишем напрямую в style узла — движение курсора не вызывает ре-рендер React
  // (при прежнем подходе setPosition на каждый mousemove ронял производительность кросхэйра).
  useLayoutEffect(() => {
    const tooltip = tooltipRef.current;
    if (tooltip === null) return;

    const left = x + CURSOR_OFFSET + tooltip.offsetWidth <= window.innerWidth - VIEWPORT_MARGIN
      ? x + CURSOR_OFFSET
      : Math.max(VIEWPORT_MARGIN, x - CURSOR_OFFSET - tooltip.offsetWidth);
    const top = y + CURSOR_OFFSET + tooltip.offsetHeight <= window.innerHeight - VIEWPORT_MARGIN
      ? y + CURSOR_OFFSET
      : Math.max(VIEWPORT_MARGIN, y - CURSOR_OFFSET - tooltip.offsetHeight);

    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${top}px`;
  }, [x, y, visible, children]);

  if (!visible || typeof document === "undefined") return null;

  return createPortal(
    <div
      ref={tooltipRef}
      className="chart-tooltip chart-tooltip-floating"
      style={{ left: x, top: y }}
      aria-hidden="true"
    >
      {children}
    </div>,
    document.body,
  );
}