export const PLAN_MODE_STATE_ENTRY = "pi-extensions:plan-mode-state";
const LEGACY_PLAN_MODE_STATE_ENTRY = "plan-mode-state";

export interface ProposedPlanState {
  markdown: string;
  sourceEntryId: string;
}

export interface PlanReviewState {
  planSourceEntryId: string;
  reviewerId: string;
  model: string;
  /** Selected Pi thinking effort; absent on reviews persisted before effort selection existed. */
  thinking?: string;
  reviewedAt: string;
  report: string;
}

export interface PlanRevisionResponseBoundary {
  requestId: string;
  originEntryId: string | null;
  deliveryEntryId?: string;
  settledEntryId?: string;
}

/** Durable expectation created by a successful advisory review. */
export interface PlanRevisionExpectation {
  reviewedPlan: ProposedPlanState;
  phase: "awaiting" | "correction-requested" | "warned";
  retryCount: 0 | 1;
  reviewContinuationId: string;
  correctionContinuationId?: string;
  responseBoundary: PlanRevisionResponseBoundary;
  lastCheckedAssistantEntryId?: string;
  parseFailure?: "missing" | "empty" | "multiple" | "unterminated";
}

export interface PlanModeState {
  version: 2;
  mode: "default" | "plan";
  latestPlan?: ProposedPlanState;
  /** A plan source can be implemented only once. A newer proposed plan resets this marker. */
  implementedPlanSourceEntryId?: string;
  lastReview?: PlanReviewState;
  lastOfferedEntryId?: string;
  revisionExpectation?: PlanRevisionExpectation;
  disabledTools: string[];
}

export interface CustomEntryLike {
  type: string;
  customType?: string;
  data?: unknown;
}

