/** Public event names shared by independently loaded package entrypoints. */
export const events = {
  planMode: "pi-extensions:plan-mode",
  planReview: "pi-extensions:plan-review",
  subagentsStatus: "pi-extensions:subagents-status",
  userInteraction: "pi-extensions:user-interaction",
} as const;

export type PlanModeEvent = {
  enabled: boolean;
};

/** A blocking UI interaction is active in the parent Pi session. */
export type UserInteractionEvent = {
  active: boolean;
  reason: string;
};

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
  mode: "explorer" | "worker";
  status: "running" | "completed" | "failed" | "interrupted" | "closed";
  task: string;
  elapsedMs: number;
  requestedModel?: string;
  requestedThinking?: string;
  effectiveModel?: string;
  effectiveThinking?: string;
  latestActivity?: string;
};

export type SubagentsStatusEvent = {
  active: number;
  ready: number;
  open: number;
  explorers: number;
  workers: number;
  failed: number;
  interrupted: number;
  closed: number;
  /** Task-first inline snapshots only; complete history remains owned by /agents. */
  agents: SubagentActivitySnapshot[];
};
