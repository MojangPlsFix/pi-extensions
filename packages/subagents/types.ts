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

export type TerminationReasonCode =
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

export type EffectiveRunLimits = {
  maxWallSeconds: number;
  maxTurns: number | "notApplicable";
  wrapUpRatio: number;
  tokenBudget?: number;
  costBudget?: number;
};

export type RunLease = {
  id: string;
  generation: number;
  startedAt: string;
  acceptedAt?: string;
  wrapAt: string;
  deadlineAt: string;
  wrapTriggeredAt?: string;
  wrapCause?: "wall" | "turn";
  endedAt?: string;
  endReason?: TerminationReasonCode;
  effectiveLimits: EffectiveRunLimits;
};

export type StatusTransition = {
  from?: RunStatus;
  to: RunStatus;
  at: string;
  generation: number;
  cause: string;
};

export type RunOperation = {
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

export type StructuredTerminationReason = {
  code: TerminationReasonCode;
  at: string;
  generation: number;
  phase?: "startup" | "execution" | "finalization" | "cleanup";
  limit?: { kind: "wall" | "turn" | "token" | "cost"; maximum: number; observed: number };
  ancestorRunId?: string;
};

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
  candidateId: string;
  baseCommit: string;
  patchBase64: string;
  /** Legacy persisted UTF-8 patch; normalized during restore. */
  patch?: string;
  files: string[];
  hasChanges: boolean;
};

export type TaskOwnership = {
  key: string;
  owns: string[];
  deliverable: string;
  acceptance: string;
  stopConditions: string[];
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
  /** Immutable limits captured on first allocation. Revival may only tighten them. */
  originalEffectiveLimits: EffectiveRunLimits;
  leaseHistory: RunLease[];
  activeLeaseGeneration?: number;
  statusChangedAt: string;
  statusTransitions: StatusTransition[];
  lastEventAt?: string;
  currentOperation?: RunOperation;
  terminationReason?: StructuredTerminationReason;
  terminationHistory: StructuredTerminationReason[];
  wrappingUp: boolean;
  blockedSince?: string;
  sessionDir: string;
  sessionFile?: string;
  report: string;
  error?: string;
  /** A cleanup quarantine that keeps unsafe-to-remove worktree state in retained history. */
  cleanupFailure?: { at: string; message: string };
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
  /** The exact terminal lease generation whose result was delivered or explicitly collected. */
  completionAcknowledgedGeneration?: number;
  /** Legacy compatibility field; it is not authoritative for terminal acknowledgement. */
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
  candidate?: { candidateId: string; files: string[]; hasChanges: boolean };
  capabilityPolicy: EffectiveCapabilityPolicy;
};

export type DispatchBatchRoute = "pi" | "owner" | "silent";
export type DispatchBatchPhase = "collecting" | "ready" | "in-flight" | "delivered" | "orphaned";

export type DispatchBatchMember = {
  runId: string;
  generation: number;
};

/** Terminal evidence captured after the member generation has completed cleanup. */
export type DispatchBatchResult = {
  runId: string;
  generation: number;
  status: Extract<RunStatus, "parked" | "failed" | "stopped">;
  terminationReason?: StructuredTerminationReason;
  report: string;
  error?: string;
  cleanupFailure?: { at: string; message: string };
  snapshot?: RunSnapshot;
  completedAt: string;
};

/** Persisted schema-v3 aggregate dispatch protocol. Membership is immutable and ordered. */
export type DispatchBatch = {
  id: string;
  sequence: number;
  members: DispatchBatchMember[];
  originSessionId: string;
  originEntryId: string | null;
  dispatchMarkerId: string | null;
  route: DispatchBatchRoute;
  ownerRunId?: string;
  codeChanging: boolean;
  reviewing?: boolean;
  phase: DispatchBatchPhase;
  results: DispatchBatchResult[];
  continuationId?: string;
  claimedBy?: string;
  claimedAt?: string;
  createdAt: string;
  updatedAt: string;
  readyAt?: string;
  inFlightAt?: string;
  deliveredAt?: string;
  orphanedAt?: string;
  foldedResultKeys?: string[];
};

export type DispatchBatchCounts = {
  open: number;
  ready: number;
  inFlight: number;
};

export type RunSummary = {
  active: number;
  running: number;
  wrappingUp: number;
  blocked: number;
  parked: number;
  failed: number;
  stopped: number;
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
      stopConditions: [...run.ownership.stopConditions],
    },
    status: run.status,
    runner: run.runner,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    originalEffectiveLimits: { ...run.originalEffectiveLimits },
    leaseHistory: run.leaseHistory.map((lease) => ({
      ...lease,
      effectiveLimits: { ...lease.effectiveLimits },
    })),
    activeLeaseGeneration: run.activeLeaseGeneration,
    statusChangedAt: run.statusChangedAt,
    statusTransitions: run.statusTransitions.map((transition) => ({ ...transition })),
    lastEventAt: run.lastEventAt,
    currentOperation: run.currentOperation ? { ...run.currentOperation } : undefined,
    terminationReason: run.terminationReason
      ? {
          ...run.terminationReason,
          limit: run.terminationReason.limit ? { ...run.terminationReason.limit } : undefined,
        }
      : undefined,
    terminationHistory: run.terminationHistory.map((reason) => ({
      ...reason,
      limit: reason.limit ? { ...reason.limit } : undefined,
    })),
    wrappingUp: run.wrappingUp,
    blockedSince: run.blockedSince,
    elapsedMs: Math.max(
      0,
      (run.finishedAt ? Date.parse(run.finishedAt) : now) - Date.parse(run.startedAt),
    ),
    sessionDir: run.sessionDir,
    sessionFile: run.sessionFile,
    report: run.report,
    error: run.error,
    cleanupFailure: run.cleanupFailure ? { ...run.cleanupFailure } : undefined,
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
      ? {
          candidateId: run.candidate.candidateId,
          files: [...run.candidate.files],
          hasChanges: run.candidate.hasChanges,
        }
      : undefined,
    integrationRequestId: run.integrationRequestId,
    completionAcknowledgedGeneration: run.completionAcknowledgedGeneration,
    completionReported: run.completionReported,
    hidden: run.profile.hidden,
  };
}
