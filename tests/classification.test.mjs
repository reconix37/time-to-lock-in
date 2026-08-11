import assert from "node:assert/strict";
import test from "node:test";

import { titleRulePattern } from "../src/classification.ts";

test("builds a stable title rule pattern from a visible browser title", () => {
  assert.equal(
    titleRulePattern("  (6) РЕШИЛ ВПЕРВЫЕ ПРОЙТИ SEKIRO B 2026 - YouTube - Google Chrome  "),
    "РЕШИЛ ВПЕРВЫЕ ПРОЙТИ SEKIRO B 2026 - YouTube",
  );
  assert.equal(titleRulePattern("(42) Docs - Microsoft Edge"), "Docs");
  assert.equal(titleRulePattern("Stream - Opera"), "Stream");
  assert.equal(titleRulePattern("Article - Firefox"), "Article");
});

test("matches browser suffixes case-insensitively without changing meaningful title case", () => {
  assert.equal(titleRulePattern("MiXeD Title - gOoGlE cHrOmE"), "MiXeD Title");
});

test("keeps meaningful YouTube context and handles empty titles", () => {
  assert.equal(titleRulePattern("Sekiro - YouTube"), "Sekiro - YouTube");
  assert.equal(titleRulePattern("   "), "");
});
