import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { KindLabels } from "../share";
import { useI18n } from "../i18nContext";
import { CATEGORY_ICONS, CategoryIcon, CategoryMark } from "./CategoryIcon";
import {
  nextSelectionAfterDelete,
  rulesActionView,
  sameRuleSignature,
  type ManagerView,
} from "../categoryManagerModel";

export type CategoryKind = "useful" | "neutral" | "waste";
export type RuleMatchType = "exe" | "title" | "domain" | "any";
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

interface ReclassificationSummary {
  changed_segments: number;
  changed_duration_ms: number;
}

interface Props {
  open: boolean;
  categories: Category[];
  kindLabels: KindLabels;
  formatDuration: (durationMs: number) => string;
  observedMs: number;
  appCount: number;
  uncategorizedMs: number;
  onClose: () => void;
  onCategoriesChange: (categories: Category[]) => void;
  onDashboardRefresh: () => Promise<void>;
}

type CategoryDraft = Omit<Category, "id" | "effective_color" | "effective_score" | "full_path">;
type RuleDraft = Omit<Rule, "id" | "priority"> & { id?: number; priority?: number };

const COLORS = [
  { id: "pine", value: "#286983" },
  { id: "gold", value: "#ea9d34" },
  { id: "love", value: "#b4637a" },
  { id: "foam", value: "#56949f" },
  { id: "iris", value: "#907aa9" },
  { id: "muted", value: "#9893a5" },
  { id: "rose", value: "#d7827e" },
  { id: "brightPine", value: "#3e8fb0" },
  { id: "brightGold", value: "#f6c177" },
  { id: "brightLove", value: "#eb6f92" },
  { id: "brightFoam", value: "#9ccfd8" },
  { id: "brightIris", value: "#c4a7e7" },
] as const;
const EMPTY_CATEGORY: CategoryDraft = {
  name: "",
  color: COLORS[3].value,
  icon: "coffee",
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
    match_type: "any",
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

type ScoreValidation =
  | { value: number; error: null }
  | { value: null; error: "validation.scoreInvalid" | "validation.scoreRange" | "validation.scorePrecision" };

function validateScoreInput(input: string): ScoreValidation {
  const normalized = input.replace(",", ".");
  if (!/^[+-]?\d+(?:\.\d*)?$/.test(normalized)) {
    return { value: null, error: "validation.scoreInvalid" };
  }
  if (/\.\d{2,}$/.test(normalized)) {
    return { value: null, error: "validation.scorePrecision" };
  }
  const value = Number(normalized);
  if (!Number.isFinite(value)) {
    return { value: null, error: "validation.scoreInvalid" };
  }
  if (value < -10 || value > 10) {
    return { value: null, error: "validation.scoreRange" };
  }
  return { value: Object.is(value, -0) ? 0 : value, error: null };
}

function normalizedScoreText(score: number): string {
  return Number.isInteger(score) ? score.toFixed(0) : score.toFixed(1);
}

function normalizePattern(pattern: string): string {
  return pattern.trim().replace(/\r\n|\r|\n/g, " ");
}

function viewCategoryId(view: ManagerView): number | null {
  if (view.type === "category" || view.type === "rules" || view.type === "newRule") return view.categoryId;
  return null;
}

export function CategoryManager({
  open,
  categories,
  kindLabels,
  formatDuration,
  observedMs,
  appCount,
  uncategorizedMs,
  onClose,
  onCategoriesChange,
  onDashboardRefresh,
}: Props) {
  const { t } = useI18n();
  const [rules, setRules] = useState<Rule[]>([]);
  const [view, setView] = useState<ManagerView>({ type: "category", categoryId: 0 });
  const [categoryDraft, setCategoryDraft] = useState<CategoryDraft>({ ...EMPTY_CATEGORY });
  const [scoreInput, setScoreInput] = useState("0");
  const [ruleDraft, setRuleDraft] = useState<RuleDraft>(emptyRule(0));
  const [preview, setPreview] = useState<RulePreview | null>(null);
  const [historyPreview, setHistoryPreview] = useState<ReclassificationSummary | null>(null);
  const [previewPending, setPreviewPending] = useState(false);
  const [patternError, setPatternError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [repaintEnabled, setRepaintEnabled] = useState(false);
  const [overwriteManual, setOverwriteManual] = useState(false);
  const previewRequest = useRef(0);
  const historyPreviewRequest = useRef(0);

  const manageable = useMemo(() => categories.filter((category) => category.id !== 0), [categories]);
  const selectedCategoryId = viewCategoryId(view);
  const selectedCategory = useMemo(
    () => categories.find((category) => category.id === selectedCategoryId) ?? null,
    [categories, selectedCategoryId],
  );
  const nextPriority = useMemo(() => Math.max(0, ...rules.map((rule) => rule.priority)) + 1, [rules]);
  const duplicate = useMemo(
    () => rules.find((rule) => rule.id !== ruleDraft.id && sameRuleSignature(
      { ...rule, pattern: normalizePattern(rule.pattern) },
      { ...ruleDraft, pattern: normalizePattern(ruleDraft.pattern) },
    )) ?? null,
    [ruleDraft, rules],
  );
  const visibleRules = useMemo(() => {
    if (view.type === "allRules") return rules;
    const categoryId = viewCategoryId(view);
    return categoryId === null ? [] : rules.filter((rule) => rule.category_id === categoryId);
  }, [rules, view]);
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

  async function reload(preferredView?: ManagerView) {
    const [nextCategories, nextRules] = await Promise.all([
      invoke<Category[]>("get_categories"),
      invoke<Rule[]>("get_rules"),
    ]);
    onCategoriesChange(nextCategories);
    setRules(nextRules);
    setView((current) => {
      const candidate = preferredView ?? current;
      const categoryId = viewCategoryId(candidate);
      if (categoryId === null || categoryId === 0 || nextCategories.some((category) => category.id === categoryId)) return candidate;
      return { type: "category", categoryId: 0 };
    });
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
    if (view.type !== "category" || view.categoryId === 0) return;
    const category = categories.find((item) => item.id === view.categoryId);
    if (category) {
      setCategoryDraft({ ...category });
      setScoreInput(normalizedScoreText(category.score));
    }
  }, [categories, view]);

  useEffect(() => {
    if (view.type !== "newRule" || !ruleDraft.pattern.trim()) {
      setPreview(null);
      setPreviewPending(false);
      if (!ruleDraft.pattern.trim()) setPatternError(null);
      return;
    }
    setPreviewPending(true);
    const requestId = ++previewRequest.current;
    const timeout = window.setTimeout(() => {
      void invoke<RulePreview>("preview_rule", {
        matchType: ruleDraft.match_type,
        pattern: normalizePattern(ruleDraft.pattern),
        matchMode: ruleDraft.match_mode,
        caseInsensitive: ruleDraft.case_insensitive,
      }).then((result) => {
        if (previewRequest.current !== requestId) return;
        setPreview(result);
        setPatternError(null);
      }).catch((reason: unknown) => {
        if (previewRequest.current !== requestId) return;
        setPreview(null);
        setPatternError(errorText(reason, "validation.regex"));
      }).finally(() => {
        if (previewRequest.current === requestId) setPreviewPending(false);
      });
    }, 250);
    return () => {
      previewRequest.current += 1;
      window.clearTimeout(timeout);
    };
  }, [ruleDraft.case_insensitive, ruleDraft.match_mode, ruleDraft.match_type, ruleDraft.pattern, view.type]);

  useEffect(() => {
    if (view.type !== "allRules") return;
    setHistoryPreview(null);
    const requestId = ++historyPreviewRequest.current;
    void invoke<ReclassificationSummary>("preview_reclassify_history", { overwriteManual })
      .then((result) => {
        if (historyPreviewRequest.current === requestId) setHistoryPreview(result);
      })
      .catch((reason: unknown) => {
        if (historyPreviewRequest.current === requestId) setError(errorText(reason, "error.repaintHistory"));
      });
    return () => {
      historyPreviewRequest.current += 1;
    };
  }, [overwriteManual, rules, view.type]);

  useEffect(() => {
    if (!open) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !saving) onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose, open, saving]);

  async function saveCategory(category: CategoryDraft, id?: number) {
    const scoreValidation = validateScoreInput(scoreInput || normalizedScoreText(category.score));
    if (scoreValidation.error !== null) return;
    const normalizedCategory = { ...category, score: scoreValidation.value };
    setCategoryDraft(normalizedCategory);
    setScoreInput(normalizedScoreText(scoreValidation.value));
    setSaving(true);
    setError(null);
    try {
      const saved = await invoke<Category>(id === undefined ? "create_category" : "update_category", {
        ...(id === undefined ? {} : { id }),
        name: normalizedCategory.name.trim(),
        color: normalizedCategory.color,
        icon: normalizedCategory.icon,
        kind: normalizedCategory.kind,
        parentId: normalizedCategory.parent_id,
        score: normalizedCategory.score,
        inheritColor: normalizedCategory.parent_id !== null && normalizedCategory.inherit_color,
        inheritScore: normalizedCategory.parent_id !== null && normalizedCategory.inherit_score,
      });
      await reload({ type: "category", categoryId: saved.id });
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
      const nextId = nextSelectionAfterDelete(category, manageable.filter((item) => item.id !== category.id));
      await reload({ type: "category", categoryId: nextId });
      await onDashboardRefresh();
    } catch (reason: unknown) {
      setError(typeof reason === "string" ? reason : t("error.deleteCategory"));
    } finally {
      setSaving(false);
    }
  }

  async function saveRule() {
    const normalizedPattern = normalizePattern(ruleDraft.pattern);
    if (!normalizedPattern) {
      setPatternError(t("validation.patternRequired"));
      return;
    }
    if (ruleDraft.category_id === 0) {
      setPatternError(t("validation.categoryRequired"));
      return;
    }
    if (duplicate) {
      setPatternError(t("validation.ruleDuplicate", { category: categoryName(duplicate.category_id) }));
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const editing = ruleDraft.id !== undefined;
      await invoke(editing ? "update_rule" : "create_rule", {
        ...(editing ? { id: ruleDraft.id } : {}),
        matchType: ruleDraft.match_type,
        pattern: normalizedPattern,
        categoryId: ruleDraft.category_id,
        priority: ruleDraft.priority ?? nextPriority,
        matchMode: ruleDraft.match_mode,
        caseInsensitive: ruleDraft.case_insensitive,
      });
      const targetView: ManagerView = view.type === "newRule" && view.returnTo === "allRules"
        ? { type: "allRules" }
        : view.type === "newRule" && view.categoryId !== 0
          ? { type: "rules", categoryId: ruleDraft.category_id }
          : { type: "rules", categoryId: ruleDraft.category_id };
      await reload(targetView);
      setPatternError(null);
      setPreview(null);
    } catch (reason: unknown) {
      setPatternError(errorText(reason, editingRuleFallback(ruleDraft.id)));
    } finally {
      setSaving(false);
    }
  }

  function editingRuleFallback(id: number | undefined): string {
    return id === undefined ? "error.createRule" : "error.changeRule";
  }

  async function removeRule(rule: Rule) {
    if (!window.confirm(t("manager.confirmDeleteRule", { pattern: rule.pattern }))) return;
    setSaving(true);
    setError(null);
    try {
      await invoke("delete_rule", { id: rule.id });
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
    if (!repaintEnabled || !window.confirm(t("manager.confirmRepaintAll"))) return;
    setSaving(true);
    setError(null);
    try {
      await invoke("reclassify_history", {
        overwriteManual,
        manualMatchType: null,
        manualPattern: null,
        confirmed: true,
      });
      setRepaintEnabled(false);
      setOverwriteManual(false);
      await onDashboardRefresh();
      setHistoryPreview(await invoke<ReclassificationSummary>("preview_reclassify_history", { overwriteManual: false }));
    } catch (reason: unknown) {
      setError(typeof reason === "string" ? reason : t("error.repaintHistory"));
    } finally {
      setSaving(false);
    }
  }

  function selectCategory(categoryId: number) {
    setView({ type: "category", categoryId });
    setPatternError(null);
  }

  function openRules(categoryId: number) {
    if (categoryId === 0) setRuleDraft(emptyRule(0));
    setView(rulesActionView(categoryId));
    setPatternError(null);
  }

  function startRule(categoryId: number, rule?: Rule, returnTo: "rules" | "allRules" = "rules") {
    setRuleDraft(rule ? { ...rule } : emptyRule(categoryId));
    setPatternError(null);
    setPreview(null);
    setView({ type: "newRule", categoryId, returnTo });
  }

  function renderCategoryForm(category: CategoryDraft, id?: number) {
    const colorValid = /^#[0-9a-f]{6}$/i.test(category.color);
    const scoreValidation = validateScoreInput(scoreInput);
    const normalizeScore = () => {
      const fallback = normalizedScoreText(category.score);
      const validation = validateScoreInput(scoreInput || fallback);
      if (validation.error !== null) return;
      setCategoryDraft({ ...category, score: validation.value });
      setScoreInput(normalizedScoreText(validation.value));
    };
    const stepScore = (direction: -1 | 1) => {
      const current = scoreValidation.error === null ? scoreValidation.value : category.score;
      const next = Math.max(-10, Math.min(10, Math.round((current + direction * 0.1) * 10) / 10));
      setCategoryDraft({ ...category, score: next });
      setScoreInput(normalizedScoreText(next));
    };
    return (
      <form className="manager-form category-edit-form" noValidate onSubmit={(event) => { event.preventDefault(); void saveCategory(category, id); }}>
        <label className="manager-field"><span>{t("manager.name")}</span><input autoComplete="off" spellCheck={false} required maxLength={80} placeholder={t("manager.exampleStudy")} value={category.name} onChange={(event) => setCategoryDraft({ ...category, name: event.target.value })} /></label>
        <label className="manager-field"><span>{t("manager.parent")}</span><select className="with-chevron" value={category.parent_id ?? ""} onChange={(event) => { const parentId = event.target.value ? Number(event.target.value) : null; setCategoryDraft({ ...category, parent_id: parentId, inherit_color: parentId !== null && (id !== undefined ? category.inherit_color : true), inherit_score: parentId !== null && (id !== undefined ? category.inherit_score : true) }); }}><option value="">{t("manager.noParent")}</option>{manageable.filter((item) => item.id !== id && !(selectedCategory && item.full_path.startsWith(`${selectedCategory.full_path} > `))).map((item) => <option key={item.id} value={item.id}>{item.full_path}</option>)}</select></label>
        <label className="manager-field"><span>{t("manager.type")}</span><select className="with-chevron" value={category.kind} onChange={(event) => { const kind = event.target.value as CategoryKind; const score = id === undefined && category.parent_id === null ? (kind === "useful" ? 10 : kind === "waste" ? -10 : 0) : category.score; const icon = id === undefined ? (kind === "useful" ? "briefcase" : kind === "waste" ? "skull" : "coffee") : category.icon; setCategoryDraft({ ...category, kind, score, icon }); setScoreInput(normalizedScoreText(score)); }}><option value="useful">{kindLabels.useful}</option><option value="neutral">{kindLabels.neutral}</option><option value="waste">{kindLabels.waste}</option></select></label>
        <label className="manager-field"><span>{t("manager.score")}</span><input type="text" inputMode="decimal" maxLength={5} disabled={category.inherit_score} value={scoreInput} aria-invalid={scoreValidation.error !== null} aria-describedby="category-score-error" onChange={(event) => setScoreInput(event.target.value)} onBlur={normalizeScore} onKeyDown={(event) => { if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return; event.preventDefault(); stepScore(event.key === "ArrowUp" ? 1 : -1); }} />{scoreValidation.error !== null && <small id="category-score-error" className="manager-field-error">{t(scoreValidation.error)}</small>}</label>
        <p className="category-model-hint">{t("manager.kindScoreHint")}</p>
        <div className="manager-toggle-list">
          <label className="manager-toggle"><input type="checkbox" disabled={category.parent_id === null} checked={category.inherit_color} onChange={(event) => setCategoryDraft({ ...category, inherit_color: event.target.checked })} /><span><strong>{t("manager.inheritColor")}</strong><small>{t("manager.inheritColorHint")}</small></span></label>
          <label className="manager-toggle"><input type="checkbox" disabled={category.parent_id === null} checked={category.inherit_score} onChange={(event) => setCategoryDraft({ ...category, inherit_score: event.target.checked })} /><span><strong>{t("manager.inheritScore")}</strong><small>{t("manager.inheritScoreHint")}</small></span></label>
        </div>
        <div className="manager-color-field"><span>{t("manager.color")}</span><div className="manager-color-controls"><div className="color-presets">{COLORS.map((color) => <button key={color.id} type="button" disabled={category.inherit_color} aria-label={t(`manager.color.${color.id}`)} aria-pressed={color.value === category.color} className={category.color === color.value ? "is-selected" : ""} style={{ backgroundColor: color.value }} onClick={() => setCategoryDraft({ ...category, color: color.value })} />)}</div><label className="manager-field manager-custom-color"><span>{t("manager.customColor")}</span><input type="text" autoComplete="off" spellCheck={false} disabled={category.inherit_color} maxLength={7} value={category.color} aria-invalid={!colorValid} onChange={(event) => setCategoryDraft({ ...category, color: event.target.value })} /></label></div></div>
        <div className="manager-icon-field"><span>{t("manager.icon")}</span><div className="manager-icon-picker"><button type="button" aria-pressed={category.icon === ""} className={category.icon === "" ? "is-selected" : ""} onClick={() => setCategoryDraft({ ...category, icon: "" })}>{t("manager.icon.none")}</button>{Object.keys(CATEGORY_ICONS).map((icon) => <button key={icon} type="button" aria-label={t(`manager.icon.${icon}`)} aria-pressed={category.icon === icon} className={category.icon === icon ? "is-selected" : ""} onClick={() => setCategoryDraft({ ...category, icon })}><CategoryIcon icon={icon} size={18} /></button>)}</div></div>
        <div className="manager-form-actions"><button type="button" className="manager-cancel-button" onClick={() => id === undefined ? setView({ type: "category", categoryId: 0 }) : selectCategory(id)}>{t("common.cancel")}</button><button type="submit" className="manager-submit-button" disabled={saving || !category.name.trim() || !colorValid || scoreValidation.error !== null}>{t("common.save")}</button></div>
      </form>
    );
  }

  function renderRuleForm() {
    const placeholder = ruleDraft.match_type === "any" ? "tiktok, reddit, youtube" : ruleDraft.match_type === "exe" ? "Code.exe" : ruleDraft.match_type === "domain" ? "youtube.com" : "Blender tutorial";
    const resizePatternField = (field: HTMLTextAreaElement) => {
      field.style.height = "auto";
      field.style.height = `${Math.min(field.scrollHeight, 136)}px`;
    };
    const cancelView: ManagerView = view.type === "newRule" && view.returnTo === "allRules"
      ? { type: "allRules" }
      : view.type === "newRule" && view.categoryId === 0
        ? { type: "category", categoryId: 0 }
        : { type: "rules", categoryId: view.type === "newRule" ? view.categoryId : ruleDraft.category_id };
    return (
      <form className="manager-form rule-sentence-form" noValidate onSubmit={(event) => { event.preventDefault(); void saveRule(); }}>
        <div className="rule-sentence-fields">
          <div className="rule-condition-row"><span>{t("manager.if")}</span><label className="manager-field manager-field-inline"><span>{t("manager.source")}</span><select className="with-chevron" value={ruleDraft.match_type} onChange={(event) => setRuleDraft({ ...ruleDraft, match_type: event.target.value as RuleMatchType })}><option value="any">{t("manager.sourceAny")}</option><option value="exe">{t("manager.sourceApp")}</option><option value="title">{t("manager.sourceTitle")}</option><option value="domain">{t("manager.sourceWebsite")}</option></select></label><span>{ruleDraft.match_mode === "regex" ? t("manager.matchesExpression") : t("manager.contains")}</span></div>
          <label className="rule-search-field"><span>{t("manager.whatToFind")}</span><textarea ref={(field) => { if (field) resizePatternField(field); }} rows={2} autoComplete="off" spellCheck={false} maxLength={500} placeholder={placeholder} value={ruleDraft.pattern} aria-invalid={patternError !== null || duplicate !== null} aria-describedby="rule-pattern-state" onInput={(event) => resizePatternField(event.currentTarget)} onChange={(event) => { const pattern = event.target.value; setRuleDraft({ ...ruleDraft, pattern, match_mode: ruleDraft.match_type === "any" && ruleDraft.match_mode === "legacy" && /[|,\\]/.test(pattern) ? "regex" : ruleDraft.match_mode }); setPatternError(null); }} /></label>
          <div className="rule-category-row"><span aria-hidden="true">→</span><span>{t("manager.assignCategory")}</span><label className="manager-field manager-field-inline manager-category-select"><span>{t("manager.assignCategory")}</span><select className="with-chevron" value={ruleDraft.category_id || ""} onChange={(event) => setRuleDraft({ ...ruleDraft, category_id: Number(event.target.value) })}><option value="" disabled>{t("manager.chooseCategory")}</option>{manageable.map((category) => <option key={category.id} value={category.id}>{category.full_path}</option>)}</select></label></div>
        </div>
        <p className="rule-field-help">{t("manager.ruleHint")}</p>
        <p id="rule-pattern-state" className={patternError || duplicate ? "rule-field-error" : preview ? "rule-field-valid" : "rule-field-help"}>{patternError ?? (duplicate ? t("validation.ruleDuplicate", { category: categoryName(duplicate.category_id) }) : preview ? t("manager.patternValid") : "")}</p>
        <details className="rule-advanced">
          <summary>{t("settings.advanced")}</summary>
          <div className="rule-toggle-list">
            <label className="rule-toggle-row"><input type="checkbox" checked={ruleDraft.match_mode === "regex"} onChange={(event) => setRuleDraft({ ...ruleDraft, match_mode: event.target.checked ? "regex" : "legacy" })} /><span><strong>{t("manager.useRegex")}</strong><small>{t("manager.useRegexHint")}</small></span></label>
            <label className="rule-toggle-row"><input type="checkbox" checked={ruleDraft.case_insensitive} onChange={(event) => setRuleDraft({ ...ruleDraft, case_insensitive: event.target.checked })} /><span><strong>{t("manager.caseInsensitive")}</strong><small>{t("manager.caseInsensitiveHint")}</small></span></label>
          </div>
        </details>
        <div className={`rule-preview ${preview?.broad_warning ? "is-warning" : ""}`} aria-live="polite">{previewPending ? t("manager.previewLoading") : preview ? <>{preview.broad_warning && <span>{t("manager.broadWarning")} · </span>}{t("manager.livePreview", { count: preview.matched_values, duration: formatDuration(preview.matched_duration_ms) })}</> : t("manager.previewEmpty")}</div>
        <div className="manager-form-actions"><button type="button" className="manager-cancel-button" onClick={() => { setView(cancelView); setPatternError(null); }}>{t("common.cancel")}</button><button type="submit" className="manager-submit-button" disabled={saving || ruleDraft.category_id === 0 || !ruleDraft.pattern.trim() || duplicate !== null || patternError !== null}>{ruleDraft.id === undefined ? t("manager.addRule") : t("common.save")}</button></div>
      </form>
    );
  }

  function renderRulesList() {
    if (visibleRules.length === 0) return <p className="manager-empty">{t("manager.noRules")}</p>;
    return (
      <div className="rule-card-list">
        {visibleRules.map((rule) => {
          const globalIndex = rules.findIndex((item) => item.id === rule.id);
          return (
            <article className="rule-card" key={rule.id}>
              <p className="rule-card-sentence"><strong>{t(rule.match_type === "any" ? "manager.sourceAny" : rule.match_type === "exe" ? "manager.sourceApp" : rule.match_type === "domain" ? "manager.sourceWebsite" : "manager.sourceTitle")}</strong> {t(rule.match_mode === "regex" ? "manager.matchesExpression" : "manager.contains")} <q>{rule.pattern}</q> <span aria-hidden="true">→</span> <strong>{categoryName(rule.category_id)}</strong></p>
              <div className="rule-card-badges"><span>{t(rule.match_mode === "regex" ? "manager.regularExpression" : "manager.normalSearch")}</span>{rule.case_insensitive && <span>{t("manager.caseInsensitive")}</span>}</div>
              <div className="rule-card-actions">
                {view.type === "allRules" && <><button type="button" disabled={saving || globalIndex === 0} onClick={() => void moveRule(globalIndex, -1)}>{t("manager.earlier")}</button><button type="button" disabled={saving || globalIndex === rules.length - 1} onClick={() => void moveRule(globalIndex, 1)}>{t("manager.later")}</button></>}
                <button type="button" onClick={() => startRule(rule.category_id, rule, view.type === "allRules" ? "allRules" : "rules")}>{t("common.edit")}</button>
                <button type="button" className="is-danger" onClick={() => void removeRule(rule)}>{t("common.delete")}</button>
              </div>
            </article>
          );
        })}
      </div>
    );
  }

  if (!open) return null;
  const uncategorizedPercent = observedMs > 0 ? Math.round((uncategorizedMs / observedMs) * 100) : 0;

  return (
    <div className="category-dialog-overlay">
      <section className="category-dialog" role="dialog" aria-modal="true" aria-labelledby="category-dialog-title">
        <header className="category-dialog-heading"><div><span className="eyebrow">{t("manager.eyebrow")}</span><h2 id="category-dialog-title">{t("manager.title")}</h2></div><button type="button" className="manager-close" aria-label={t("common.close")} onClick={onClose}>×</button></header>
        <div className="all-activity-bar"><strong>{t("manager.allActivity")}</strong><span>{t("manager.allActivityStats", { duration: formatDuration(observedMs), apps: appCount, percent: uncategorizedPercent })}</span><small>{t("manager.allActivityHint")}</small></div>
        {loading ? <div className="manager-loading skeleton" /> : (
          <div className="category-manager">
            <aside className="category-master">
              <div className="category-tree">
                <div className={`category-special-row ${selectedCategoryId === 0 ? "is-selected" : ""}`}><span className="manager-color-dot" /><button type="button" className="category-special-main" onClick={() => selectCategory(0)}><strong>{t("manager.needsSorting")}</strong><small>{t("common.uncategorized")}</small></button><button type="button" className="manager-rules-link" onClick={() => openRules(0)}>{t("manager.addRule")}</button></div>
                {visibleCategories.map(({ category, depth }) => {
                  const childCount = childrenByParent.get(category.id)?.length ?? 0;
                  const categoryRuleCount = rules.filter((rule) => rule.category_id === category.id).length;
                  return (
                    <div className="category-tree-node" key={category.id} style={{ "--tree-indent": `${depth * 20}px` } as CSSProperties}>
                      <div className={`category-tree-row ${selectedCategoryId === category.id ? "is-selected" : ""}`}>
                        <button type="button" className="tree-disclosure" disabled={childCount === 0} aria-label={t("manager.toggleChildren", { category: category.name })} onClick={() => setCollapsed((current) => { const next = new Set(current); if (next.has(category.id)) next.delete(category.id); else next.add(category.id); return next; })}>{childCount ? (collapsed.has(category.id) ? "›" : "⌄") : "·"}</button>
                        <CategoryMark icon={category.icon} color={category.effective_color} />
                        <button type="button" className="category-tree-main" title={category.full_path} onClick={() => selectCategory(category.id)}><strong>{category.name}</strong><small title={category.full_path}>{category.full_path}</small></button>
                        <span className={`category-score ${category.effective_score > 0 ? "is-positive" : category.effective_score < 0 ? "is-negative" : ""}`}>{scoreText(category.effective_score)}</span>
                        <button type="button" className="manager-rules-link" onClick={() => openRules(category.id)}>{t("manager.rules")} {categoryRuleCount > 0 ? `· ${categoryRuleCount}` : ""}</button>
                      </div>
                    </div>
                  );
                })}
              </div>
              <div className="category-master-actions"><button type="button" onClick={() => { setCategoryDraft({ ...EMPTY_CATEGORY }); setScoreInput(normalizedScoreText(EMPTY_CATEGORY.score)); setView({ type: "newCategory" }); }}>{t("manager.addCategory")}</button><button type="button" className={view.type === "allRules" ? "is-selected" : ""} onClick={() => { setView({ type: "allRules" }); setRepaintEnabled(false); setOverwriteManual(false); }}>{t("manager.allRules")}</button></div>
            </aside>

            <main className="category-detail">
              <button type="button" className="category-back" onClick={() => setView({ type: "category", categoryId: selectedCategoryId ?? 0 })}>{t("manager.backToCategories")}</button>
              {view.type === "allRules" && <><div className="manager-toolbar"><div><h3>{t("manager.allRules")}</h3><p>{t("manager.ruleCount", { count: rules.length })}</p></div><button type="button" className="manager-add-button" onClick={() => startRule(0, undefined, "allRules")}>{t("manager.addRule")}</button></div><p className="rule-tiebreak">{t("manager.tieBreak")}</p>{renderRulesList()}<details className="history-repaint"><summary>{t("settings.advanced")}</summary><p>{historyPreview ? t("manager.repaintAffected", { count: historyPreview.changed_segments, duration: formatDuration(historyPreview.changed_duration_ms) }) : t("manager.previewLoading")}</p><label className="rule-toggle-row"><input type="checkbox" checked={overwriteManual} onChange={(event) => setOverwriteManual(event.target.checked)} /><span><strong>{t("manager.repaintManual")}</strong><small>{t("manager.repaintManualHint")}</small></span></label><label className="rule-toggle-row"><input type="checkbox" checked={repaintEnabled} onChange={(event) => setRepaintEnabled(event.target.checked)} /><span><strong>{t("manager.enableRepaint")}</strong><small>{t("manager.enableRepaintHint")}</small></span></label><button type="button" className="manager-submit-button" disabled={saving || !repaintEnabled || !historyPreview} onClick={() => void replayHistory()}>{t("manager.repaintHistory")}</button></details></>}
              {view.type === "newCategory" && <><div className="manager-toolbar"><h3>{t("manager.addCategory")}</h3></div>{renderCategoryForm(categoryDraft)}</>}
              {view.type === "newRule" && <><div className="manager-toolbar"><h3>{ruleDraft.id === undefined ? t("manager.addRule") : t("manager.editRule")}</h3></div>{renderRuleForm()}</>}
              {view.type === "category" && view.categoryId === 0 && <div className="needs-sorting-detail"><span className="eyebrow">{t("manager.needsSorting")}</span><h3>{t("common.uncategorized")}</h3><p>{t("manager.uncategorizedHint")}</p><button type="button" className="manager-submit-button" onClick={() => openRules(0)}>{t("manager.addRule")}</button></div>}
              {view.type === "category" && selectedCategory && selectedCategory.id !== 0 && <><div className="category-detail-heading"><div><span className="eyebrow">{t("manager.category")}</span><h3 title={selectedCategory.full_path}>{selectedCategory.full_path}</h3></div><button type="button" className="manager-text-danger" disabled={saving || (childrenByParent.get(selectedCategory.id)?.length ?? 0) > 0} onClick={() => void removeCategory(selectedCategory)}>{t("common.delete")}</button></div><div className="category-detail-tabs"><button type="button" className="is-selected">{t("manager.category")}</button><button type="button" onClick={() => openRules(selectedCategory.id)}>{t("manager.rules")}</button></div>{renderCategoryForm(categoryDraft, selectedCategory.id)}</>}
              {view.type === "rules" && <><div className="manager-toolbar"><div><h3>{t("manager.rulesFor", { category: categoryName(view.categoryId) })}</h3><p>{t("manager.ruleCount", { count: visibleRules.length })}</p></div><button type="button" className="manager-add-button" onClick={() => startRule(view.categoryId)}>{t("manager.addRule")}</button></div>{view.categoryId !== 0 && <div className="category-detail-tabs"><button type="button" onClick={() => selectCategory(view.categoryId)}>{t("manager.category")}</button><button type="button" className="is-selected">{t("manager.rules")}</button></div>}{renderRulesList()}</>}
              {error && <p className="settings-error manager-error">{error}</p>}
            </main>
          </div>
        )}
      </section>
    </div>
  );
}
