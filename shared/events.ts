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

export type SubagentActivitySnapshot = {
  id: string;
  name: string;
  profileClass?: "read" | "write" | "review" | "advisory" | "orchestrator";
  status: "queued" | "starting" | "running" | "blocked" | "parked" | "failed" | "stopped";
  task: string;
  elapsedMs: number;
  effectiveModel?: string;
  effectiveThinking?: string;
  latestActivity?: string;
};

export type SubagentsStatusEvent = {
  active: number;
  blocked: number;
  parked: number;
  failed: number;
  writers: number;
  total: number;
  /** Task-first inline snapshots only; complete history remains owned by /agents. */
  agents: SubagentActivitySnapshot[];
};
