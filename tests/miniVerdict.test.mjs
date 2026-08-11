import assert from "node:assert/strict";
import test from "node:test";

import { formatObservedClock, getMiniVerdict } from "../src/miniVerdict.ts";

test("formats observed day time as HH:MM", () => {
  assert.equal(formatObservedClock(0), "00:00");
  assert.equal(formatObservedClock(4 * 3_600_000 + 37 * 60_000 + 59_000), "04:37");
  assert.equal(formatObservedClock(123 * 3_600_000 + 5 * 60_000), "123:05");
});

const baseline = {
  usefulMs: 120 * 60_000,
  wasteMs: 10 * 60_000,
  observedMs: 180 * 60_000,
  usefulGoalMin: 120,
  wasteLimitMin: 60,
  observedMin: 60,
  usefulLabel: "Заебись",
  wasteLabel: "Пиздец",
};

test("selects mini verdicts in the confirmed priority order", () => {
  assert.deepEqual(
    getMiniVerdict({ ...baseline, wasteMs: 61 * 60_000 }),
    { key: "mini.verdictWasteExceeded", vars: { label: "Пиздец", minutes: 1 } },
  );
  assert.deepEqual(
    getMiniVerdict({ ...baseline, usefulMs: 100 * 60_000, wasteMs: 48 * 60_000 }),
    { key: "mini.verdictWasteRemaining", vars: { label: "Пиздец", minutes: 12 } },
  );
  assert.deepEqual(
    getMiniVerdict({ ...baseline, wasteMs: 48 * 60_000 }),
    { key: "mini.verdictPassedNearLimit", vars: { minutes: 12 } },
  );
  assert.deepEqual(
    getMiniVerdict({ ...baseline, wasteMs: 47 * 60_000 }),
    { key: "mini.verdictPassed", vars: {} },
  );
  assert.deepEqual(
    getMiniVerdict({ ...baseline, usefulMs: 119 * 60_000 + 1 }),
    { key: "mini.verdictUsefulRemaining", vars: { label: "Заебись", minutes: 1 } },
  );
  assert.deepEqual(
    getMiniVerdict({
      ...baseline,
      usefulMs: 30 * 60_000,
      usefulGoalMin: 30,
      observedMs: 59 * 60_000 + 59_000,
    }),
    { key: "mini.verdictObserved", vars: { current: 59, goal: 60 } },
  );
  assert.deepEqual(
    getMiniVerdict({ ...baseline, observedMs: Number.NaN }),
    { key: "mini.verdictInProgress", vars: {} },
  );
});