export function createDefaultPlanModeState(): PlanModeState {
  return { version: 2, mode: "default", disabledTools: [] };
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isProposedPlan(value: unknown): value is ProposedPlanState {
  if (!record(value)) return false;
  return nonEmptyString(value.markdown) && nonEmptyString(value.sourceEntryId);
}

function isPlanReview(value: unknown): value is PlanReviewState {
  if (!record(value)) return false;
  return (
    nonEmptyString(value.planSourceEntryId) &&
    nonEmptyString(value.reviewerId) &&
    nonEmptyString(value.model) &&
    (value.thinking === undefined || nonEmptyString(value.thinking)) &&
    nonEmptyString(value.reviewedAt) &&
    nonEmptyString(value.report)
  );
}

function isBoundary(value: unknown): value is PlanRevisionResponseBoundary {
  if (!record(value)) return false;
  return (
    nonEmptyString(value.requestId) &&
    (value.originEntryId === null || nonEmptyString(value.originEntryId)) &&
    (value.deliveryEntryId === undefined || nonEmptyString(value.deliveryEntryId)) &&
    (value.settledEntryId === undefined || nonEmptyString(value.settledEntryId))
  );
}

function isRevisionExpectation(value: unknown): value is PlanRevisionExpectation {
  if (
    !record(value) ||
    !isProposedPlan(value.reviewedPlan) ||
    !["awaiting", "correction-requested", "warned"].includes(String(value.phase)) ||
    (value.retryCount !== 0 && value.retryCount !== 1) ||
    !nonEmptyString(value.reviewContinuationId) ||
    (value.correctionContinuationId !== undefined &&
      !nonEmptyString(value.correctionContinuationId)) ||
    !isBoundary(value.responseBoundary) ||
    (value.lastCheckedAssistantEntryId !== undefined &&
      !nonEmptyString(value.lastCheckedAssistantEntryId)) ||
    (value.parseFailure !== undefined &&
      !["missing", "empty", "multiple", "unterminated"].includes(String(value.parseFailure)))
  )
    return false;
  if (value.phase === "awaiting")
    return (
      value.retryCount === 0 &&
      value.correctionContinuationId === undefined &&
      value.parseFailure === undefined &&
      value.responseBoundary.requestId === value.reviewContinuationId
    );
  return (
    value.retryCount === 1 &&
    nonEmptyString(value.correctionContinuationId) &&
    value.responseBoundary.requestId === value.correctionContinuationId &&
    value.parseFailure !== undefined
  );
}

function isCommonState(state: Record<string, unknown>): boolean {
  return (
    (state.mode === "default" || state.mode === "plan") &&
    Array.isArray(state.disabledTools) &&
    state.disabledTools.every(nonEmptyString) &&
    (state.latestPlan === undefined || isProposedPlan(state.latestPlan)) &&
    (state.implementedPlanSourceEntryId === undefined ||
      nonEmptyString(state.implementedPlanSourceEntryId)) &&
    (state.lastReview === undefined || isPlanReview(state.lastReview)) &&
    (state.lastOfferedEntryId === undefined || nonEmptyString(state.lastOfferedEntryId))
  );
}

function isPlanModeStateV2(value: unknown): value is PlanModeState {
  if (!record(value) || value.version !== 2 || !isCommonState(value)) return false;
  const latestPlan = isProposedPlan(value.latestPlan) ? value.latestPlan : undefined;
  if (
    value.implementedPlanSourceEntryId !== undefined &&
    (!latestPlan || value.implementedPlanSourceEntryId !== latestPlan.sourceEntryId)
  )
    return false;
  if (
    value.lastReview !== undefined &&
    (!isPlanReview(value.lastReview) ||
      !latestPlan ||
      value.lastReview.planSourceEntryId !== latestPlan.sourceEntryId)
  )
    return false;
  if (
    value.lastOfferedEntryId !== undefined &&
    (!latestPlan || value.lastOfferedEntryId !== latestPlan.sourceEntryId)
  )
    return false;
  if (value.revisionExpectation === undefined) return true;
  if (value.mode !== "plan" || !isRevisionExpectation(value.revisionExpectation) || !latestPlan)
    return false;
  return (
    value.revisionExpectation.reviewedPlan.sourceEntryId === latestPlan.sourceEntryId &&
    value.revisionExpectation.reviewedPlan.markdown === latestPlan.markdown
  );
}

type PlanModeStateV1 = Omit<PlanModeState, "version" | "revisionExpectation"> & { version: 1 };

function isPlanModeStateV1(value: unknown): value is PlanModeStateV1 {
  return record(value) && value.version === 1 && isCommonState(value);
}

function cloneState(state: PlanModeState): PlanModeState {
  return {
    version: 2,
    mode: state.mode,
    disabledTools: [...state.disabledTools],
    ...(state.latestPlan ? { latestPlan: { ...state.latestPlan } } : {}),
    ...(state.implementedPlanSourceEntryId
      ? { implementedPlanSourceEntryId: state.implementedPlanSourceEntryId }
      : {}),
    ...(state.lastReview ? { lastReview: { ...state.lastReview } } : {}),
    ...(state.lastOfferedEntryId ? { lastOfferedEntryId: state.lastOfferedEntryId } : {}),
    ...(state.revisionExpectation
      ? {
          revisionExpectation: {
            ...state.revisionExpectation,
            reviewedPlan: { ...state.revisionExpectation.reviewedPlan },
            responseBoundary: { ...state.revisionExpectation.responseBoundary },
          },
        }
      : {}),
  };
}

function migrateV1(state: PlanModeStateV1): PlanModeState {
  const latestPlan = state.latestPlan ? { ...state.latestPlan } : undefined;
  const implementedPlanSourceEntryId =
    latestPlan && state.implementedPlanSourceEntryId === latestPlan.sourceEntryId
      ? state.implementedPlanSourceEntryId
      : undefined;
  const lastReview =
    latestPlan && state.lastReview?.planSourceEntryId === latestPlan.sourceEntryId
      ? { ...state.lastReview }
      : undefined;
  return {
    version: 2,
    mode: state.mode,
    disabledTools: [...state.disabledTools],
    ...(latestPlan ? { latestPlan } : {}),
    ...(implementedPlanSourceEntryId ? { implementedPlanSourceEntryId } : {}),
    ...(lastReview ? { lastReview } : {}),
    // A migrated proposal has already been observed by the old runtime. Marking it offered
    // prevents reload from replaying its implementation selector.
    ...(latestPlan ? { lastOfferedEntryId: latestPlan.sourceEntryId } : {}),
  };
}

/** Restores strict v2, while migrating valid v1 data from both historical custom types. */
export function restorePlanModeState(entries: readonly CustomEntryLike[]): PlanModeState {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (
      entry?.type !== "custom" ||
      (entry.customType !== PLAN_MODE_STATE_ENTRY &&
        entry.customType !== LEGACY_PLAN_MODE_STATE_ENTRY)
    )
      continue;
    if (isPlanModeStateV2(entry.data)) return cloneState(entry.data);
    if (isPlanModeStateV1(entry.data)) return migrateV1(entry.data);
  }
  return createDefaultPlanModeState();
}
