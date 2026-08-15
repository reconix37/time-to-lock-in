export type MiniMode = "auto" | "compact" | "detailed";
export type MiniTextSize = "normal" | "large";

export interface MiniSettings {
  mode: MiniMode;
  textSize: MiniTextSize;
  privacyNow: boolean;
  showAtLaunch: boolean;
  opacity: number;
  cornerPinned: boolean;
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
  };
}
