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

export interface RuleSignature {
  match_type: "exe" | "title" | "domain";
  match_mode: "legacy" | "regex";
  pattern: string;
  category_id: number;
  case_insensitive: boolean;
}

export function sameRuleSignature(left: RuleSignature, right: RuleSignature): boolean {
  return left.category_id === right.category_id
    && left.match_type === right.match_type
    && left.match_mode === right.match_mode
    && left.case_insensitive === right.case_insensitive
    && left.pattern.trim() === right.pattern.trim();
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
