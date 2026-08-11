import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
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
  const [position, setPosition] = useState({ left: x + CURSOR_OFFSET, top: y + CURSOR_OFFSET });

  useLayoutEffect(() => {
    const tooltip = tooltipRef.current;
    if (!visible || tooltip === null) return;

    const { width, height } = tooltip.getBoundingClientRect();
    const left = x + CURSOR_OFFSET + width <= window.innerWidth - VIEWPORT_MARGIN
      ? x + CURSOR_OFFSET
      : Math.max(VIEWPORT_MARGIN, x - CURSOR_OFFSET - width);
    const top = y + CURSOR_OFFSET + height <= window.innerHeight - VIEWPORT_MARGIN
      ? y + CURSOR_OFFSET
      : Math.max(VIEWPORT_MARGIN, y - CURSOR_OFFSET - height);

    setPosition({ left, top });
  }, [children, visible, x, y]);

  if (!visible || typeof document === "undefined") return null;

  return createPortal(
    <div
      ref={tooltipRef}
      className="chart-tooltip chart-tooltip-floating"
      style={{ left: position.left, top: position.top }}
      aria-hidden="true"
    >
      {children}
    </div>,
    document.body,
  );
}
