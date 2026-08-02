export const PLAN_MODE_STATE_ENTRY = "pi-extensions:plan-mode-state";
const LEGACY_PLAN_MODE_STATE_ENTRY = "plan-mode-state";

export interface ProposedPlanState {
  markdown: string;
  sourceEntryId: string;
}

export interface PlanModeState {
  version: 1;
  mode: "default" | "plan";
  latestPlan?: ProposedPlanState;
  lastOfferedEntryId?: string;
  disabledTools: string[];
}

export interface CustomEntryLike {
  type: string;
  customType?: string;
  data?: unknown;
}

export function createDefaultPlanModeState(): PlanModeState {
  return { version: 1, mode: "default", disabledTools: [] };
}

function isProposedPlan(value: unknown): value is ProposedPlanState {
  if (!value || typeof value !== "object") return false;
  const plan = value as Record<string, unknown>;
  return typeof plan.markdown === "string" && typeof plan.sourceEntryId === "string";
}

function isPlanModeState(value: unknown): value is PlanModeState {
  if (!value || typeof value !== "object") return false;
  const state = value as Record<string, unknown>;
  return (
    state.version === 1 &&
    (state.mode === "default" || state.mode === "plan") &&
    Array.isArray(state.disabledTools) &&
    state.disabledTools.every((name) => typeof name === "string") &&
    (state.latestPlan === undefined || isProposedPlan(state.latestPlan)) &&
    (state.lastOfferedEntryId === undefined || typeof state.lastOfferedEntryId === "string")
  );
}

/** Restores the newest valid state, including the former unnamespaced key for local-session compatibility. */
export function restorePlanModeState(entries: readonly CustomEntryLike[]): PlanModeState {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (
      entry?.type !== "custom" ||
      (entry.customType !== PLAN_MODE_STATE_ENTRY &&
        entry.customType !== LEGACY_PLAN_MODE_STATE_ENTRY) ||
      !isPlanModeState(entry.data)
    ) {
      continue;
    }
    return {
      ...entry.data,
      disabledTools: [...entry.data.disabledTools],
      ...(entry.data.latestPlan ? { latestPlan: { ...entry.data.latestPlan } } : {}),
    };
  }
  return createDefaultPlanModeState();
}
