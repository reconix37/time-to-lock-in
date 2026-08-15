import assert from "node:assert/strict";
import test from "node:test";

import { localizedDuration } from "../src/duration.ts";

const t = (key, vars = {}) => ({
  "duration.lessMinute": "<1m",
  "duration.minutes": `${vars.minutes}m`,
  "duration.hours": `${vars.hours}h`,
  "duration.hoursMinutes": `${vars.hours}h ${vars.minutes}m`,
}[key] ?? key);

test("localized duration uses hours and minutes without seconds", () => {
  assert.equal(localizedDuration(4 * 3_600_000 + 44 * 60_000 + 59_000, t), "4h 44m");
});

test("localized duration preserves the less-than-minute state", () => {
  assert.equal(localizedDuration(5_000, t), "<1m");
});
