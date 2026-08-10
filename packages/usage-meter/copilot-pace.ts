import type { CopilotCreditSnapshot } from "../../shared/copilot-snapshots.js";
import type { CopilotQuota } from "./types.js";

/** Return the number of calendar days in the local month containing `date`. */
export function daysInMonth(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
}

/** Return the number of Monday-Friday workdays in the local month. */
export function workdaysInMonth(date: Date): number {
  let count = 0;
  for (let day = 1; day <= daysInMonth(date); day += 1) {
    const weekday = new Date(date.getFullYear(), date.getMonth(), day).getDay();
    if (weekday !== 0 && weekday !== 6) count += 1;
  }
  return count;
}

/** Return Monday-Friday workdays from the first day of the month through `date`. */
export function monthToDateWorkdays(date: Date): number {
  let count = 0;
  for (let day = 1; day <= date.getDate(); day += 1) {
    const weekday = new Date(date.getFullYear(), date.getMonth(), day).getDay();
    if (weekday !== 0 && weekday !== 6) count += 1;
  }
  return count;
}

function dateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function quotaTotal(quota: CopilotQuota): number | undefined {
  if (typeof quota.total === "number" && Number.isFinite(quota.total) && quota.total > 0)
    return quota.total;
  if (
    typeof quota.percentRemaining === "number" &&
    Number.isFinite(quota.percentRemaining) &&
    quota.percentRemaining > 0
  ) {
    const total = quota.remaining / (quota.percentRemaining / 100);
    return Number.isFinite(total) && total > 0 ? total : undefined;
  }
  return undefined;
}

function validSnapshot(snapshot: CopilotCreditSnapshot, month: string, total: number): boolean {
  return (
    snapshot.date.startsWith(`${month}-`) &&
    snapshot.unit === "ai_credits" &&
    snapshot.total === total
  );
}

/**
 * Calculate current-month AI-credit use against an even workday budget.
 *
 * A baseline must be an earlier checkpoint in the same local month with the
 * same unit and total. This avoids treating a prior month's reset, or a plan
 * change, as current-month usage. The first observed day has no earlier
 * baseline and therefore returns `undefined`.
 */
export function copilotDailyPacePercent(
  quota: CopilotQuota,
  snapshots: readonly CopilotCreditSnapshot[],
  now = new Date(),
): number | undefined {
  if (quota.unlimited || quota.unit !== "ai_credits") return undefined;
  if (now.getDay() === 0 || now.getDay() === 6) return undefined;
  const total = quotaTotal(quota);
  if (total === undefined || !Number.isFinite(quota.remaining)) return undefined;

  const today = dateKey(now);
  const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const baseline = snapshots
    .filter((snapshot) => validSnapshot(snapshot, month, total) && snapshot.date < today)
    .sort((a, b) => a.date.localeCompare(b.date))[0];
  if (!baseline) return undefined;

  const [year, monthNumber, day] = baseline.date.split("-").map(Number);
  if (!year || !monthNumber || !day) return undefined;
  const baselineDate = new Date(year, monthNumber - 1, day);
  const elapsedWorkdays = Math.max(1, monthToDateWorkdays(now) - monthToDateWorkdays(baselineDate));
  const monthlyWorkdays = workdaysInMonth(now);
  if (monthlyWorkdays === 0) return undefined;

  const usedSinceBaseline = Math.max(0, baseline.remaining - quota.remaining);
  const expectedUse = (total * elapsedWorkdays) / monthlyWorkdays;
  if (expectedUse <= 0) return undefined;
  return Math.round((usedSinceBaseline / expectedUse) * 100);
}

export const copilotDailyPace = copilotDailyPacePercent;
