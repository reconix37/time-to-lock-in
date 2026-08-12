export function formatObservedClock(milliseconds: number): string {
  const totalMinutes = Math.max(0, Math.floor(milliseconds / 60_000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return [hours, minutes].map((value) => value.toString().padStart(2, "0")).join(":");
}

export function formatCompactMinutes(minutes: number): string {
  const totalMinutes = Math.max(0, Math.floor(minutes));
  if (totalMinutes < 60) return `${totalMinutes}м`;
  const hours = Math.floor(totalMinutes / 60);
  const rest = totalMinutes % 60;
  return rest === 0 ? `${hours}ч` : `${hours}ч ${rest}м`;
}

export interface MiniVerdictInput {
  usefulMs: number;
  wasteMs: number;
  observedMs: number;
  usefulGoalMin: number;
  wasteLimitMin: number;
  observedMin: number;
  usefulLabel: string;
  wasteLabel: string;
}

export interface MiniVerdict {
  key: "mini.verdictWasteExceeded"
    | "mini.verdictWasteRemaining"
    | "mini.verdictPassedNearLimit"
    | "mini.verdictPassed"
    | "mini.verdictUsefulRemaining"
    | "mini.verdictObserved"
    | "mini.verdictInProgress";
  vars: Record<string, string | number>;
}

function remainingMinutes(valueMs: number, thresholdMin: number): number {
  return Math.max(1, Math.ceil((thresholdMin * 60_000 - valueMs) / 60_000));
}

export function getMiniVerdict(input: MiniVerdictInput): MiniVerdict {
  if (![input.usefulMs, input.wasteMs, input.observedMs].every(Number.isFinite)) {
    return { key: "mini.verdictInProgress", vars: {} };
  }
  const usefulGoalMs = input.usefulGoalMin * 60_000;
  const wasteLimitMs = input.wasteLimitMin * 60_000;
  const observedGoalMs = input.observedMin * 60_000;
  const allConditionsMet = input.usefulMs >= usefulGoalMs
    && input.wasteMs <= wasteLimitMs
    && input.observedMs >= observedGoalMs;
  const wasteNearLimit = input.wasteMs >= wasteLimitMs * 0.8;

  if (input.wasteMs > wasteLimitMs) {
    return {
      key: "mini.verdictWasteExceeded",
      vars: {
        label: input.wasteLabel,
        duration: formatCompactMinutes(Math.max(1, Math.ceil((input.wasteMs - wasteLimitMs) / 60_000))),
      },
    };
  }
  if (wasteNearLimit) {
    return allConditionsMet
      ? {
          key: "mini.verdictPassedNearLimit",
          vars: { duration: formatCompactMinutes(remainingMinutes(input.wasteMs, input.wasteLimitMin)) },
        }
      : {
          key: "mini.verdictWasteRemaining",
          vars: {
            label: input.wasteLabel,
            duration: formatCompactMinutes(remainingMinutes(input.wasteMs, input.wasteLimitMin)),
          },
        };
  }
  if (allConditionsMet) return { key: "mini.verdictPassed", vars: {} };
  if (input.usefulMs < usefulGoalMs) {
    return {
      key: "mini.verdictUsefulRemaining",
      vars: {
        label: input.usefulLabel,
        duration: formatCompactMinutes(remainingMinutes(input.usefulMs, input.usefulGoalMin)),
      },
    };
  }
  if (input.observedMs < observedGoalMs) {
    return {
      key: "mini.verdictObserved",
      vars: {
        current: formatCompactMinutes(Math.floor(input.observedMs / 60_000)),
        goal: formatCompactMinutes(input.observedMin),
      },
    };
  }
  return { key: "mini.verdictInProgress", vars: {} };
}
