import { useCallback, useEffect, useRef } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emitTo } from "@tauri-apps/api/event";

type Drag = { pointerId: number; startX: number; startY: number; originX: number; originY: number; scale: number; moving: boolean };

export function useMiniRightDrag() {
  const drag = useRef<Drag | null>(null);
  const pending = useRef(false);
  const activePointer = useRef<number | null>(null);

  const onPointerDownCapture = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 2 || drag.current || pending.current) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const pointerId = event.pointerId;
    const startX = event.screenX;
    const startY = event.screenY;
    activePointer.current = pointerId;
    pending.current = true;
    void invoke<[number, number, number]>("begin_mini_right_drag").then(([originX, originY, scale]) => {
      if (activePointer.current !== pointerId) return;
      drag.current = { pointerId, startX, startY, originX, originY, scale, moving: false };
      void emitTo("mini", "mini://refresh");
      void emitTo("mini-brow", "mini://refresh");
    }).finally(() => { pending.current = false; });
  }, []);

  const onPointerMoveCapture = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    const dx = event.screenX - current.startX;
    const dy = event.screenY - current.startY;
    if (!current.moving && Math.hypot(dx, dy) < 3) return;
    current.moving = true;
    void invoke("move_mini_right_drag", {
      x: Math.round(current.originX + dx * current.scale),
      y: Math.round(current.originY + dy * current.scale),
    });
  }, []);

  const onPointerUpCapture = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    if (drag.current?.pointerId === event.pointerId) drag.current = null;
    if (activePointer.current === event.pointerId) activePointer.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }, []);

  useEffect(() => {
    const clear = () => { drag.current = null; activePointer.current = null; };
    window.addEventListener("blur", clear);
    return () => window.removeEventListener("blur", clear);
  }, []);

  return { onPointerDownCapture, onPointerMoveCapture, onPointerUpCapture, onPointerCancelCapture: onPointerUpCapture };
}
