import { useEffect, useMemo, useState, type CSSProperties } from "react";
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
  onCategoriesChange: (categories: Category[]) => void;
  onClose: () => void;
  onDashboardRefresh: () => Promise<void>;
}

const COLORS = ["#286983", "#ea9d34", "#b4637a", "#56949f", "#907aa9", "#9893a5"];

const EMPTY_CATEGORY: Omit<Category, "id" | "effective_color" | "effective_score" | "full_path"> = {
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

function scoreText(score: number): string {
  const value = Number.isInteger(score) ? score.toFixed(0) : score.toFixed(1);
  return score > 0 ? `+${value}` : value;
}

export function CategoryManager({
  open,
  categories,
  kindLabels,
  formatDuration,
  onCategoriesChange,
  onClose,
  onDashboardRefresh,
}: Props) {
  const { t } = useI18n();
  const [tab, setTab] = useState<"categories" | "rules">("categories");
  const [rules, setRules] = useState<Rule[]>([]);
  const [editing, setEditing] = useState<Category | null>(null);
  const [creating, setCreating] = useState(false);
  const [newCategory, setNewCategory] = useState({ ...EMPTY_CATEGORY });
  const [newRule, setNewRule] = useState<Omit<Rule, "id">>({
    match_type: "exe",
    pattern: "",
    category_id: 0,
    priority: 0,
    match_mode: "legacy",
    case_insensitive: true,
  });
  const [preview, setPreview] = useState<RulePreview | null>(null);
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const errorText = (reason: unknown, fallback: string) => {
    if (typeof reason !== "string") return t(fallback);
    if (reason.includes("cycle")) return t("validation.categoryCycle");
    if (reason.includes("depth")) return t("validation.categoryDepth");
    if (reason.includes("regex")) return t("validation.regex");
    return reason;
  };

  const manageable = useMemo(() => categories.filter((category) => category.id !== 0), [categories]);
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

  async function reload() {
    const [nextCategories, nextRules] = await Promise.all([
      invoke<Category[]>("get_categories"),
      invoke<Rule[]>("get_rules"),
    ]);
    onCategoriesChange(nextCategories);
    setRules(nextRules);
    setNewRule((current) => ({
      ...current,
      category_id: current.category_id || nextCategories.find((category) => category.id !== 0)?.id || 0,
    }));
  }

  useEffect(() => {
    if (!open) return;
    setTab("categories");
    setEditing(null);
    setCreating(false);
    setError(null);
    setLoading(true);
    void reload()
      .catch((reason: unknown) => setError(typeof reason === "string" ? reason : t("error.loadManager")))
      .finally(() => setLoading(false));
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !saving) onClose();
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [open, onClose, saving]);

  if (!open) return null;

  async function saveCategory(category: typeof newCategory, id?: number) {
    setSaving(true);
    setError(null);
    try {
      const payload = {
        ...(id === undefined ? {} : { id }),
        name: category.name,
        color: category.color,
        kind: category.kind,
        parentId: category.parent_id,
        score: category.score,
        inheritColor: category.parent_id !== null && category.inherit_color,
        inheritScore: category.parent_id !== null && category.inherit_score,
      };
      await invoke(id === undefined ? "create_category" : "update_category", payload);
      await reload();
      setCreating(false);
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

  async function saveRule(rule: Omit<Rule, "id">, id?: number) {
    setSaving(true);
    setError(null);
    try {
      await invoke(id === undefined ? "create_rule" : "update_rule", {
        ...(id === undefined ? {} : { id }),
        matchType: rule.match_type,
        pattern: rule.pattern,
        categoryId: rule.category_id,
        priority: rule.priority,
        matchMode: rule.match_mode,
        caseInsensitive: rule.case_insensitive,
      });
      await reload();
      if (id === undefined) {
        setNewRule((current) => ({ ...current, pattern: "" }));
        setPreview(null);
      }
    } catch (reason: unknown) {
      setError(errorText(reason, "error.createRule"));
    } finally {
      setSaving(false);
    }
  }

  async function previewRule() {
    setError(null);
    try {
      setPreview(await invoke<RulePreview>("preview_rule", {
        matchType: newRule.match_type,
        pattern: newRule.pattern,
        matchMode: newRule.match_mode,
        caseInsensitive: newRule.case_insensitive,
      }));
    } catch (reason: unknown) {
      setPreview(null);
      setError(errorText(reason, "validation.regex"));
    }
  }

  async function removeRule(id: number) {
    setSaving(true);
    try {
      await invoke("delete_rule", { id });
      await reload();
    } catch (reason: unknown) {
      setError(typeof reason === "string" ? reason : t("error.deleteRule"));
    } finally {
      setSaving(false);
    }
  }

  async function replayHistory() {
    if (!window.confirm(t("manager.confirmRepaintAll"))) return;
    setSaving(true);
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

  const formCategory = editing ?? newCategory;
  const setFormCategory = (next: Category | typeof newCategory) => {
    if (editing) setEditing(next as Category);
    else setNewCategory(next as typeof newCategory);
  };

  return (
    <div className="settings-overlay">
      <section className="settings-modal category-manager-modal" role="dialog" aria-modal="true" aria-labelledby="category-manager-title">
        <div className="settings-heading category-manager-heading">
          <div><span className="eyebrow">{t("manager.eyebrow")}</span><h2 id="category-manager-title">{t("manager.title")}</h2></div>
          <button type="button" className="manager-close" onClick={onClose} aria-label={t("common.close")}>×</button>
        </div>
        <div className="manager-tabs" role="tablist" aria-label={t("manager.section")}> 
          <button type="button" role="tab" aria-selected={tab === "categories"} className={tab === "categories" ? "is-active" : ""} onClick={() => setTab("categories")}>{t("dashboard.categories")}</button>
          <button type="button" role="tab" aria-selected={tab === "rules"} className={tab === "rules" ? "is-active" : ""} onClick={() => setTab("rules")}>{t("manager.rules")}</button>
        </div>
        <div className="manager-content">
          {loading ? <div className="manager-loading skeleton" /> : tab === "categories" ? (
            <div role="tabpanel">
              <div className="manager-toolbar"><p>{t("manager.categoryCount", { count: manageable.length })}</p><button type="button" className="manager-add-button" onClick={() => { setCreating(true); setEditing(null); }}>{t("manager.addCategory")}</button></div>
              {(creating || editing) && (
                <form className="manager-form category-edit-form" onSubmit={(event) => { event.preventDefault(); void saveCategory(formCategory, editing?.id); }}>
                  <label className="manager-field"><span>{t("manager.name")}</span><input required maxLength={80} value={formCategory.name} onChange={(event) => setFormCategory({ ...formCategory, name: event.target.value })} /></label>
                  <label className="manager-field"><span>{t("manager.parent")}</span><select className="with-chevron" value={formCategory.parent_id ?? ""} onChange={(event) => { const parentId = event.target.value ? Number(event.target.value) : null; setFormCategory({ ...formCategory, parent_id: parentId, inherit_color: parentId !== null && (editing ? formCategory.inherit_color : true), inherit_score: parentId !== null && (editing ? formCategory.inherit_score : true) }); }}><option value="">{t("manager.noParent")}</option>{manageable.filter((item) => item.id !== editing?.id && !item.full_path.startsWith(`${editing?.full_path} > `)).map((item) => <option key={item.id} value={item.id}>{item.full_path}</option>)}</select></label>
                  <label className="manager-field"><span>{t("manager.type")}</span><select className="with-chevron" value={formCategory.kind} onChange={(event) => { const kind = event.target.value as CategoryKind; setFormCategory({ ...formCategory, kind, score: !editing && formCategory.parent_id === null ? (kind === "useful" ? 10 : kind === "waste" ? -10 : 0) : formCategory.score }); }}><option value="useful">{kindLabels.useful}</option><option value="neutral">{kindLabels.neutral}</option><option value="waste">{kindLabels.waste}</option></select></label>
                  <label className="manager-field"><span>{t("manager.score")}</span><input type="number" min={-10} max={10} step="0.1" disabled={formCategory.inherit_score} value={formCategory.score} onChange={(event) => setFormCategory({ ...formCategory, score: Number(event.target.value) })} /></label>
                  <label className="manager-toggle"><input type="checkbox" disabled={formCategory.parent_id === null} checked={formCategory.inherit_color} onChange={(event) => setFormCategory({ ...formCategory, inherit_color: event.target.checked })} />{t("manager.inheritColor")}</label>
                  <label className="manager-toggle"><input type="checkbox" disabled={formCategory.parent_id === null} checked={formCategory.inherit_score} onChange={(event) => setFormCategory({ ...formCategory, inherit_score: event.target.checked })} />{t("manager.inheritScore")}</label>
                  <div className="manager-color-field"><span>{t("manager.color")}</span><div className="color-presets">{COLORS.map((color) => <button key={color} type="button" disabled={formCategory.inherit_color} className={formCategory.color === color ? "is-selected" : ""} style={{ backgroundColor: color }} onClick={() => setFormCategory({ ...formCategory, color })} />)}</div></div>
                  <div className="manager-form-actions"><button type="button" className="manager-cancel-button" onClick={() => { setCreating(false); setEditing(null); }}>{t("common.cancel")}</button><button type="submit" className="manager-submit-button" disabled={saving}>{t("common.save")}</button></div>
                </form>
              )}
              <div className="manager-list category-tree">
                {visibleCategories.map(({ category, depth }) => {
                  const childCount = childrenByParent.get(category.id)?.length ?? 0;
                  const categoryRules = rules.filter((rule) => rule.category_id === category.id);
                  return <div className="category-tree-row" key={category.id} style={{ "--tree-indent": `${depth * 20}px` } as CSSProperties}>
                    <button type="button" className="tree-disclosure" disabled={childCount === 0} onClick={() => setCollapsed((current) => { const next = new Set(current); if (next.has(category.id)) next.delete(category.id); else next.add(category.id); return next; })}>{childCount ? (collapsed.has(category.id) ? "›" : "⌄") : "·"}</button>
                    <span className="manager-color-dot" style={{ backgroundColor: category.effective_color }} />
                    <button type="button" className="category-tree-main" title={category.full_path} onClick={() => { setEditing(category); setCreating(false); }}><strong>{category.name}</strong><small>{categoryRules.length ? t("manager.ruleSummary", { count: categoryRules.length, mode: categoryRules[0].match_mode }) : t("manager.noRule")}</small></button>
                    <span className={`category-score ${category.effective_score > 0 ? "is-positive" : category.effective_score < 0 ? "is-negative" : ""}`}>{scoreText(category.effective_score)}</span>
                    <button type="button" className="manager-rules-link" onClick={() => setTab("rules")}>{t("manager.rules")}</button>
                    <button type="button" className="manager-delete-button" disabled={saving || childCount > 0} onClick={() => void removeCategory(category)}>🗑</button>
                  </div>;
                })}
              </div>
            </div>
          ) : (
            <div role="tabpanel">
              <div className="manager-toolbar"><p>{t("manager.ruleCount", { count: rules.length })}</p><button type="button" className="manager-add-button" disabled={saving || rules.length === 0} onClick={() => void replayHistory()}>{t("manager.repaintAll")}</button></div>
              <form className="manager-form rule-edit-form" onSubmit={(event) => { event.preventDefault(); void saveRule(newRule); }}>
                <label className="manager-field"><span>{t("manager.type")}</span><select className="with-chevron" value={newRule.match_type} onChange={(event) => setNewRule({ ...newRule, match_type: event.target.value as RuleMatchType })}><option value="exe">exe</option><option value="title">title</option><option value="domain">domain</option></select></label>
                <label className="manager-field"><span>{t("manager.regexMode")}</span><select className="with-chevron" value={newRule.match_mode} onChange={(event) => setNewRule({ ...newRule, match_mode: event.target.value as RuleMatchMode })}><option value="legacy">legacy</option><option value="regex">regex</option></select></label>
                <label className="manager-field manager-field-wide"><span>{t("manager.pattern")}</span><input required maxLength={500} value={newRule.pattern} onChange={(event) => { setNewRule({ ...newRule, pattern: event.target.value }); setPreview(null); }} /></label>
                <label className="manager-field"><span>{t("classification.category")}</span><select className="with-chevron" value={newRule.category_id} onChange={(event) => setNewRule({ ...newRule, category_id: Number(event.target.value) })}>{manageable.map((category) => <option key={category.id} value={category.id}>{category.full_path}</option>)}</select></label>
                <label className="manager-field"><span>{t("manager.priority")}</span><input type="number" step="1" value={newRule.priority} onChange={(event) => setNewRule({ ...newRule, priority: Number(event.target.value) })} /></label>
                <label className="manager-toggle"><input type="checkbox" checked={newRule.case_insensitive} onChange={(event) => setNewRule({ ...newRule, case_insensitive: event.target.checked })} />{t("manager.caseInsensitive")}</label>
                <div className="manager-form-actions"><button type="button" className="manager-cancel-button" onClick={() => void previewRule()}>{t("manager.preview")}</button><button type="submit" className="manager-submit-button" disabled={saving || newRule.category_id === 0}>{t("common.create")}</button></div>
                {preview && <p className={preview.broad_warning ? "rule-broad-warning" : "manager-form-hint"}>{preview.broad_warning && `${t("manager.broadWarning")} · `}{t("manager.previewResult", { matched: preview.matched_values, total: preview.total_values, duration: formatDuration(preview.matched_duration_ms) })}</p>}
              </form>
              <div className="manager-list rule-list">{rules.map((rule) => <div className="rule-manager-row rule-manager-edit" key={rule.id}>
                <select className="with-chevron" value={rule.match_mode} onChange={(event) => void saveRule({ ...rule, match_mode: event.target.value as RuleMatchMode }, rule.id)}><option value="legacy">legacy</option><option value="regex">regex</option></select>
                <input className="rule-pattern-input" value={rule.pattern} onChange={(event) => setRules((current) => current.map((item) => item.id === rule.id ? { ...item, pattern: event.target.value } : item))} onBlur={() => void saveRule(rule, rule.id)} />
                <select className="with-chevron" value={rule.category_id} onChange={(event) => void saveRule({ ...rule, category_id: Number(event.target.value) }, rule.id)}>{manageable.map((category) => <option key={category.id} value={category.id}>{category.full_path}</option>)}</select>
                <label className="rule-case"><input type="checkbox" checked={rule.case_insensitive} onChange={(event) => void saveRule({ ...rule, case_insensitive: event.target.checked }, rule.id)} />Aa</label>
                <button type="button" className="manager-delete-button" onClick={() => void removeRule(rule.id)}>🗑</button>
              </div>)}</div>
            </div>
          )}
        </div>
        {error && <p className="settings-error manager-error">{error}</p>}
        <div className="settings-actions manager-done-actions"><button className="settings-done" disabled={saving} onClick={onClose}>{t("common.done")}</button></div>
      </section>
    </div>
  );
}
