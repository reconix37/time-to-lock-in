import { useI18n } from "../i18nContext";

export interface ScoringCategory {
  category_id: number;
  name: string;
  full_path: string;
  effective_color: string;
  duration_ms: number;
  points: number;
}

export interface TodayScoring {
  total_score: number;
  productive_percent: number;
  top_productive: ScoringCategory[];
  top_distracting: ScoringCategory[];
  top_categories: ScoringCategory[];
}

interface Props {
  data: TodayScoring;
}

function points(value: number): string {
  const formatted = value.toFixed(1);
  return value > 0 ? `+${formatted}` : formatted;
}

export function ScorePanel({ data }: Props) {
  const { t } = useI18n();
  const tone = data.total_score > 0 ? "is-positive" : data.total_score < 0 ? "is-negative" : "";
  const hasBreakdown = data.top_productive.length > 0 || data.top_distracting.length > 0;
  return (
    <section className="card score-card">
      <span className="eyebrow">{t("score.total")}</span>
      <strong className={`score-total ${tone}`}>{points(data.total_score)}</strong>
      <p className="score-productive">{t("score.productivePercent", { value: data.productive_percent.toFixed(1) })}</p>
      {hasBreakdown ? (
        <div className="score-lists">
          {data.top_productive.length > 0 && <ScoreList title={t("score.topProductive")} entries={data.top_productive} />}
          {data.top_distracting.length > 0 && <ScoreList title={t("score.topDistracting")} entries={data.top_distracting} />}
        </div>
      ) : <p className="score-empty">{t("score.noData")}</p>}
    </section>
  );
}

function ScoreList({ title, entries }: { title: string; entries: ScoringCategory[] }) {
  return <div className="score-list"><h3>{title}</h3>{entries.map((entry) => <div className="score-entry" key={entry.category_id} title={entry.full_path}><span className="manager-color-dot" style={{ backgroundColor: entry.effective_color }} /><span>{entry.full_path}</span><strong className={entry.points > 0 ? "is-positive" : "is-negative"}>{points(entry.points)}</strong></div>)}</div>;
}
