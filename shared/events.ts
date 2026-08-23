/** Public event names shared by independently loaded package entrypoints. */
export const events = {
  planMode: "pi-extensions:plan-mode",
  planReview: "pi-extensions:plan-review",
  subagentsStatus: "pi-extensions:subagents-status",
  subagentsHub: "pi-extensions:subagents-hub",
  userInteraction: "pi-extensions:user-interaction",
  herdrBlocked: "herdr:blocked",
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
  name: string;
  profileClass?: "read" | "write" | "review" | "advisory" | "orchestrator";
  status: "queued" | "starting" | "running" | "blocked" | "parked" | "failed" | "stopped";
  task: string;
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
};

export type SubagentsStatusEvent = {
  active: number;
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
