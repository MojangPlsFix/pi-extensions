/** Public event names shared by independently loaded package entrypoints. */
export const events = {
  planMode: "pi-extensions:plan-mode",
  planReview: "pi-extensions:plan-review",
  subagentsStatus: "pi-extensions:subagents-status",
  subagentsHub: "pi-extensions:subagents-hub",
  userInteraction: "pi-extensions:user-interaction",
  herdrBlocked: "herdr:blocked",
  continuationEnqueue: "pi-extensions:continuation-enqueue",
  continuationReceipt: "pi-extensions:continuation-receipt",
  continuationCancel: "pi-extensions:continuation-cancel",
  continuationGate: "pi-extensions:continuation-gate",
  continuationActivity: "pi-extensions:continuation-activity",
  compactionGate: "pi-extensions:compaction-gate",
  hacklerBatchGate: "pi-extensions:hackler-batch-gate",
  hacklerActivity: "pi-extensions:hackler-activity",
  implementationWaveAdvance: "pi-extensions:implementation-wave-advance",
} as const;

export type PlanModeEvent = {
  enabled: boolean;
};

/** A blocking UI interaction is active in the parent Pi session. */
export type UserInteractionEvent = {
  active: boolean;
  reason: string;
};

/** Herdr's official semantic blocking event. */
export type HerdrBlockedEvent = {
  active: boolean;
  label?: string;
};

export type ContinuationMessage = {
  content: string;
  customType?: string;
  display?: boolean;
  /** Producer-owned renderer data. The coordinator adds its receipt envelope without replacing it. */
  details?: unknown;
};

/** Enqueue one durable automatic turn. producerId and any explicit requestId must be reload-stable. */
export type ContinuationEnqueueEvent = {
  producerId: string;
  message: ContinuationMessage;
  /** Optional canonical ID, for producers that already persist their own request identity. */
  requestId?: string;
  dedupeKey?: string;
  /** Defaults to the coordinator's current session. A mismatch is rejected. */
  sessionId?: string;
  /** Defaults to the active leaf. The entry must be on the active branch. */
  originEntryId?: string | null;
  /** Filled synchronously when the coordinator accepts or reconciles the request. */
  respond?: (result: { accepted: boolean; requestId?: string; reason?: string }) => void;
};

export type ContinuationReceiptEvent = {
  producerId: string;
  requestId: string;
  status: "settled" | "cancelled";
  sessionId?: string;
  originEntryId?: string | null;
  deliveryEntryId?: string;
  settledEntryId?: string;
};

export type ContinuationCancelEvent = {
  producerId: string;
  requestId?: string;
  reason?: string;
};

/** A named application-side dispatch gate. Re-emitting the same state is idempotent. */
export type ContinuationGateEvent = {
  gateId: string;
  active: boolean;
  reason?: string;
};

export type ContinuationActivityEvent = {
  sessionId?: string;
  /** Open requests whose origin is on the active branch. */
  open: number;
  queued: number;
  inFlight?: string;
  gated: boolean;
};

export type CompactionGateEvent = {
  active: boolean;
  operationId?: string;
  /** A successful lifecycle boundary may resume queued work after this gate closes. */
  resume?: boolean;
};

/** Relevant means the batch can still change or review the current implementation. */
export type HacklerBatchGateEvent = {
  batchId: string;
  active: boolean;
  relevant?: boolean;
  phase?: "dispatch" | "running" | "review" | "integration";
};

export type HacklerActivityEvent = {
  active: number;
  writers: number;
  integrating?: number;
  relevantBatchIds?: string[];
};

/** Explicitly arms a new implementation wave after an out-of-process mutation. */
export type ImplementationWaveAdvanceEvent = {
  producerId: string;
  reason: string;
  branchEntryId?: string;
  /** Review completion advances only an implementation wave that is already armed. */
  requiresArmed?: boolean;
};

type EventEmitter = {
  emit(name: string, data: unknown): unknown;
};

/** Report a blocking user interaction to both current and legacy integrations. */
export async function withBlockingUserInteraction<T>(
  emitter: EventEmitter,
  reason: string,
  operation: () => Promise<T>,
): Promise<T> {
  emitter.emit(events.userInteraction, {
    active: true,
    reason,
  } satisfies UserInteractionEvent);
  emitter.emit(events.herdrBlocked, {
    active: true,
    label: reason,
  } satisfies HerdrBlockedEvent);
  try {
    return await operation();
  } finally {
    emitter.emit(events.userInteraction, {
      active: false,
      reason,
    } satisfies UserInteractionEvent);
    emitter.emit(events.herdrBlocked, {
      active: false,
    } satisfies HerdrBlockedEvent);
  }
}

