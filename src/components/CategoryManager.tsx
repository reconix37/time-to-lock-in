import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { KindLabels } from "../share";
import { useI18n } from "../i18nContext";

export type CategoryKind = "useful" | "neutral" | "waste";
export type RuleMatchType = "exe" | "title" | "domain";
export type RuleMatchMode = "legacy" | "regex";

export interface Category {
  id: number;
  name: string;
  color: string;
  icon: string;
  kind: CategoryKind;
  goal_multiplier: number;
  sort_order: number;
  parent_id: number | null;
  score: number;
  inherit_color: boolean;
  inherit_score: boolean;
  effective_color: string;
  effective_score: number;
  full_path: string;
}

export interface Rule {
  id: number;
  match_type: RuleMatchType;
  pattern: string;
  category_id: number;
  priority: number;
  match_mode: RuleMatchMode;
  case_insensitive: boolean;
}

interface RulePreview {
  matched_values: number;
  total_values: number;
  matched_duration_ms: number;
  broad_warning: boolean;
}

interface Props {
  open: boolean;
  categories: Category[];
  kindLabels: KindLabels;
  formatDuration: (durationMs: number) => string;
  observedMs: number;
  appCount: number;
  uncategorizedMs: number;
  onCategoriesChange: (categories: Category[]) => void;
  onDashboardRefresh: () => Promise<void>;
}

type CategoryDraft = Omit<Category, "id" | "effective_color" | "effective_score" | "full_path">;
type RuleDraft = Omit<Rule, "id" | "priority">;
type DetailMode = "category" | "rules" | "all";

const COLORS = ["#286983", "#ea9d34", "#b4637a", "#56949f", "#907aa9", "#9893a5"];

const EMPTY_CATEGORY: CategoryDraft = {
  name: "",
  color: COLORS[3],
  icon: "",
  kind: "neutral",
  goal_multiplier: 1,
  sort_order: 0,
  parent_id: null,
  score: 0,
  inherit_color: false,
  inherit_score: false,
};

function emptyRule(categoryId: number): RuleDraft {
  return {
    match_type: "exe",
    pattern: "",
    category_id: categoryId,
    match_mode: "legacy",
    case_insensitive: true,
  };
}

function scoreText(score: number): string {
  const value = Number.isInteger(score) ? score.toFixed(0) : score.toFixed(1);
  return score > 0 ? `+${value}` : value;
}

function sameSignature(left: Pick<Rule, "match_type" | "match_mode" | "pattern">, right: Pick<Rule, "match_type" | "match_mode" | "pattern">): boolean {
  return left.match_type === right.match_type
    && left.match_mode === right.match_mode
    && left.pattern.trim() === right.pattern.trim();
}

function sourceShort(type: RuleMatchType): string {
  if (type === "domain") return "WEB";
  if (type === "title") return "TITLE";
  return "APP";
}

