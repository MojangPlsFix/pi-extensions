import type { EffectiveCapabilityPolicy } from "./capabilities.js";

/** The v2 profile class controls the authority granted to a profile. */
export type ProfileClass = "read" | "write" | "review" | "advisory" | "orchestrator";
export type RunnerKind = "native" | "rpc" | "external";
export type WorkspacePolicy = "shared" | "isolated" | "read-only";
export type AgentSource = "builtin" | "user" | "project";

export const PROFILE_CLASSES = ["read", "write", "review", "advisory", "orchestrator"] as const;
export const RUNNER_KINDS = ["native", "rpc", "external"] as const;

export type RunStatus =
  | "queued"
  | "starting"
  | "running"
  | "blocked"
  | "parked"
  | "failed"
  | "stopped";

export type RunActivityKind =
  | "spawn"
  | "prompt"
  | "steer"
  | "tool"
  | "message"
  | "status"
  | "approval"
  | "error"
  | "transport"
  | "park";

export type RunActivity = { at: string; kind: RunActivityKind; text: string };

export type Budget = { timeoutMs?: number; turns?: number; tokens?: number; cost?: number };
export type ProfileMetadata = {
  enabled?: boolean;
  disabled?: boolean;
  ejected?: boolean;
  note?: string;
};

/** A schema-v2 profile loaded from a built-in or Markdown definition. */
export type AgentDefinition = {
  schemaVersion: 2;
  name: string;
  description: string;
  class: ProfileClass;
  runner: RunnerKind;
  tools: string[];
  capabilities: string[];
  skills: string[];
  defaultContext?: string;
  allowedNestedProfiles: string[];
  maxDepth: number;
  workspace: WorkspacePolicy;
  timeout?: number;
  turnBudget?: number;
  tokenBudget?: number;
  costBudget?: number;
  infer: boolean;
  hidden: boolean;
  model?: string;
  thinking?: string;
  prompt: string;
  source: AgentSource;
  path?: string;
  metadata?: ProfileMetadata;
};

export type Usage = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
  cost: number;
};

export type RunWorktree = {
  missionId: string;
  root: string;
  cwd: string;
  baseCommit: string;
  sourceRoot: string;
};

export type IntegrationCandidate = {
  patch: string;
  files: string[];
  hasChanges: boolean;
};

export type TaskOwnership = {
  key: string;
  owns: string[];
  deliverable: string;
  workspace: "shared" | "worktree";
};

export type RunRecord = {
  id: string;
  parentId?: string;
  missionId?: string;
  profile: AgentDefinition;
  /** Immutable profile policy captured when this run was first allocated. */
  profileSnapshot: AgentDefinition;
  task: string;
  taskHistory: string[];
  ownership: TaskOwnership;
  status: RunStatus;
  runner: RunnerKind;
  startedAt: string;
  finishedAt?: string;
  sessionDir: string;
  sessionFile?: string;
  report: string;
  error?: string;
  usage: Usage;
  /** Child usage already attached to a parent Pi tool result. */
  accountedUsage?: Usage;
  turns: number;
  activity: RunActivity[];
  currentTool?: string;
  effectiveModel?: string;
  effectiveThinking?: string;
  capabilityNames: string[];
  /** Immutable flattened capability policy captured when the run starts. */
  capabilityPolicy: EffectiveCapabilityPolicy;
  worktree?: RunWorktree;
  candidate?: IntegrationCandidate;
  integrationRequestId?: string;
  completionReported: boolean;
};

export type RunSnapshot = Omit<
  RunRecord,
  "profile" | "profileSnapshot" | "candidate" | "capabilityPolicy" | "accountedUsage"
> & {
  name: string;
  profileClass: ProfileClass;
  description: string;
  elapsedMs: number;
  latestActivity?: string;
  hidden: boolean;
  candidate?: { files: string[]; hasChanges: boolean };
  capabilityPolicy: EffectiveCapabilityPolicy;
};

export type RunSummary = {
  active: number;
  blocked: number;
  parked: number;
  failed: number;
  writers: number;
  total: number;
};

export const emptyUsage = (): Usage => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  total: 0,
  cost: 0,
});

export function capabilityPolicySnapshot(
  policy: EffectiveCapabilityPolicy,
): EffectiveCapabilityPolicy {
  return {
    requested: [...policy.requested],
    capabilities: policy.capabilities.map((capability) => ({
      ...capability,
      toolPatterns: capability.toolPatterns ? [...capability.toolPatterns] : undefined,
      executableArgvPrefixes: capability.executableArgvPrefixes?.map((prefix) => [...prefix]),
      skills: capability.skills ? [...capability.skills] : undefined,
      envAllowlist: capability.envAllowlist ? [...capability.envAllowlist] : undefined,
      matchedTools: [...capability.matchedTools],
      matchedExecutables: capability.matchedExecutables.map((prefix) => [...prefix]),
    })),
    tools: [...policy.tools],
    executableArgvPrefixes: policy.executableArgvPrefixes.map((prefix) => [...prefix]),
    skills: [...policy.skills],
    envAllowlist: [...policy.envAllowlist],
    state: policy.state,
    approval: policy.approval,
    diagnostics: policy.diagnostics.map((diagnostic) => ({ ...diagnostic })),
  };
}

export function runSnapshot(run: RunRecord, now = Date.now()): RunSnapshot {
  return {
    id: run.id,
    parentId: run.parentId,
    missionId: run.missionId,
    name: run.profile.name,
    profileClass: run.profile.class,
    description: run.profile.description,
    task: run.task,
    taskHistory: [...run.taskHistory],
    ownership: {
      ...run.ownership,
      owns: [...run.ownership.owns],
    },
    status: run.status,
    runner: run.runner,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    elapsedMs: Math.max(
      0,
      (run.finishedAt ? Date.parse(run.finishedAt) : now) - Date.parse(run.startedAt),
    ),
    sessionDir: run.sessionDir,
    sessionFile: run.sessionFile,
    report: run.report,
    error: run.error,
    usage: { ...run.usage },
    turns: run.turns,
    activity: run.activity.map((entry) => ({ ...entry })),
    latestActivity: run.activity.at(-1)?.text,
    currentTool: run.currentTool,
    effectiveModel: run.effectiveModel,
    effectiveThinking: run.effectiveThinking,
    capabilityNames: [...run.capabilityNames],
    capabilityPolicy: capabilityPolicySnapshot(run.capabilityPolicy),
    worktree: run.worktree ? { ...run.worktree } : undefined,
    candidate: run.candidate
      ? { files: [...run.candidate.files], hasChanges: run.candidate.hasChanges }
      : undefined,
    integrationRequestId: run.integrationRequestId,
    completionReported: run.completionReported,
    hidden: run.profile.hidden,
  };
}