/** Request for the optional Plan Mode reviewer service. Thinking is optional for old senders. */
export type PlanReviewEvent = {
  task: string;
  model: string;
  thinking?: string;
  ctx: unknown;
  accept?: () => void;
  respond?: (result: {
    reviewerId?: string;
    model?: string;
    thinking?: string;
    report?: string;
    error?: string;
  }) => void;
};

export type SubagentTerminationSnapshot = {
  code:
    | "completed"
    | "wall_limit"
    | "turn_limit"
    | "token_limit"
    | "cost_limit"
    | "explicit_stop"
    | "parent_shutdown"
    | "session_change"
    | "startup_error"
    | "runner_error"
    | "ancestor_terminated"
    | "legacy_unknown";
  at: string;
  generation: number;
  phase?: "startup" | "execution" | "finalization" | "cleanup";
  limit?: { kind: "wall" | "turn" | "token" | "cost"; maximum: number; observed: number };
  ancestorRunId?: string;
};

export type SubagentActivitySnapshot = {
  id: string;
  /** Legacy fallback only; new live projections use taskKey. */
  name?: string;
  profileClass?: "read" | "write" | "review" | "advisory" | "orchestrator";
  status: "queued" | "starting" | "running" | "blocked" | "parked" | "failed" | "stopped";
  /** Stable compact label source. Child prompts must not be used as quickview labels. */
  taskKey?: string;
  /** Retained for compatibility; new live projections omit child prompts. */
  task?: string;
  runner?: "native" | "rpc" | "external";
  startedAt?: string;
  finishedAt?: string;
  elapsedMs: number;
  statusChangedAt?: string;
  lastEventAt?: string;
  currentOperation?: {
    kind:
      | "startup"
      | "worktree"
      | "transport"
      | "model"
      | "tool"
      | "supervisor"
      | "finalization"
      | "cleanup";
    name: string;
    startedAt: string;
    generation: number;
  };
  originalEffectiveLimits?: {
    maxWallSeconds: number;
    maxTurns: number | "notApplicable";
    wrapUpRatio: number;
    tokenBudget?: number;
    costBudget?: number;
  };
  leaseHistory?: Array<{
    id: string;
    generation: number;
    startedAt: string;
    acceptedAt?: string;
    wrapAt: string;
    deadlineAt: string;
    wrapTriggeredAt?: string;
    wrapCause?: "wall" | "turn";
    endedAt?: string;
    effectiveLimits: {
      maxWallSeconds: number;
      maxTurns: number | "notApplicable";
      wrapUpRatio: number;
      tokenBudget?: number;
      costBudget?: number;
    };
  }>;
  activeLeaseGeneration?: number;
  completionAcknowledgedGeneration?: number;
  turns?: number;
  wrappingUp?: boolean;
  blockedSince?: string;
  terminationReason?: SubagentTerminationSnapshot;
  report?: string;
  error?: string;
  cleanupFailure?: { at: string; message: string };
  effectiveModel?: string;
  effectiveThinking?: string;
  latestActivity?: string;
  /** Tool name only. Tool arguments and input are never projected. */
  currentTool?: string;
  /** Most recent meaningful activity distinct from the current operation. */
  lastAction?: string;
  attentionReason?: string;
  group?: "Attention" | "Active";
};

export type SubagentsStatusEvent = {
  active: number;
  /** Non-hidden Attention and Active runs represented by the live projection. */
  foreground?: number;
  attention?: number;
  /** Acknowledged terminal generations, shown only as an aggregate during foreground work. */
  history?: number;
  running: number;
  wrappingUp: number;
  blocked: number;
  parked: number;
  failed: number;
  stopped: number;
  writers: number;
  total: number;
  capacity: {
    used: number;
    limit: number;
    free: number;
    sharedWritersUsed: number;
    sharedWritersLimit: number;
  };
  oldestBlockingRequest?: {
    id: string;
    title: string;
    createdAt: string;
    action: string;
  };
  blockingRequestCount?: number;
  /** Operational snapshots ordered by the renderer; complete history remains owned by /agents. */
  agents: SubagentActivitySnapshot[];
};
