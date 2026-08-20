export type ManagerView =
  | { type: "category"; categoryId: number }
  | { type: "rules"; categoryId: number }
  | { type: "allRules" }
  | { type: "newCategory" }
  | { type: "newRule"; categoryId: number; returnTo?: "rules" | "allRules" };

export interface CategoryNode {
  id: number;
  parent_id: number | null;
  sort_order?: number;
}

export interface RuleConditionSignature {
  match_type: "exe" | "title" | "domain";
  match_mode: "legacy" | "regex";
  pattern: string;
  case_insensitive: boolean;
}

export interface RuleSignature {
  match_type: "exe" | "title" | "domain" | "any";
  match_mode: "legacy" | "regex";
  pattern: string;
  category_id: number;
  case_insensitive: boolean;
  conditions?: readonly RuleConditionSignature[];
}

function ruleConditionKey(condition: RuleConditionSignature): string {
  return `${condition.match_type}\u0000${condition.match_mode}\u0000${condition.case_insensitive ? "1" : "0"}\u0000${condition.pattern.trim()}`;
}

export function sameRuleSignature(left: RuleSignature, right: RuleSignature): boolean {
  // Условия AND коммутативны: {app=Telegram, title=3D} и {title=3D, app=Telegram} — одно правило.
  const canonical = (list: readonly RuleConditionSignature[]) =>
    [...list].map(ruleConditionKey).sort();
  const leftConditions = canonical(left.conditions ?? []);
  const rightConditions = canonical(right.conditions ?? []);
  return left.category_id === right.category_id
    && left.match_type === right.match_type
    && left.match_mode === right.match_mode
    && left.case_insensitive === right.case_insensitive
    && left.pattern.trim() === right.pattern.trim()
    && leftConditions.length === rightConditions.length
    && leftConditions.every((key, index) => key === rightConditions[index]);
}

export function normalizedRuleConditions(rule: RuleSignature): RuleConditionSignature[] {
  if (rule.conditions && rule.conditions.length > 0) return [...rule.conditions];
  if (rule.match_type === "any") return [];
  return [{
    match_type: rule.match_type,
    match_mode: rule.match_mode,
    pattern: rule.pattern,
    case_insensitive: rule.case_insensitive,
  }];
}

export function rulesActionView(categoryId: number): ManagerView {
  return categoryId === 0
    ? { type: "newRule", categoryId: 0, returnTo: "rules" }
    : { type: "rules", categoryId };
}

export function nextSelectionAfterDelete(deleted: CategoryNode, remaining: CategoryNode[]): number {
  if (deleted.parent_id !== null && remaining.some((category) => category.id === deleted.parent_id)) {
    return deleted.parent_id;
  }
  const siblings = remaining.filter((category) => category.parent_id === deleted.parent_id);
  if (siblings.length === 0) return 0;
  if (deleted.sort_order === undefined) return siblings[0].id;
  return siblings.reduce((nearest, category) => {
    const nearestDistance = Math.abs((nearest.sort_order ?? 0) - deleted.sort_order!);
    const categoryDistance = Math.abs((category.sort_order ?? 0) - deleted.sort_order!);
    return categoryDistance < nearestDistance ? category : nearest;
  }).id;
}
