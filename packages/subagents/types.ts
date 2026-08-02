import type { ChildProcessWithoutNullStreams } from "node:child_process";

export type Mode = "explorer" | "worker";
export type AgentStatus = "running" | "completed" | "failed" | "interrupted" | "closed";
export type BackendKind = "rpc" | "herdr";

export type OptionalIntegrationPolicy = "auto" | "enabled" | "disabled";

/** Partial configuration override accepted in defaults and agent entries. */
export type ChildResourcePolicy = {
  contextMode?: OptionalIntegrationPolicy;
  contextExecution?: boolean;
  webSearch?: boolean;
  todos?: boolean;
  rtk?: OptionalIntegrationPolicy;
  uv?: OptionalIntegrationPolicy;
  copilotCompactionFix?: boolean;
};

/** Fully resolved role policy used by a running child. */
export type ResolvedChildResourcePolicy = Required<ChildResourcePolicy>;

/** Probed/installed capability state. A false value can also mean that probing was skipped. */
export type ChildDetectedResources = {
  contextMode: boolean;
  contextExecution: boolean;
  webSearch: boolean;
  todos: boolean;
  rtk: boolean;
  uv: boolean;
  copilotCompactionFix: boolean;
};

/** Capabilities actually exposed to the child. */
export type ChildEffectiveResources = ChildDetectedResources;

export type Usage = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
  cost: number;
};

export type AgentDefinition = {
  name: string;
  description: string;
  mode: Mode;
  model?: string;
  thinking?: string;
  prompt: string;
  source: "builtin" | "user";
};

export type AgentActivity = {
  at: string;
  kind:
    | "spawn"
    | "prompt"
    | "guidance"
    | "redirect"
    | "tool"
    | "message"
    | "status"
    | "error"
    | "transport"
    | "close";
  text: string;
};

/** Serializable state deliberately safe to put in a tool result's details. */
export type AgentSnapshot = {
  id: string;
  name: string;
  mode: Mode;
  status: AgentStatus;
  backend: BackendKind;
  task: string;
  taskHistory: string[];
  startedAt: string;
  finishedAt?: string;
  elapsedMs: number;
  sessionDir: string;
  sessionFile?: string;
  herdrPaneId?: string;
  herdrTabId?: string;
  requestedModel?: string;
  requestedThinking?: string;
  effectiveModel?: string;
  effectiveThinking?: string;
  requestedResources?: ResolvedChildResourcePolicy;
  detectedResources?: ChildDetectedResources;
  effectiveResources?: ChildEffectiveResources;
  resourceWarnings?: string[];
  latestActivity?: string;
  activity: AgentActivity[];
  report: string;
  stderr: string;
  error?: string;
  usage: Usage;
};

export type ManagedAgent = {
  id: string;
  name: string;
  definition: AgentDefinition;
  task: string;
  taskHistory: string[];
  status: AgentStatus;
  backend: BackendKind;
  startedAt: string;
  finishedAt?: string;
  sessionDir: string;
  sessionFile?: string;
  /** Present only for the traditional invisible RPC transport. */
  process?: ChildProcessWithoutNullStreams;
  herdrPaneId?: string;
  herdrTabId?: string;
  stderr: string;
  output: string;
  error?: string;
  usage: Usage;
  completionReported: boolean;
  requestedModel?: string;
  requestedThinking?: string;
  effectiveModel?: string;
  effectiveThinking?: string;
  requestedResources?: ResolvedChildResourcePolicy;
  detectedResources?: ChildDetectedResources;
  effectiveResources?: ChildEffectiveResources;
  resourceWarnings?: string[];
  activity: AgentActivity[];
  redirectMessage?: string;
};

export type AgentStatusSummary = {
  active: number;
  ready: number;
  open: number;
  explorers: number;
  workers: number;
  failed: number;
  interrupted: number;
  closed: number;
};

export const emptyUsage = (): Usage => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  total: 0,
  cost: 0,
});

export function agentSnapshot(agent: ManagedAgent, now = Date.now()): AgentSnapshot {
  return {
    id: agent.id,
    name: agent.name,
    mode: agent.definition.mode,
    status: agent.status,
    backend: agent.backend,
    task: agent.task,
    taskHistory: [...agent.taskHistory],
    startedAt: agent.startedAt,
    finishedAt: agent.finishedAt,
    elapsedMs: Math.max(
      0,
      (agent.finishedAt ? Date.parse(agent.finishedAt) : now) - Date.parse(agent.startedAt),
    ),
    sessionDir: agent.sessionDir,
    sessionFile: agent.sessionFile,
    herdrPaneId: agent.herdrPaneId,
    herdrTabId: agent.herdrTabId,
    requestedModel: agent.requestedModel,
    requestedThinking: agent.requestedThinking,
    effectiveModel: agent.effectiveModel,
    effectiveThinking: agent.effectiveThinking,
    requestedResources: agent.requestedResources ? { ...agent.requestedResources } : undefined,
    detectedResources: agent.detectedResources ? { ...agent.detectedResources } : undefined,
    effectiveResources: agent.effectiveResources ? { ...agent.effectiveResources } : undefined,
    resourceWarnings: agent.resourceWarnings ? [...agent.resourceWarnings] : undefined,
    // Transport observations belong in the expanded history but must not replace actual work in the compact widget.
    latestActivity: [...agent.activity].reverse().find((entry) => entry.kind !== "transport")?.text,
    activity: [...agent.activity],
    report: agent.output,
    stderr: agent.stderr,
    error: agent.error,
    usage: { ...agent.usage },
  };
}
