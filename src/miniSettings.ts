export type MiniMode = "auto" | "compact" | "detailed";
export type MiniTextSize = "normal" | "large";
export type MiniBlockId = "score" | "categories" | "verdict" | "current" | "chart";

export interface MiniBlockCfg {
  id: MiniBlockId;
  enabled: boolean;
  size: 1 | 2;
}

export interface MiniLayout {
  version: 1;
  blocks: MiniBlockCfg[];
}

export const MINI_BLOCK_IDS: MiniBlockId[] = ["score", "categories", "verdict", "current", "chart"];

export function defaultMiniLayout(): MiniLayout {
  return {
    version: 1,
    blocks: [
      { id: "score", enabled: true, size: 2 },
      { id: "categories", enabled: true, size: 2 },
      { id: "verdict", enabled: true, size: 2 },
      { id: "current", enabled: true, size: 2 },
      { id: "chart", enabled: false, size: 2 },
    ],
  };
}

// Пресеты: «Подробно» включает график, «Компактно» — нет; размеры/порядок сохраняются.
export function applyMiniPreset(base: MiniLayout, preset: "compact" | "detailed"): MiniLayout {
  const order = preset === "detailed"
    ? [...MINI_BLOCK_IDS]
    : MINI_BLOCK_IDS.filter((id) => id !== "chart");
  return {
    version: 1,
    blocks: [...order, ...MINI_BLOCK_IDS.filter((id) => !order.includes(id))].map((id) => {
      const existing = base.blocks.find((block) => block.id === id);
      return {
        id,
        enabled: preset === "detailed" || id !== "chart",
        size: existing?.size ?? 2,
      };
    }),
  };
}

export function parseMiniLayout(json: string | undefined): MiniLayout {
  if (json !== undefined && json !== "") {
    try {
      const parsed: unknown = JSON.parse(json);
      if (parsed !== null && typeof parsed === "object"
        && (parsed as { version?: unknown }).version === 1
        && Array.isArray((parsed as { blocks?: unknown }).blocks)) {
        const seen = new Set<MiniBlockId>();
        const blocks: MiniBlockCfg[] = [];
        for (const raw of (parsed as { blocks: unknown[] }).blocks) {
          const block = raw as Partial<MiniBlockCfg>;
          if (block !== null && typeof block === "object"
            && MINI_BLOCK_IDS.includes(block.id as MiniBlockId)
            && !seen.has(block.id as MiniBlockId)) {
            seen.add(block.id as MiniBlockId);
            blocks.push({ id: block.id as MiniBlockId, enabled: block.enabled !== false, size: block.size === 1 ? 1 : 2 });
          }
        }
        if (blocks.length > 0) {
          for (const id of MINI_BLOCK_IDS) {
            if (!seen.has(id)) blocks.push({ id, enabled: id === "chart" ? false : true, size: 2 });
          }
          return { version: 1, blocks };
        }
      }
    } catch {
      // некорректный JSON — откат на дефолт
    }
  }
  return defaultMiniLayout();
}

export function serializeMiniLayout(layout: MiniLayout): string {
  return JSON.stringify({ version: 1, blocks: layout.blocks.map(({ id, enabled, size }) => ({ id, enabled, size })) });
}

export interface MiniSettings {
  mode: MiniMode;
  textSize: MiniTextSize;
  privacyNow: boolean;
  showAtLaunch: boolean;
  opacity: number;
  cornerPinned: boolean;
  clickThrough: boolean;
  cornerTuck: boolean;
  layout: MiniLayout;
}

export function parseMiniSettings(settings: Record<string, string>): MiniSettings {
  const opacity = Number(settings.mini_opacity);
  return {
    mode: settings.mini_mode === "compact" || settings.mini_mode === "detailed"
      ? settings.mini_mode
      : "auto",
    textSize: settings.mini_text_size === "large" ? "large" : "normal",
    privacyNow: settings.mini_privacy_now === "1",
    showAtLaunch: settings.tray_only === "0",
    opacity: Number.isInteger(opacity) && opacity >= 60 && opacity <= 100 ? opacity : 100,
    cornerPinned: settings.mini_corner === "tl"
      || settings.mini_corner === "tr"
      || settings.mini_corner === "bl"
      || settings.mini_corner === "br",
    clickThrough: settings.mini_click_through === "1",
    cornerTuck: settings.mini_corner_tuck === "1",
    layout: parseMiniLayout(settings.mini_layout),
  };
}
