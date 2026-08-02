/** Public event names shared by independently loaded package entrypoints. */
export const events = {
  planMode: "pi-extensions:plan-mode",
  subagentsStatus: "pi-extensions:subagents-status",
} as const;

export type PlanModeEvent = {
  enabled: boolean;
};

export type SubagentsStatusEvent = {
  active: number;
  explorers?: number;
  workers?: number;
  failed?: number;
};
