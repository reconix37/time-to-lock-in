import assert from "node:assert/strict";
import test from "node:test";

import { nextRulePriority, titleRulePattern } from "../src/classification.ts";

test("assigns popup rules one priority above every existing rule", () => {
  assert.equal(nextRulePriority([]), 1);
  assert.equal(nextRulePriority([{ priority: -3 }, { priority: 0 }]), 1);
  assert.equal(nextRulePriority([{ priority: 4 }, { priority: 12 }, { priority: 7 }]), 13);
});

test("builds a stable title rule pattern from a visible browser title", () => {
  assert.equal(
    titleRulePattern("  (6) РЕШИЛ ВПЕРВЫЕ ПРОЙТИ SEKIRO B 2026 - YouTube - Google Chrome  "),
    "РЕШИЛ ВПЕРВЫЕ ПРОЙТИ SEKIRO B 2026",
  );
  assert.equal(titleRulePattern("(42) Docs - Microsoft Edge"), "Docs");
  assert.equal(titleRulePattern("Stream - Opera"), "Stream");
  assert.equal(titleRulePattern("Article - Firefox"), "Article");
});

test("matches browser suffixes case-insensitively without changing meaningful title case", () => {
  assert.equal(titleRulePattern("MiXeD Title - gOoGlE cHrOmE"), "MiXeD Title");
});

test("strips a trailing content-platform suffix and handles empty titles", () => {
  assert.equal(titleRulePattern("Sekiro - YouTube"), "Sekiro");
  assert.equal(titleRulePattern("   "), "");
});

test("builds one semantic core for different episodes of the same season", () => {
  const secondEpisode = titleRulePattern(
    "Смотреть сериал Игра престолов 4 сезон 2 серия онлайн бесплатно в хорошем качестве - YouTube",
  );
  const thirdEpisode = titleRulePattern(
    "Смотреть сериал Игра престолов 4 сезон 3 серия онлайн бесплатно в хорошем качестве - YouTube",
  );

  assert.equal(secondEpisode, "Игра престолов 4 сезон");
  assert.equal(thirdEpisode, "Игра престолов 4 сезон");
  assert.equal(secondEpisode, thirdEpisode);
});

test("keeps season identity and falls back when stripping removes the whole title", () => {
  assert.equal(titleRulePattern("Watch Example 2 season episode 7 online HD"), "Example 2 season");
  assert.equal(titleRulePattern("Watch online free HD"), "Watch online free HD");
});
