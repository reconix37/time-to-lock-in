import { useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

// Скрытые WebView не должны бесконечно запрашивать и перерисовывать данные.
// Следующий запрос запускается только после завершения предыдущего.
export function useVisiblePolling(refresh: () => Promise<unknown> | void, delay: number) {
  useEffect(() => {
    let disposed = false;
    let running = false;
    let visible = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stops: (() => void)[] = [];
    const currentWindow = getCurrentWindow();
    const tick = async () => {
      if (disposed || running || !visible) return;
      running = true;
      try { await refresh(); } finally {
        running = false;
        if (!disposed && visible) timer = setTimeout(() => void tick(), delay);
      }
    };
    const changed = (next: boolean) => {
      visible = next;
      clearTimeout(timer);
      if (visible) void tick();
    };
    const inspect = async () => {
      const [shown, minimized] = await Promise.all([currentWindow.isVisible(), currentWindow.isMinimized()]);
      if (!disposed) changed(shown && !minimized);
    };
    const subscribe = async () => {
      for (const subscription of [
        currentWindow.listen<boolean>("ui://visibility", event => changed(event.payload)),
        currentWindow.onResized(() => void inspect()),
        currentWindow.onFocusChanged(() => void inspect()),
      ]) {
        const stop = await subscription;
        if (disposed) stop(); else stops.push(stop);
      }
      await inspect();
    };
    void subscribe().catch(() => { /* Закрывающееся окно больше не опрашиваем. */ });
    return () => {
      disposed = true;
      clearTimeout(timer);
      stops.forEach(stop => stop());
    };
  }, [refresh, delay]);
}