export function CategoryManager({
  open,
  categories,
  kindLabels,
  formatDuration,
  observedMs,
  appCount,
  uncategorizedMs,
  onCategoriesChange,
  onDashboardRefresh,
}: Props) {
  const { t } = useI18n();
  const [rules, setRules] = useState<Rule[]>([]);
  const [selectedCategoryId, setSelectedCategoryId] = useState<number | null>(null);
  const [detailMode, setDetailMode] = useState<DetailMode>("category");
  const [editing, setEditing] = useState<Category | null>(null);
  const [creatingCategory, setCreatingCategory] = useState(false);
  const [newCategory, setNewCategory] = useState<CategoryDraft>({ ...EMPTY_CATEGORY });
  const [creatingRule, setCreatingRule] = useState(false);
  const [newRule, setNewRule] = useState<RuleDraft>(emptyRule(0));
  const [preview, setPreview] = useState<RulePreview | null>(null);
  const [previewPending, setPreviewPending] = useState(false);
  const [patternError, setPatternError] = useState<string | null>(null);
  const [rowErrors, setRowErrors] = useState<Record<number, string>>({});
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());
  const [expandedRules, setExpandedRules] = useState<Set<number>>(new Set());
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rulesSectionRef = useRef<HTMLDivElement>(null);

  const manageable = useMemo(() => categories.filter((category) => category.id !== 0), [categories]);
  const uncategorized = useMemo(() => categories.find((category) => category.id === 0) ?? null, [categories]);
  const selectedCategory = useMemo(
    () => categories.find((category) => category.id === selectedCategoryId) ?? null,
    [categories, selectedCategoryId],
  );
  const nextPriority = useMemo(() => Math.max(0, ...rules.map((rule) => rule.priority)) + 1, [rules]);
  const duplicate = useMemo(
    () => rules.find((rule) => sameSignature(rule, newRule)) ?? null,
    [newRule, rules],
  );
  const visibleRules = useMemo(
    () => detailMode === "all" ? rules : rules.filter((rule) => rule.category_id === selectedCategoryId),
    [detailMode, rules, selectedCategoryId],
  );
  const childrenByParent = useMemo(() => {
    const result = new Map<number | null, Category[]>();
    for (const category of manageable) {
      const siblings = result.get(category.parent_id) ?? [];
      siblings.push(category);
      result.set(category.parent_id, siblings);
    }
    return result;
  }, [manageable]);
  const visibleCategories = useMemo(() => {
    const result: Array<{ category: Category; depth: number }> = [];
    const visit = (parentId: number | null, depth: number) => {
      for (const category of childrenByParent.get(parentId) ?? []) {
        result.push({ category, depth });
        if (!collapsed.has(category.id)) visit(category.id, depth + 1);
      }
    };
    visit(null, 0);
    return result;
  }, [childrenByParent, collapsed]);

  const errorText = (reason: unknown, fallback: string) => {
    if (typeof reason !== "string") return t(fallback);
    if (reason.includes("cycle")) return t("validation.categoryCycle");
    if (reason.includes("depth")) return t("validation.categoryDepth");
    if (reason.includes("regex")) return t("validation.regex");
    return reason;
  };

  function categoryName(categoryId: number): string {
    return categories.find((category) => category.id === categoryId)?.full_path ?? t("common.uncategorized");
  }

  async function reload() {
    const [nextCategories, nextRules] = await Promise.all([
      invoke<Category[]>("get_categories"),
      invoke<Rule[]>("get_rules"),
    ]);
    onCategoriesChange(nextCategories);
    setRules(nextRules);
    setSelectedCategoryId((current) => {
      if (current !== null && nextCategories.some((category) => category.id === current)) return current;
      return nextCategories.find((category) => category.id !== 0)?.id ?? 0;
    });
    setNewRule((current) => ({
      ...current,
      category_id: current.category_id || nextCategories.find((category) => category.id !== 0)?.id || 0,
    }));
  }

  useEffect(() => {
    if (!open) return;
    setError(null);
    setLoading(true);
    void reload()
      .catch((reason: unknown) => setError(typeof reason === "string" ? reason : t("error.loadManager")))
      .finally(() => setLoading(false));
  }, [open]);

  useEffect(() => {
    if (!creatingRule || !newRule.pattern.trim()) {
      setPreview(null);
      setPreviewPending(false);
      if (!newRule.pattern.trim()) setPatternError(null);
      return;
    }
    setPreviewPending(true);
    const timeout = window.setTimeout(() => {
      void invoke<RulePreview>("preview_rule", {
        matchType: newRule.match_type,
        pattern: newRule.pattern,
        matchMode: newRule.match_mode,
        caseInsensitive: newRule.case_insensitive,
      }).then((result) => {
        setPreview(result);
        setPatternError(null);
      }).catch((reason: unknown) => {
        setPreview(null);
        setPatternError(errorText(reason, "validation.regex"));
      }).finally(() => setPreviewPending(false));
    }, 250);
    return () => window.clearTimeout(timeout);
  }, [creatingRule, newRule.case_insensitive, newRule.match_mode, newRule.match_type, newRule.pattern]);

  useEffect(() => {
    if (detailMode !== "rules") return;
    window.setTimeout(() => rulesSectionRef.current?.scrollIntoView({ block: "start" }), 0);
  }, [detailMode, selectedCategoryId]);

  async function saveCategory(category: CategoryDraft | Category, id?: number) {
    setSaving(true);
    setError(null);
    try {
      await invoke(id === undefined ? "create_category" : "update_category", {
        ...(id === undefined ? {} : { id }),
        name: category.name,
        color: category.color,
        kind: category.kind,
        parentId: category.parent_id,
        score: category.score,
        inheritColor: category.parent_id !== null && category.inherit_color,
        inheritScore: category.parent_id !== null && category.inherit_score,
      });
      await reload();
      setCreatingCategory(false);
      setEditing(null);
      setNewCategory({ ...EMPTY_CATEGORY });
      await onDashboardRefresh();
    } catch (reason: unknown) {
      setError(errorText(reason, id === undefined ? "error.createCategory" : "error.changeCategory"));
    } finally {
      setSaving(false);
    }
  }

  async function removeCategory(category: Category) {
    if (!window.confirm(t("manager.confirmDelete", { name: category.name }))) return;
    setSaving(true);
    setError(null);
    try {
      await invoke("delete_category", { id: category.id });
      await reload();
      await onDashboardRefresh();
    } catch (reason: unknown) {
      setError(typeof reason === "string" ? reason : t("error.deleteCategory"));
    } finally {
      setSaving(false);
    }
  }

  async function createRule() {
    const normalizedPattern = newRule.pattern.trim();
    if (!normalizedPattern) {
      setPatternError(t("validation.patternRequired"));
      return;
    }
    if (duplicate) {
      setPatternError(t("validation.ruleDuplicate", {
        category: categoryName(duplicate.category_id),
        priority: duplicate.priority,
      }));
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await invoke("create_rule", {
        matchType: newRule.match_type,
        pattern: normalizedPattern,
        categoryId: newRule.category_id,
        priority: nextPriority,
        matchMode: newRule.match_mode,
        caseInsensitive: newRule.case_insensitive,
      });
      await reload();
      setNewRule(emptyRule(newRule.category_id));
      setCreatingRule(false);
      setPreview(null);
      setPatternError(null);
    } catch (reason: unknown) {
      setPatternError(errorText(reason, "error.createRule"));
    } finally {
      setSaving(false);
    }
  }

  async function updateRule(rule: Rule) {
    const normalizedPattern = rule.pattern.trim();
    const conflict = rules.find((item) => item.id !== rule.id && sameSignature(item, rule));
    if (!normalizedPattern || conflict) {
      const message = conflict
        ? t("validation.ruleDuplicate", { category: categoryName(conflict.category_id), priority: conflict.priority })
        : t("validation.patternRequired");
      setRowErrors((current) => ({ ...current, [rule.id]: message }));
      await reload();
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await invoke("update_rule", {
        id: rule.id,
        matchType: rule.match_type,
        pattern: normalizedPattern,
        categoryId: rule.category_id,
        priority: rule.priority,
        matchMode: rule.match_mode,
        caseInsensitive: rule.case_insensitive,
      });
      await reload();
      setRowErrors((current) => {
        const next = { ...current };
        delete next[rule.id];
        return next;
      });
    } catch (reason: unknown) {
      setRowErrors((current) => ({ ...current, [rule.id]: errorText(reason, "error.changeRule") }));
      await reload();
    } finally {
      setSaving(false);
    }
  }

  async function removeRule(id: number) {
    setSaving(true);
    setError(null);
    try {
      await invoke("delete_rule", { id });
      await reload();
    } catch (reason: unknown) {
      setError(typeof reason === "string" ? reason : t("error.deleteRule"));
    } finally {
      setSaving(false);
    }
  }

  async function moveRule(index: number, direction: -1 | 1) {
    const targetIndex = index + direction;
    if (targetIndex < 0 || targetIndex >= rules.length) return;
    const reordered = [...rules];
    [reordered[index], reordered[targetIndex]] = [reordered[targetIndex], reordered[index]];
    setSaving(true);
    setError(null);
    try {
      for (const [ruleIndex, rule] of reordered.entries()) {
        const priority = reordered.length - ruleIndex;
        if (rule.priority === priority) continue;
        await invoke("update_rule", {
          id: rule.id,
          matchType: rule.match_type,
          pattern: rule.pattern,
          categoryId: rule.category_id,
          priority,
          matchMode: rule.match_mode,
          caseInsensitive: rule.case_insensitive,
        });
      }
      await reload();
    } catch (reason: unknown) {
      setError(errorText(reason, "error.changeRule"));
      await reload();
    } finally {
      setSaving(false);
    }
  }

  async function replayHistory() {
    if (!window.confirm(t("manager.confirmRepaintAll"))) return;
    setSaving(true);
    setError(null);
    try {
      await invoke("reclassify_history", {
        overwriteManual: true,
        manualMatchType: null,
        manualPattern: null,
        confirmed: true,
      });
      await onDashboardRefresh();
    } catch (reason: unknown) {
      setError(typeof reason === "string" ? reason : t("error.repaintHistory"));
    } finally {
      setSaving(false);
    }
  }

  function openRules(categoryId: number) {
    const targetCategoryId = categoryId === 0 ? manageable[0]?.id ?? 0 : categoryId;
    setSelectedCategoryId(categoryId);
    setDetailMode("rules");
    setEditing(null);
    setCreatingCategory(false);
    setCreatingRule(true);
    setNewRule(emptyRule(targetCategoryId));
    setPatternError(null);
  }

  function selectCategory(category: Category) {
    setSelectedCategoryId(category.id);
    setDetailMode("category");
    setEditing(category.id === 0 ? null : category);
    setCreatingCategory(false);
    setCreatingRule(false);
    setPatternError(null);
  }

  function renderCategoryForm(category: CategoryDraft | Category, id?: number) {
    const setCategory = (next: CategoryDraft | Category) => {
      if (id === undefined) setNewCategory(next as CategoryDraft);
      else setEditing(next as Category);
    };
    return (
      <form className="manager-form category-edit-form" noValidate onSubmit={(event) => { event.preventDefault(); void saveCategory(category, id); }}>
        <label className="manager-field"><span>{t("manager.name")}</span><input required maxLength={80} value={category.name} onChange={(event) => setCategory({ ...category, name: event.target.value })} /></label>
        <label className="manager-field"><span>{t("manager.parent")}</span><select className="with-chevron" value={category.parent_id ?? ""} onChange={(event) => { const parentId = event.target.value ? Number(event.target.value) : null; setCategory({ ...category, parent_id: parentId, inherit_color: parentId !== null && (id !== undefined ? category.inherit_color : true), inherit_score: parentId !== null && (id !== undefined ? category.inherit_score : true) }); }}><option value="">{t("manager.noParent")}</option>{manageable.filter((item) => item.id !== id && !("full_path" in category && item.full_path.startsWith(`${category.full_path} > `))).map((item) => <option key={item.id} value={item.id}>{item.full_path}</option>)}</select></label>
        <label className="manager-field"><span>{t("manager.type")}</span><select className="with-chevron" value={category.kind} onChange={(event) => { const kind = event.target.value as CategoryKind; setCategory({ ...category, kind, score: id === undefined && category.parent_id === null ? (kind === "useful" ? 10 : kind === "waste" ? -10 : 0) : category.score }); }}><option value="useful">{kindLabels.useful}</option><option value="neutral">{kindLabels.neutral}</option><option value="waste">{kindLabels.waste}</option></select></label>
        <label className="manager-field"><span>{t("manager.score")}</span><input type="number" min={-10} max={10} step="0.1" disabled={category.inherit_score} value={category.score} onChange={(event) => setCategory({ ...category, score: Number(event.target.value) })} /></label>
        <label className="manager-toggle"><input type="checkbox" disabled={category.parent_id === null} checked={category.inherit_color} onChange={(event) => setCategory({ ...category, inherit_color: event.target.checked })} />{t("manager.inheritColor")}</label>
        <label className="manager-toggle"><input type="checkbox" disabled={category.parent_id === null} checked={category.inherit_score} onChange={(event) => setCategory({ ...category, inherit_score: event.target.checked })} />{t("manager.inheritScore")}</label>
        <div className="manager-color-field"><span>{t("manager.color")}</span><div className="color-presets">{COLORS.map((color) => <button key={color} type="button" disabled={category.inherit_color} aria-label={t("manager.chooseColor", { color })} className={category.color === color ? "is-selected" : ""} style={{ backgroundColor: color }} onClick={() => setCategory({ ...category, color })} />)}</div></div>
        <div className="manager-form-actions"><button type="button" className="manager-cancel-button" onClick={() => { setCreatingCategory(false); setEditing(null); }}>{t("common.cancel")}</button><button type="submit" className="manager-submit-button" disabled={saving || !category.name.trim()}>{t("common.save")}</button></div>
      </form>
    );
  }

  function renderRuleForm() {
    return (
      <form className="manager-form rule-sentence-form" noValidate onSubmit={(event) => { event.preventDefault(); void createRule(); }}>
        <strong className="rule-sentence-lead">{t("manager.if")}</strong>
        <div className="rule-form-pair">
          <label className="manager-field"><span>{t("manager.source")}</span><select className="with-chevron" value={newRule.match_type} onChange={(event) => setNewRule({ ...newRule, match_type: event.target.value as RuleMatchType })}><option value="exe">{t("manager.sourceApp")}</option><option value="title">{t("manager.sourceTitle")}</option><option value="domain">{t("manager.sourceWebsite")}</option></select></label>
          <label className="manager-field"><span>{t("manager.how")}</span><select className="with-chevron" value={newRule.match_mode} onChange={(event) => setNewRule({ ...newRule, match_mode: event.target.value as RuleMatchMode })}><option value="legacy">{t("manager.smartMatch")}</option><option value="regex">{t("manager.regularExpression")}</option></select></label>
        </div>
        <div className="rule-pattern-group">
          <div className="rule-pattern-heading"><span>{t("manager.pattern")}</span><label className="rule-case"><input type="checkbox" checked={newRule.case_insensitive} onChange={(event) => setNewRule({ ...newRule, case_insensitive: event.target.checked })} />{t("manager.caseInsensitive")}</label></div>
          <input autoComplete="off" spellCheck={false} maxLength={500} value={newRule.pattern} aria-invalid={patternError !== null || duplicate !== null} aria-describedby="rule-pattern-state" onChange={(event) => { setNewRule({ ...newRule, pattern: event.target.value }); setPatternError(null); }} />
          <p id="rule-pattern-state" className={patternError || duplicate ? "rule-field-error" : preview ? "rule-field-valid" : "rule-field-help"}>
            {patternError ?? (duplicate ? t("validation.ruleDuplicate", { category: categoryName(duplicate.category_id), priority: duplicate.priority }) : preview ? t("manager.patternValid") : t("manager.patternHint"))}
          </p>
        </div>
        <div className="rule-form-pair">
          <label className="manager-field"><span>{t("manager.assignCategory")}</span><select className="with-chevron" value={newRule.category_id} onChange={(event) => setNewRule({ ...newRule, category_id: Number(event.target.value) })}>{manageable.map((category) => <option key={category.id} value={category.id}>{category.full_path}</option>)}</select></label>
          <details className="rule-advanced"><summary>{t("settings.advanced")}</summary><p>{t("manager.ruleOrder", { count: rules.length })}</p></details>
        </div>
        <div className={`rule-preview ${preview?.broad_warning ? "is-warning" : ""}`} aria-live="polite">
          {previewPending ? t("manager.previewLoading") : preview ? <>{preview.broad_warning && <span>{t("manager.broadWarning")} · </span>}{t("manager.livePreview", { count: preview.matched_values, duration: formatDuration(preview.matched_duration_ms) })}</> : t("manager.previewEmpty")}
        </div>
        <div className="manager-form-actions"><button type="button" className="manager-cancel-button" onClick={() => { setCreatingRule(false); setPatternError(null); }}>{t("common.cancel")}</button><button type="submit" className="manager-submit-button" disabled={saving || newRule.category_id === 0 || !newRule.pattern.trim() || duplicate !== null || patternError !== null}>{t("manager.addRule")}</button></div>
      </form>
    );
  }

  function renderRulesList() {
    if (visibleRules.length === 0) return <p className="manager-empty">{t("manager.noRules")}</p>;
    return (
      <div className="manager-list rule-list">
        {visibleRules.map((rule) => {
          const globalIndex = rules.findIndex((item) => item.id === rule.id);
          return (
            <div className="rule-manager-row rule-manager-edit" key={rule.id}>
              <label className="manager-field"><span>{t("manager.source")}</span><select className="with-chevron" value={rule.match_type} onChange={(event) => void updateRule({ ...rule, match_type: event.target.value as RuleMatchType })}><option value="exe">{t("manager.sourceApp")}</option><option value="title">{t("manager.sourceTitle")}</option><option value="domain">{t("manager.sourceWebsite")}</option></select></label>
              <label className="manager-field"><span>{t("manager.how")}</span><select className="with-chevron" value={rule.match_mode} onChange={(event) => void updateRule({ ...rule, match_mode: event.target.value as RuleMatchMode })}><option value="legacy">{t("manager.smartMatch")}</option><option value="regex">{t("manager.regularExpression")}</option></select></label>
              <div className="rule-pattern-group">
                <div className="rule-pattern-heading"><span>{t("manager.pattern")}</span><label className="rule-case"><input type="checkbox" checked={rule.case_insensitive} onChange={(event) => void updateRule({ ...rule, case_insensitive: event.target.checked })} />{t("manager.caseInsensitive")}</label></div>
                <input autoComplete="off" spellCheck={false} value={rule.pattern} aria-invalid={rowErrors[rule.id] !== undefined} onChange={(event) => setRules((current) => current.map((item) => item.id === rule.id ? { ...item, pattern: event.target.value } : item))} onBlur={() => void updateRule(rule)} />
                {rowErrors[rule.id] && <p className="rule-field-error">{rowErrors[rule.id]}</p>}
              </div>
              <label className="manager-field"><span>{t("manager.assignCategory")}</span><select className="with-chevron" value={rule.category_id} onChange={(event) => void updateRule({ ...rule, category_id: Number(event.target.value) })}>{manageable.map((category) => <option key={category.id} value={category.id}>{category.full_path}</option>)}</select></label>
              {detailMode === "all" && <div className="rule-order-actions"><span>{t("manager.orderNumber", { number: globalIndex + 1 })}</span><button type="button" disabled={saving || globalIndex === 0} onClick={() => void moveRule(globalIndex, -1)}>{t("manager.moveUp")}</button><button type="button" disabled={saving || globalIndex === rules.length - 1} onClick={() => void moveRule(globalIndex, 1)}>{t("manager.moveDown")}</button></div>}
              <button type="button" className="manager-delete-button" aria-label={t("manager.deleteRule", { pattern: rule.pattern })} onClick={() => void removeRule(rule.id)}>🗑</button>
            </div>
          );
        })}
      </div>
    );
  }

  if (!open) return null;
  if (loading) return <div className="manager-loading skeleton" />;

  const uncategorizedPercent = observedMs > 0 ? Math.round((uncategorizedMs / observedMs) * 100) : 0;
  const formCategory = editing ?? newCategory;

  return (
    <div className="category-manager">
      <aside className="category-master">
        <div className="all-activity-row">
          <strong>{t("manager.allActivity")}</strong>
          <span>{t("manager.allActivityStats", { duration: formatDuration(observedMs), apps: appCount, percent: uncategorizedPercent })}</span>
          <small>{t("manager.allActivityHint")}</small>
        </div>
        <div className={`category-special-row ${selectedCategoryId === 0 ? "is-selected" : ""}`}>
          <span className="manager-color-dot" />
          <button type="button" className="category-special-main" onClick={() => uncategorized && selectCategory(uncategorized)}><strong>{t("manager.needsSorting")}</strong><small>{t("common.uncategorized")}</small></button>
          <button type="button" className="category-special-cta" onClick={() => openRules(0)}>{t("manager.createRule")}</button>
        </div>
        <div className="category-tree">
          {visibleCategories.map(({ category, depth }) => {
            const childCount = childrenByParent.get(category.id)?.length ?? 0;
            const categoryRules = rules.filter((rule) => rule.category_id === category.id);
            const rulesOpen = expandedRules.has(category.id);
            return (
              <div className="category-tree-node" key={category.id} style={{ "--tree-indent": `${depth * 20}px` } as CSSProperties}>
                <div className={`category-tree-row ${selectedCategoryId === category.id ? "is-selected" : ""}`}>
                  <button type="button" className="tree-disclosure" disabled={childCount === 0} onClick={() => setCollapsed((current) => { const next = new Set(current); if (next.has(category.id)) next.delete(category.id); else next.add(category.id); return next; })}>{childCount ? (collapsed.has(category.id) ? "›" : "⌄") : "·"}</button>
                  <span className="manager-color-dot" style={{ backgroundColor: category.effective_color }} />
                  <button type="button" className="category-tree-main" title={category.full_path} onClick={() => selectCategory(category)}><strong>{category.name}</strong><small>{categoryRules.length ? t("manager.ruleSummary", { count: categoryRules.length, mode: categoryRules[0].match_mode }) : t("manager.noRule")}</small></button>
                  <span className={`category-score ${category.effective_score > 0 ? "is-positive" : category.effective_score < 0 ? "is-negative" : ""}`}>{scoreText(category.effective_score)}</span>
                  <button type="button" className="manager-rules-link" onClick={() => { setExpandedRules((current) => { const next = new Set(current); if (next.has(category.id)) next.delete(category.id); else next.add(category.id); return next; }); openRules(category.id); }}>{t("manager.rules")}</button>
                </div>
                {rulesOpen && categoryRules.length > 0 && <div className="category-rule-chips">{categoryRules.map((rule) => <button type="button" key={rule.id} title={rule.pattern} onClick={() => openRules(category.id)}><span>{sourceShort(rule.match_type)}</span><span>{rule.match_mode === "regex" ? "REGEX" : "SMART"}</span><strong>{rule.pattern}</strong></button>)}</div>}
              </div>
            );
          })}
        </div>
        <div className="category-master-actions">
          <button type="button" onClick={() => { setCreatingCategory(true); setEditing(null); setDetailMode("category"); }}>{t("manager.addCategory")}</button>
          <button type="button" className={detailMode === "all" ? "is-selected" : ""} onClick={() => { setDetailMode("all"); setCreatingCategory(false); setEditing(null); setCreatingRule(false); }}>{t("manager.allRules")}</button>
        </div>
      </aside>

      <div className="category-detail">
        {detailMode === "all" ? (
          <>
            <div className="manager-toolbar"><div><h4>{t("manager.allRules")}</h4><p>{t("manager.ruleCount", { count: rules.length })}</p></div><button type="button" className="manager-add-button" disabled={saving || rules.length === 0} onClick={() => void replayHistory()}>{t("manager.repaintAll")}</button></div>
            <p className="rule-tiebreak">{t("manager.tieBreak")}</p>
            {renderRulesList()}
          </>
        ) : creatingCategory ? (
          <><div className="manager-toolbar"><h4>{t("manager.addCategory")}</h4></div>{renderCategoryForm(formCategory)}</>
        ) : selectedCategory?.id === 0 ? (
          <div className="needs-sorting-detail"><span className="eyebrow">{t("manager.needsSorting")}</span><h4>{t("common.uncategorized")}</h4><p>{t("manager.uncategorizedHint")}</p>{detailMode === "rules" && creatingRule ? renderRuleForm() : <button type="button" className="manager-submit-button" onClick={() => openRules(0)}>{t("manager.createRule")}</button>}</div>
        ) : selectedCategory ? (
          <>
            <div className="category-detail-heading"><div><span className="eyebrow">{t("manager.category")}</span><h4 title={selectedCategory.full_path}>{selectedCategory.full_path}</h4></div><button type="button" className="manager-delete-button" disabled={saving || (childrenByParent.get(selectedCategory.id)?.length ?? 0) > 0} aria-label={t("manager.deleteCategory", { name: selectedCategory.name })} onClick={() => void removeCategory(selectedCategory)}>🗑</button></div>
            {detailMode === "category" && editing && renderCategoryForm(editing, editing.id)}
            <div className="category-rules-detail" ref={rulesSectionRef}>
              <div className="manager-toolbar"><div><h4>{t("manager.rulesFor", { category: selectedCategory.full_path })}</h4><p>{t("manager.ruleCount", { count: rules.filter((rule) => rule.category_id === selectedCategory.id).length })}</p></div><button type="button" className="manager-add-button" onClick={() => { setCreatingRule(true); setNewRule(emptyRule(selectedCategory.id)); }}>{t("manager.addRule")}</button></div>
              {creatingRule && renderRuleForm()}
              {renderRulesList()}
            </div>
          </>
        ) : <p className="manager-empty">{t("manager.noCategories")}</p>}
      </div>
      {error && <p className="settings-error manager-error">{error}</p>}
    </div>
  );
}
