import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyMiniPreset,
  defaultMiniLayout,
  parseMiniLayout,
  serializeMiniLayout,
} from "../src/miniSettings.ts";

test("parseMiniLayout returns defaults for garbage/missing", () => {
  assert.deepEqual(parseMiniLayout(undefined), defaultMiniLayout());
  assert.deepEqual(parseMiniLayout(""), defaultMiniLayout());
  assert.deepEqual(parseMiniLayout("not json"), defaultMiniLayout());
  assert.deepEqual(parseMiniLayout("2"), defaultMiniLayout());
  const wrong = JSON.stringify({ version: 99, blocks: [{ id: "score", enabled: true, size: 2 }] });
  assert.deepEqual(parseMiniLayout(wrong), defaultMiniLayout());
});

test("parseMiniLayout skips unknown/duplicate blocks and re-adds missing", () => {
  const json = JSON.stringify({
    version: 1,
    blocks: [
      { id: "score", enabled: true, size: 2 },
      { id: "bogus", enabled: true, size: 2 },
      { id: "chart", enabled: true, size: 1 },
    ],
  });
  const layout = parseMiniLayout(json);
  const ids = layout.blocks.map((block) => block.id);
  assert.ok(ids.includes("score"));
  assert.ok(ids.includes("chart"));
  assert.ok(!ids.includes("bogus"));
  // недостающие блоки добавлены ровно по одному разу
  assert.deepEqual([...new Set(ids)].sort(), ["categories", "chart", "current", "score", "verdict"]);
  assert.equal(layout.blocks.find((block) => block.id === "chart")?.size, 1);
});

test("serialize/parse round-trips", () => {
  const layout = defaultMiniLayout();
  const roundTrip = parseMiniLayout(serializeMiniLayout(layout));
  assert.deepEqual(roundTrip, layout);
});

test("applyMiniPreset disables chart for compact, enables all for detailed", () => {
  const base = defaultMiniLayout();
  const compact = applyMiniPreset(base, "compact");
  assert.equal(compact.blocks.find((block) => block.id === "chart")?.enabled, false);
  const detailed = applyMiniPreset(base, "detailed");
  assert.equal(detailed.blocks.find((block) => block.id === "chart")?.enabled, true);
});

test("parseMiniLayout rejects empty blocks array", () => {
  assert.deepEqual(parseMiniLayout(JSON.stringify({ version: 1, blocks: [] })), defaultMiniLayout());
});
