import assert from "node:assert/strict";
import test from "node:test";

import { parseMiniSettings } from "../src/miniSettings.ts";

test("parses persisted mini settings for both settings surfaces", () => {
  assert.deepEqual(parseMiniSettings({
    mini_mode: "detailed",
    mini_text_size: "large",
    mini_privacy_now: "1",
    tray_only: "0",
    mini_opacity: "75",
    mini_click_through: "1",
    mini_corner_tuck: "1",
  }), {
    mode: "detailed",
    textSize: "large",
    privacyNow: true,
    showAtLaunch: true,
    opacity: 75,
    cornerPinned: false,
    clickThrough: true,
    cornerTuck: true,
  });
});

test("uses safe defaults for missing or invalid mini settings", () => {
  assert.deepEqual(parseMiniSettings({ mini_opacity: "55", mini_mode: "wide" }), {
    mode: "auto",
    textSize: "normal",
    privacyNow: false,
    showAtLaunch: false,
    opacity: 100,
    cornerPinned: false,
    clickThrough: false,
    cornerTuck: false,
  });
  assert.equal(parseMiniSettings({ mini_opacity: "85.5" }).opacity, 100);
  assert.equal(parseMiniSettings({ mini_opacity: "105" }).opacity, 100);
  assert.equal(parseMiniSettings({ mini_corner: "br" }).cornerPinned, true);
  assert.equal(parseMiniSettings({ mini_corner: "bottom-right" }).cornerPinned, false);
});
