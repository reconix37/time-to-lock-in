import type { ProgressOverview } from "../progress";
import type { KindLabels } from "../share";
import { localeForLang } from "../i18n";
import { useI18n } from "../i18nContext";

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
  const { t } = useI18n();
  const thresholdMs = thresholdMin * 60_000;
  const ratio = thresholdMs === 0 ? (valueMs > 0 ? 1.25 : 0) : valueMs / thresholdMs;
  const width = Math.min(ratio, 1.25) / 1.25 * 100;
  const overflowMin = Math.max(0, Math.floor((valueMs - thresholdMs) / 60_000));
  let status = passed ? t("score.complete") : t("score.incomplete");
  let state = passed ? "ok" : "bad";
  if (kind === "waste") {
    if (valueMs > thresholdMs) {
      status = t("score.limitExceeded", { minutes: overflowMin });
      state = "bad";
    } else if (thresholdMs > 0 && ratio >= 0.8) {
      status = t("score.nearLimit");
      state = "warn";
    } else {
      status = t("score.belowLimit");
      state = "ok";
    }
  }

  return (
    <div className={`score-bullet kind-${kind} state-${state}`}>
      <div className="score-bullet-heading">
        <span>{label}</span>
        <strong>{Math.floor(valueMs / 60_000)}{t("common.minutesShort")} <small>/ {thresholdMin}{t("common.minutesShort")}</small></strong>
      </div>
      <div className="score-bullet-rail" aria-hidden="true">
        <i style={{ width: `${width}%` }} />
        <span className="score-threshold" />
      </div>
      <span className="score-status"><b aria-hidden="true">{state === "ok" ? "✓" : state === "warn" ? "!" : "×"}</b>{status}</span>
    </div>
  );
}

export function DayScorecard({ overview, formatDuration, kindLabels, observedLabel }: DayScorecardProps) {
  const { lang, t } = useI18n();
  const { today } = overview;
  const rankSpan = overview.next_rank_threshold === null
    ? 1
    : overview.next_rank_threshold - overview.current_rank_threshold;
  const rankProgress = overview.next_rank_threshold === null
    ? 100
    : Math.min(100, Math.max(0, (overview.lifetime_xp - overview.current_rank_threshold) / rankSpan * 100));

  return (
    <section className="card scorecard-card" aria-labelledby="scorecard-title">
      <div className="card-heading scorecard-heading">
        <div><span className="eyebrow">{t("score.eyebrow")}</span><h2 id="scorecard-title">{t("score.conditions")}</h2></div>
        <span className={`day-verdict ${today.passed ? "is-passed" : ""}`}>
          {today.passed ? t("score.passed") : t("score.inProgress")}
        </span>
      </div>
      <div className="score-bullets">
        <Bullet kind="useful" label={kindLabels.useful} valueMs={today.useful_ms} thresholdMin={today.useful_goal_min} passed={today.useful_passed} />
        <Bullet kind="waste" label={kindLabels.waste} valueMs={today.waste_ms} thresholdMin={today.waste_limit_min} passed={today.waste_passed} />
        <Bullet kind="observed" label={observedLabel ?? kindLabels.observed} valueMs={today.observed_ms} thresholdMin={today.observed_min} passed={today.observed_passed} />
      </div>
      <p className="scorecard-afk">AFK: <strong>{formatDuration(overview.today_afk_ms)}</strong></p>
      <div className="rank-panel">
        <div className="rank-copy">
          <span className="eyebrow">{t("common.publicXp")}</span>
          <strong>{overview.lifetime_xp.toLocaleString(localeForLang(lang))} XP</strong>
          <span>{overview.current_rank}</span>
        </div>
        <div className="rank-progress">
          <div><span>{overview.next_rank ? t("rank.next", { name: overview.next_rank }) : t("rank.maximum")}</span><strong>{overview.next_rank_threshold === null ? "MAX" : `${overview.next_rank_threshold - overview.lifetime_xp} XP`}</strong></div>
          <span className="rank-rail"><i style={{ width: `${rankProgress}%` }} /></span>
          <small>{t("rank.today", { duration: formatDuration(today.useful_ms), label: kindLabels.useful })}</small>
        </div>
      </div>
    </section>
  );
}
