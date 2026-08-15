import assert from "node:assert/strict";
import test from "node:test";

import {
  nextSelectionAfterDelete,
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
