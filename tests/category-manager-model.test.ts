import assert from "node:assert/strict";
import test from "node:test";

import {
  nextSelectionAfterDelete,
  normalizedRuleConditions,
  rulesActionView,
  sameRuleSignature,
  type CategoryNode,
  type RuleSignature,
} from "../src/categoryManagerModel.ts";

const baseRule: RuleSignature = {
  match_type: "title",
  match_mode: "legacy",
  pattern: "youtube",
  category_id: 4,
  case_insensitive: true,
};

test("identical rules are duplicates only inside the same category", () => {
  assert.equal(sameRuleSignature(baseRule, { ...baseRule }), true);
  assert.equal(sameRuleSignature(baseRule, { ...baseRule, category_id: 5 }), false);
});

test("case sensitivity is part of a rule signature", () => {
  assert.equal(sameRuleSignature(baseRule, { ...baseRule, case_insensitive: false }), false);
});

test("Needs sorting starts a rule with an explicit category choice", () => {
  assert.deepEqual(rulesActionView(0), { type: "newRule", categoryId: 0, returnTo: "rules" });
  assert.deepEqual(rulesActionView(4), { type: "rules", categoryId: 4 });
});

test("deleting a category selects its parent before a sibling", () => {
  const categories: CategoryNode[] = [
    { id: 1, parent_id: null },
    { id: 2, parent_id: 1 },
    { id: 3, parent_id: 1 },
  ];
  assert.equal(nextSelectionAfterDelete(categories[1], categories.filter((item) => item.id !== 2)), 1);
});

test("deleting a root selects the nearest sibling, then Needs sorting", () => {
  const deleted: CategoryNode = { id: 2, parent_id: null, sort_order: 8 };
  assert.equal(nextSelectionAfterDelete(deleted, [{ id: 1, parent_id: null, sort_order: 1 }, { id: 3, parent_id: null, sort_order: 9 }]), 3);
  assert.equal(nextSelectionAfterDelete(deleted, []), 0);
});

test("normalizedRuleConditions derives a single condition from legacy fields", () => {
  assert.deepEqual(normalizedRuleConditions(baseRule), [{
    match_type: "title",
    match_mode: "legacy",
    pattern: "youtube",
    case_insensitive: true,
  }]);
});

test("normalizedRuleConditions keeps explicit multi-condition list", () => {
  const conditions = [
    { match_type: "exe" as const, match_mode: "legacy" as const, pattern: "Telegram.exe", case_insensitive: true },
    { match_type: "title" as const, match_mode: "legacy" as const, pattern: "3D", case_insensitive: true },
  ];
  const rule: RuleSignature = { ...baseRule, conditions };
  assert.deepEqual(normalizedRuleConditions(rule), conditions);
});

test("sameRuleSignature treats condition order and AND-set as significant", () => {
  const left: RuleSignature = {
    ...baseRule,
    conditions: [
      { match_type: "exe", match_mode: "legacy", pattern: "Telegram.exe", case_insensitive: true },
      { match_type: "title", match_mode: "legacy", pattern: "3D", case_insensitive: true },
    ],
  };
  const same = { ...left };
  const differentOrder = { ...left, conditions: [...left.conditions!].reverse() };
  const differentPattern = { ...left, conditions: [{ ...left.conditions![1], pattern: "Cinema 4D" }] };
  const single = { ...left, conditions: [left.conditions![0]] };
  assert.equal(sameRuleSignature(left, same), true);
  assert.equal(sameRuleSignature(left, differentOrder), true);
  assert.equal(sameRuleSignature(left, differentPattern), false);
  assert.equal(sameRuleSignature(left, single), false);
});

