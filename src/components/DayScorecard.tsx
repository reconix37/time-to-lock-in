import type { ProgressOverview } from "../progress";
import type { KindLabels } from "../share";

interface DayScorecardProps {
  overview: ProgressOverview;
  formatDuration: (milliseconds: number) => string;
  kindLabels: KindLabels;
  observedLabel?: string;
}

interface BulletProps {
  kind: "useful" | "waste" | "observed";
  label: string;
  valueMs: number;
  thresholdMin: number;
  passed: boolean;
}

function Bullet({ kind, label, valueMs, thresholdMin, passed }: BulletProps) {
  const thresholdMs = thresholdMin * 60_000;
  const ratio = thresholdMs === 0 ? (valueMs > 0 ? 1.25 : 0) : valueMs / thresholdMs;
  const width = Math.min(ratio, 1.25) / 1.25 * 100;
  const overflowMin = Math.max(0, Math.floor((valueMs - thresholdMs) / 60_000));
  let status = passed ? "выполнено" : "не выполнено";
  let state = passed ? "ok" : "bad";
  if (kind === "waste") {
    if (valueMs > thresholdMs) {
      status = `лимит превышен на ${overflowMin}м`;
      state = "bad";
    } else if (thresholdMs > 0 && ratio >= 0.8) {
      status = "рядом с лимитом";
      state = "warn";
    } else {
      status = "ниже лимита";
      state = "ok";
    }
  }

  return (
    <div className={`score-bullet kind-${kind} state-${state}`}>
      <div className="score-bullet-heading">
        <span>{label}</span>
        <strong>{Math.floor(valueMs / 60_000)}м <small>/ {thresholdMin}м</small></strong>
      </div>
      <div className="score-bullet-rail" aria-hidden="true">
        <i style={{ width: `${width}%` }} />
        <span className="score-threshold" />
      </div>
      <span className="score-status"><b aria-hidden="true">{state === "ok" ? "✓" : state === "warn" ? "!" : "×"}</b>{status}</span>
    </div>
  );
}

export function DayScorecard({ overview, formatDuration, kindLabels, observedLabel = "Наблюдение" }: DayScorecardProps) {
  const { today } = overview;
  const usefulTodayLabel = kindLabels.useful === "Полезное"
    ? "полезного"
    : kindLabels.useful;
  const rankSpan = overview.next_rank_threshold === null
    ? 1
    : overview.next_rank_threshold - overview.current_rank_threshold;
  const rankProgress = overview.next_rank_threshold === null
    ? 100
    : Math.min(100, Math.max(0, (overview.lifetime_xp - overview.current_rank_threshold) / rankSpan * 100));

  return (
    <section className="card scorecard-card" aria-labelledby="scorecard-title">
      <div className="card-heading scorecard-heading">
        <div><span className="eyebrow">Зачёт дня</span><h2 id="scorecard-title">Три условия</h2></div>
        <span className={`day-verdict ${today.passed ? "is-passed" : ""}`}>
          {today.passed ? "День зачтён" : "День в процессе"}
        </span>
      </div>
      <div className="score-bullets">
        <Bullet kind="useful" label={kindLabels.useful} valueMs={today.useful_ms} thresholdMin={today.useful_goal_min} passed={today.useful_passed} />
        <Bullet kind="waste" label={kindLabels.waste} valueMs={today.waste_ms} thresholdMin={today.waste_limit_min} passed={today.waste_passed} />
        <Bullet kind="observed" label={observedLabel} valueMs={today.observed_ms} thresholdMin={today.observed_min} passed={today.observed_passed} />
      </div>
      <p className="scorecard-afk">AFK: <strong>{formatDuration(overview.today_afk_ms)}</strong></p>
      <div className="rank-panel">
        <div className="rank-copy">
          <span className="eyebrow">Public XP</span>
          <strong>{overview.lifetime_xp.toLocaleString("ru-RU")} XP</strong>
          <span>{overview.current_rank}</span>
        </div>
        <div className="rank-progress">
          <div><span>{overview.next_rank ? `До ранга «${overview.next_rank}»` : "Максимальный ранг"}</span><strong>{overview.next_rank_threshold === null ? "MAX" : `${overview.next_rank_threshold - overview.lifetime_xp} XP`}</strong></div>
          <span className="rank-rail"><i style={{ width: `${rankProgress}%` }} /></span>
          <small>Сегодня: {formatDuration(today.useful_ms)} {usefulTodayLabel}</small>
        </div>
      </div>
    </section>
  );
}
