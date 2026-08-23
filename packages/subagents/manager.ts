import { promises as fs } from "node:fs";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai/compat";
import {
  CONFIG_DIR_NAME,
  defineTool,
  type ExtensionAPI,
  type ExtensionContext,
  type InlineExtension,
  type ModelRuntime,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { events } from "../../shared/events.js";
import {
  type AgentDiagnostic,
  discoverAgents,
  ejectBuiltinProfile,
  profileAuthorityDiagnostics,
  safeName,
} from "./agents.js";
import {
  capabilityCeilingDiagnostics,
  type EffectiveCapabilityPolicy,
  matchesAnyExecutableArgvPrefix,
  matchesAnyToolPattern,
} from "./capabilities.js";
import {
  AGENT_DIR,
  CONFIG_PATH,
  DEFAULT_SUBAGENT_CONFIG,
  type ExternalRunnerDefinition,
  loadSubagentConfig,
  type ModelSelection,
  PI_AGENT_DIR,
  type RuntimeLimits,
  resolveAgentCapabilities,
  resolveAgentModelPolicy,
  SESSION_ROOT,
  type SubagentConfig,
  type ThinkingPolicy,
  updateProfileControl,
} from "./config.js";
import {
  buildEvaluationTraceV1,
  type EvaluationActivityV1,
  type EvaluationCapacityPointV1,
  type EvaluationRequestV1,
  type EvaluationTraceV1,
} from "./evaluation.js";
import { HerdrClient } from "./herdr-client.js";
import { HerdrInspectorManager } from "./herdr-inspector.js";
import { NativeBackend, type NativeRunEvent } from "./native-backend.js";
import {
  type DispatchContextMode,
  type DispatchTask,
  findOwnershipOverlap,
  ORCHESTRATION_GUIDELINES,
  TaskClaimRegistry,
  validateDispatchBatch,
} from "./orchestration.js";
import { ExternalProcessBackend, RpcProcessBackend } from "./process-backends.js";
import { RunStore } from "./run-store.js";
import {
  SupervisorInbox,
  type SupervisorRequest,
  type SupervisorRequestInput,
} from "./supervisor.js";
import {
  type AgentDefinition,
  capabilityPolicySnapshot,
  type DispatchBatch,
  type DispatchBatchCounts,
  type DispatchBatchResult,
  type EffectiveRunLimits,
  emptyUsage,
  type ProfileClass,
  type RunActivityKind,
  type RunLease,
  type RunOperation,
  type RunRecord,
  type RunSnapshot,
  runSnapshot,
  type StructuredTerminationReason,
  type TerminationReasonCode,
  type Usage,
} from "./types.js";
import {
  applyCandidate,
  captureWorktreeCandidate,
  createMissionWorktree,
  type MissionWorktree,
  removeMissionWorktree,
  validateMissionWorktree,
  type WorktreeCandidate,
} from "./worktrees.js";

export type DispatchInput = DispatchTask;
export type CollectMode = "none" | "next" | "all";
export type CollectWaitReason = "settled" | "blocked" | "timeout" | "aborted";
export type CollectResult = { runs: RunSnapshot[]; waitReason?: CollectWaitReason };

export type MissionStatus = "running" | "blocked" | "parked" | "failed" | "integrated";
export type MissionRecord = {
  id: string;
  task: string;
  scope: string[];
  status: MissionStatus;
  orchestratorId: string;
  startedAt: string;
  finishedAt?: string;
  workspace: "shared" | "worktree";
  worktree?: MissionWorktree;
  candidate?: WorktreeCandidate;
  integrationRequestId?: string;
  cleanupFailure?: { at: string; message: string };
};

export type MissionSnapshot = Omit<MissionRecord, "candidate"> & {
  candidate?: { files: string[]; hasChanges: boolean };
};

export type HubSnapshot = {
  runs: RunSnapshot[];
  batches: DispatchBatch[];
  batchCounts: DispatchBatchCounts;
  requests: SupervisorRequest[];
  missions: MissionSnapshot[];
  profiles: AgentDefinition[];
  diagnostics: AgentDiagnostic[];
  capacity: {
    used: number;
    limit: number;
    free: number;
    sharedWritersUsed: number;
    sharedWritersLimit: number;
  };
  herdr: { enabled: boolean; available: boolean };
};

export type SubagentManagerDependencies = {
  native?: NativeBackend;
  rpc?: RpcProcessBackend;
  external?: ExternalProcessBackend;
  inspectors?: HerdrInspectorManager;
  loadConfig?: () => Promise<SubagentConfig>;
  discoverProfiles?: typeof discoverAgents;
  sessionRoot?: string;
};

type DispatchOptions = {
  parentId?: string;
  missionId?: string;
  cwd?: string;
  modelOverride?: ModelSelection;
  toolCallId?: string;
  route?: DispatchBatch["route"];
};

type PreparedRun = {
  task: DispatchTask;
  profile: AgentDefinition;
  config: SubagentConfig;
  capabilities: EffectiveCapabilityPolicy;
  model?: Model<any>;
  modelName?: string;
  thinking?: string;
  externalRunner?: ExternalRunnerDefinition;
  cwd: string;
};

const ACTIVE_STATUSES = new Set<RunRecord["status"]>(["queued", "starting", "running", "blocked"]);
const WRITE_CLASSES = new Set<ProfileClass>(["write"]);
const ASSISTANT_WRITING_ACTIVITY = "writing response";
const DEFAULT_COLLECT_TIMEOUT_SECONDS = 60;
const WRAP_ENTRY_TYPE = "subagent-wrap-v1";
const DISPATCH_MARKER_ENTRY_TYPE = "subagent-dispatch-marker-v1";
const COMPLETION_MESSAGE_TYPE = "subagent-completion-v3";
const COMPLETION_PRODUCER_ID = "hackler-batches-v3";

type LeaseRuntime = {
  generation: number;
  controller: AbortController;
  phase: "active" | "completing" | "terminalizing" | "closed";
  idle: boolean;
  wrapTimer?: ReturnType<typeof setTimeout>;
  deadlineTimer?: ReturnType<typeof setTimeout>;
  completion?: Promise<void>;
  terminalization?: Promise<void>;
  resolveDone: () => void;
  done: Promise<void>;
  wrapDelivery:
    | "none"
    | "queued"
    | "sending"
    | "sent"
    | "failed"
    | "external_warning"
    | "suppressed_no_turns";
};

type ParentWrapNotice = { runId: string; cause: "wall" | "turn"; at: string };

function iso(at = Date.now()): string {
  return new Date(at).toISOString();
}

function cloneLimits(limits: EffectiveRunLimits): EffectiveRunLimits {
  return { ...limits };
}

function terminalStatus(reason: TerminationReasonCode): RunRecord["status"] {
  if (reason === "completed" || reason === "parent_shutdown" || reason === "session_change")
    return "parked";
  if (reason === "explicit_stop" || reason === "ancestor_terminated") return "stopped";
  return "failed";
}

function usageHasValue(usage: Usage): boolean {
  return (
    usage.input !== 0 ||
    usage.output !== 0 ||
    usage.cacheRead !== 0 ||
    usage.cacheWrite !== 0 ||
    usage.total !== 0 ||
    usage.cost !== 0
  );
}

function cloneUsage(usage: Usage): Usage {
  return { ...usage };
}

function addUsage(target: Usage, source: Usage): void {
  target.input += source.input;
  target.output += source.output;
  target.cacheRead += source.cacheRead;
  target.cacheWrite += source.cacheWrite;
  target.total += source.total;
  target.cost += source.cost;
}

function usageDelta(current: Usage, accounted: Usage | undefined): Usage {
  const previous = accounted ?? emptyUsage();
  return {
    input: Math.max(0, current.input - previous.input),
    output: Math.max(0, current.output - previous.output),
    cacheRead: Math.max(0, current.cacheRead - previous.cacheRead),
    cacheWrite: Math.max(0, current.cacheWrite - previous.cacheWrite),
    total: Math.max(0, current.total - previous.total),
    cost: Math.max(0, current.cost - previous.cost),
  };
}

function stableId(source: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function parentSessionId(ctx: ExtensionContext): string {
  const manager = ctx.sessionManager as typeof ctx.sessionManager & {
    getSessionId?: () => string;
  };
  const id = manager.getSessionId?.();
  if (id) return safeName(id) || "unsaved-parent";
  const file = manager.getSessionFile();
  return safeName(file ? basename(file, ".jsonl") : "unsaved-parent") || "unsaved-parent";
}

function profileClass(profile: AgentDefinition): ProfileClass {
  return profile.class;
}

function recordActivity(
  run: RunRecord,
  kind: RunActivityKind,
  text: string,
): { at: string; kind: RunActivityKind } {
  const at = new Date().toISOString();
  run.activity.push({
    at,
    kind,
    text: text.replace(/\s+/gu, " ").trim(),
  });
  run.lastEventAt = at;
  if (run.activity.length > 200) run.activity.splice(0, run.activity.length - 200);
  return { at, kind };
}

function profileClone(profile: AgentDefinition): AgentDefinition {
  return {
    ...profile,
    tools: [...(profile.tools ?? [])],
    capabilities: [...(profile.capabilities ?? [])],
    skills: [...(profile.skills ?? [])],
    allowedNestedProfiles: [...(profile.allowedNestedProfiles ?? [])],
    metadata: profile.metadata ? { ...profile.metadata } : undefined,
  };
}

function messageText(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const entry = message as { type?: unknown; message?: unknown };
  if (entry.type === "message" && entry.message) return messageText(entry.message);
  const candidate = message as { role?: string; content?: unknown };
  if (candidate.role !== "user" && candidate.role !== "assistant") return "";
  if (typeof candidate.content === "string") return `${candidate.role}: ${candidate.content}`;
  if (!Array.isArray(candidate.content)) return "";
  const text = candidate.content
    .filter((part): part is { type: "text"; text: string } =>
      Boolean(
        part &&
          typeof part === "object" &&
          (part as { type?: unknown }).type === "text" &&
          typeof (part as { text?: unknown }).text === "string",
      ),
    )
    .map((part) => part.text)
    .join("\n");
  return text ? `${candidate.role}: ${text}` : "";
}

function filteredParentContext(ctx: ExtensionContext, mode: DispatchContextMode): string {
  if (mode === "fresh") return "";
  const manager = ctx.sessionManager as unknown as {
    buildSessionContext?: () => { messages?: unknown[] };
    buildContextEntries?: () => unknown[];
  };
  const raw = manager.buildSessionContext?.().messages ?? manager.buildContextEntries?.() ?? [];
  const messages = raw.map(messageText).filter(Boolean);
  const selected =
    mode === "plan"
      ? messages.filter((entry) => entry.includes("<proposed_plan>")).slice(-1)
      : messages.slice(-8);
  if (!selected.length) return "";
  return `<filtered_parent_context mode="${mode}">\n${selected.join("\n\n").slice(-12_000)}\n</filtered_parent_context>\n\n`;
}

function riskReason(toolName: string, input: unknown): string | undefined {
  if (toolName !== "bash" || !input || typeof input !== "object") return undefined;
  const command = (input as { command?: unknown }).command;
  if (typeof command !== "string") return undefined;
  if (
    /\b(?:sudo|su)\b|\brm\s+-[^\n]*r|\bgit\s+push\b|\b(?:npm|pnpm|yarn)\s+publish\b/iu.test(command)
  )
    return "destructive, privileged, push, or publish command";
  if (/\b(?:npm|pnpm|yarn|pip|uv)\s+(?:install|add|remove|uninstall)\b/iu.test(command))
    return "dependency mutation";
  if (/\b(?:curl|wget|nc|ssh|scp)\b/iu.test(command)) return "new external network operation";
  return undefined;
}

function summarizeToolInput(input: unknown): string {
  try {
    const serialized = JSON.stringify(input, null, 2);
    return (serialized ?? String(input)).slice(0, 4_000);
  } catch {
    return String(input).slice(0, 4_000);
  }
}

function textResult(text: string, isError = false) {
  return {
    content: [{ type: "text" as const, text }],
    details: {},
    ...(isError ? { isError: true } : {}),
  };
}

export class SubagentManager {
  readonly store = new RunStore();
  readonly inbox = new SupervisorInbox();
  readonly claims = new TaskClaimRegistry();
  private readonly native: NativeBackend;
  private readonly rpc: RpcProcessBackend;
  private readonly external: ExternalProcessBackend;
  private readonly inspectors: HerdrInspectorManager;
  private readonly loadConfig: () => Promise<SubagentConfig>;
  private readonly discoverProfiles: typeof discoverAgents;
  private readonly sessionRoot: string;
  private readonly missions = new Map<string, MissionRecord>();
  private readonly batches = new Map<string, DispatchBatch>();
  private batchSequence = 0;
  private readonly batchRoutes = new Map<string, Promise<void>>();
  private readonly pendingContinuationReceipts = new Map<
    string,
    { status: "settled" | "cancelled" }
  >();
  private readonly missionFinalizers = new Map<string, Promise<void>>();
  private readonly requestResponses = new Map<
    string,
    { answer: string; promise: Promise<SupervisorRequest> }
  >();
  private readonly hubListeners = new Set<(snapshot: HubSnapshot) => void>();
  private readonly leaseRuntimes = new Map<string, LeaseRuntime>();
  private readonly parentWrapNotices: ParentWrapNotice[] = [];
  private evaluationActivities: EvaluationActivityV1[] = [];
  private evaluationCapacity: EvaluationCapacityPointV1[] = [];
  private evaluationRequests = new Map<string, EvaluationRequestV1>();
  private runtimeLimits: RuntimeLimits = { ...DEFAULT_SUBAGENT_CONFIG.runtime };
  private planMode = false;
  private profiles: AgentDefinition[] = [];
  private diagnostics: AgentDiagnostic[] = [];
  private herdr = { enabled: false, available: false };
  private ctx?: ExtensionContext;
  private shutdownPromise?: Promise<void>;
  private readonly shutdownController = new AbortController();
  private restoredParent?: string;
  private persistenceTail: Promise<void> = Promise.resolve();
  private dispatchTail: Promise<void> = Promise.resolve();
  private persistTimer?: ReturnType<typeof setTimeout>;
  private readonly unsubscribePlanMode: () => void;
  private readonly unsubscribePlanReview: () => void;
  private readonly unsubscribeContinuationReceipt: () => void;

  constructor(
    private readonly pi: ExtensionAPI,
    dependencies: SubagentManagerDependencies = {},
  ) {
    this.native = dependencies.native ?? new NativeBackend();
    this.rpc = dependencies.rpc ?? new RpcProcessBackend();
    this.external = dependencies.external ?? new ExternalProcessBackend();
    this.inspectors = dependencies.inspectors ?? new HerdrInspectorManager();
    this.loadConfig = dependencies.loadConfig ?? (() => loadSubagentConfig());
    this.discoverProfiles = dependencies.discoverProfiles ?? discoverAgents;
    this.sessionRoot = dependencies.sessionRoot ?? SESSION_ROOT;
    const plan = pi.events.on(events.planMode, (data: unknown) => {
      this.planMode = (data as { enabled?: boolean }).enabled === true;
    });
    this.unsubscribePlanMode = typeof plan === "function" ? plan : () => {};
    const review = pi.events.on(events.planReview, (data: unknown) => {
      const request = data as {
        task?: string;
        model?: string;
        thinking?: string;
        ctx?: ExtensionContext;
        accept?: () => void;
        respond?: (result: {
          reviewerId?: string;
          model?: string;
          thinking?: string;
          report?: string;
          error?: string;
        }) => void;
      };
      if (!request.task || !request.ctx || !request.respond) return;
      request.accept?.();
      void this.runPlanReview(request.task, request.ctx, request.model, request.thinking)
        .then((result) => request.respond?.(result))
        .catch((error: unknown) =>
          request.respond?.({ error: error instanceof Error ? error.message : String(error) }),
        );
    });
    this.unsubscribePlanReview = typeof review === "function" ? review : () => {};
    const receipt = pi.events.on(events.continuationReceipt, (value: unknown) => {
      const event = value as {
        producerId?: string;
        requestId?: string;
        status?: "settled" | "cancelled";
      };
      if (event.producerId !== COMPLETION_PRODUCER_ID || !event.requestId || !event.status) return;
      this.pendingContinuationReceipts.set(event.requestId, { status: event.status });
      this.applyContinuationReceipt(event.requestId);
    });
    this.unsubscribeContinuationReceipt = typeof receipt === "function" ? receipt : () => {};
    this.store.subscribe(() => this.publish());
    this.inbox.subscribe(() => this.publish());
  }

  async attachUi(ctx: ExtensionContext): Promise<void> {
    this.ctx = ctx;
    const parent = parentSessionId(ctx);
    const parentChanged = this.restoredParent !== parent;
    if (parentChanged) {
      if (this.restoredParent) await this.leaveParentSession();
      this.resetEvaluationLedger();
      this.restoredParent = parent;
    }
    const config = await this.refreshProfiles(ctx);
    if (parentChanged) await this.restore(parent);
    await this.pruneRetention(config);
    this.reconcileBranch(ctx);
  }

  reconcileBranch(ctx: ExtensionContext): void {
    this.ctx = ctx;
    for (const batch of this.batches.values()) {
      if (batch.route !== "pi") continue;
      const active = this.isActiveTopLevelBatch(batch);
      this.emitBatchGate(
        batch,
        active && ["collecting", "ready", "in-flight"].includes(batch.phase),
      );
      if (active && batch.phase === "ready") void this.routeBatch(batch);
    }
    this.publish();
  }

  snapshots(): RunSnapshot[] {
    return this.store.snapshots();
  }

  pendingRequests(): SupervisorRequest[] {
    return this.inbox.open();
  }

  missionSnapshots(): MissionSnapshot[] {
    return [...this.missions.values()].map((mission) => ({
      ...mission,
      scope: [...mission.scope],
      worktree: mission.worktree ? { ...mission.worktree } : undefined,
      candidate: mission.candidate
        ? { files: [...mission.candidate.files], hasChanges: mission.candidate.hasChanges }
        : undefined,
    }));
  }

  private appendActivity(run: RunRecord, kind: RunActivityKind, text: string): void {
    const activity = recordActivity(run, kind, text);
    this.evaluationActivities.push({ runId: run.id, ...activity });
  }

  private recordAssistantWritingActivity(run: RunRecord): void {
    const latest = run.activity.at(-1);
    if (latest?.kind === "status" && latest.text === ASSISTANT_WRITING_ACTIVITY) return;
    this.appendActivity(run, "status", ASSISTANT_WRITING_ACTIVITY);
  }

  private resetEvaluationLedger(): void {
    this.evaluationActivities = [];
    this.evaluationCapacity = [];
    this.evaluationRequests = new Map();
  }

  private updateEvaluationLedger(snapshot: HubSnapshot): void {
    const current = {
      at: iso(),
      used: snapshot.capacity.used,
      limit: snapshot.capacity.limit,
      sharedWritersUsed: snapshot.capacity.sharedWritersUsed,
      sharedWritersLimit: snapshot.capacity.sharedWritersLimit,
    };
    const previous = this.evaluationCapacity.at(-1);
    if (
      !previous ||
      previous.used !== current.used ||
      previous.limit !== current.limit ||
      previous.sharedWritersUsed !== current.sharedWritersUsed ||
      previous.sharedWritersLimit !== current.sharedWritersLimit
    )
      this.evaluationCapacity.push(current);
    for (const request of this.inbox.all())
      this.evaluationRequests.set(request.id, {
        id: request.id,
        runId: request.fromRunId,
        kind: request.kind,
        createdAt: request.createdAt,
        ...(request.resolvedAt ? { resolvedAt: request.resolvedAt } : {}),
        status: request.status,
      });
  }

  evaluationTrace(generatedAt = iso()): EvaluationTraceV1 {
    return buildEvaluationTraceV1({
      generatedAt,
      runs: this.store.all(),
      capacityTimeline: this.evaluationCapacity,
      requests: [...this.evaluationRequests.values()],
      activities: this.evaluationActivities,
    });
  }

  private activeBranchIds(): Set<string> {
    const manager = this.ctx?.sessionManager as
      | { getBranch?: () => Array<{ id?: string }> }
      | undefined;
    return new Set(
      (manager?.getBranch?.() ?? [])
        .map((entry) => entry.id)
        .filter((id): id is string => typeof id === "string"),
    );
  }

  private isActiveTopLevelBatch(batch: DispatchBatch): boolean {
    if (batch.route !== "pi") return false;
    if (this.ctx && batch.originSessionId !== parentSessionId(this.ctx)) return false;
    if (batch.originEntryId === null) return true;
    const branch = this.activeBranchIds();
    return branch.size === 0 || branch.has(batch.originEntryId);
  }

  private batchCounts(): DispatchBatchCounts {
    const active = [...this.batches.values()].filter((batch) => this.isActiveTopLevelBatch(batch));
    return {
      open: active.filter((batch) => ["collecting", "ready", "in-flight"].includes(batch.phase))
        .length,
      ready: active.filter((batch) => batch.phase === "ready").length,
      inFlight: active.filter((batch) => batch.phase === "in-flight").length,
    };
  }

  batchSnapshots(): DispatchBatch[] {
    return [...this.batches.values()]
      .sort((left, right) => left.sequence - right.sequence)
      .map((batch) => structuredClone(batch));
  }

  hubSnapshot(): HubSnapshot {
    const summary = this.store.summary();
    return {
      runs: this.snapshots(),
      batches: this.batchSnapshots(),
      batchCounts: this.batchCounts(),
      requests: this.inbox.all(),
      missions: this.missionSnapshots(),
      profiles: this.profiles.map(profileClone),
      diagnostics: this.diagnostics.map((diagnostic) => ({ ...diagnostic })),
      capacity: {
        used: summary.active,
        limit: this.runtimeLimits.maxActive,
        free: Math.max(0, this.runtimeLimits.maxActive - summary.active),
        sharedWritersUsed: this.claims
          .all()
          .filter((claim) => claim.kind === "write" && claim.workspace === "shared").length,
        sharedWritersLimit: this.runtimeLimits.maxSharedWriters,
      },
      herdr: { ...this.herdr },
    };
  }

  subscribeHub(listener: (snapshot: HubSnapshot) => void): () => void {
    this.hubListeners.add(listener);
    listener(this.hubSnapshot());
    return () => this.hubListeners.delete(listener);
  }

  guardParentTool(toolName: string, input: unknown): { block: true; reason: string } | undefined {
    if (!input || typeof input !== "object") return undefined;
    const claims = this.claims.all();
    if (!claims.length) return undefined;
    const value = input as Record<string, unknown>;
    if (["edit", "write", "apply_patch"].includes(toolName)) {
      const path = value.path;
      if (typeof path !== "string" || !path.trim()) return undefined;
      const ownedPath = isAbsolute(path) && this.ctx ? relative(this.ctx.cwd, path) : path;
      if (!ownedPath || ownedPath === ".." || ownedPath.replaceAll("\\", "/").startsWith("../"))
        return undefined;
      const claim = claims.find((candidate) =>
        findOwnershipOverlap([`path:${ownedPath}`], candidate.owns),
      );
      if (claim)
        return {
          block: true,
          reason: `Hackler run ${claim.runId} owns ${claim.owns.join(", ")}. Stop or collect that run before editing its scope in the parent.`,
        };
    }
    if (toolName === "bash" && typeof value.command === "string") {
      const command = value.command.replaceAll("\\", "/");
      const claim = claims.find((candidate) =>
        candidate.owns
          .filter((scope) => /^path:/iu.test(scope) || !/^(?:symbol|topic):/iu.test(scope))
          .map((scope) => scope.replace(/^path:\s*/iu, "").replace(/^\.\//u, ""))
          .filter(Boolean)
          .some((scope) => command.includes(scope)),
      );
      if (claim)
        return {
          block: true,
          reason: `Hackler run ${claim.runId} owns a path referenced by this command.`,
        };
    }
    return undefined;
  }

  parentGuidance(systemPrompt: string): string {
    const activeMission = [...this.missions.values()].find((mission) =>
      ["running", "blocked"].includes(mission.status),
    );
    const missionNotice = activeMission
      ? `\n\nAn in-session orchestrator exclusively owns mission ${activeMission.id}: ${activeMission.task}\nOwned scope: ${activeMission.scope.join(", ")}. Do not duplicate or modify that scope. Continue only unrelated work, answer supervisor requests, or explicitly take over through /agents.`
      : "";
    const inferred = this.profiles
      .filter(
        (profile) =>
          profile.infer &&
          !profile.hidden &&
          profile.metadata?.disabled !== true &&
          profile.metadata?.enabled !== false,
      )
      .map((profile) => `${profile.name} (${profile.class}): ${profile.description}`)
      .join("\n");
    const profileNotice = inferred
      ? `\n\nAvailable inferred profiles:\n${inferred}\nSelect a profile by its declared specialty. Do not send the same task or ownership to multiple profiles.`
      : "";
    const supervisorNotice =
      "\n\nIf a child reports a pending supervisor request, inspect it with subagent_status and resolve it with subagent_respond before waiting again. Use bounded collection, act on its wait reason, and do not poll immediately after a timeout.";
    const wrapNotices = this.parentWrapNotices.splice(0);
    const wrapNotice = wrapNotices.length
      ? `\n\nHackler limit notice: ${wrapNotices
          .map(
            (notice) =>
              `${notice.runId} began wrapping up because of its ${notice.cause} budget at ${notice.at}`,
          )
          .join("; ")}. This is status context only; do not steer the parent turn on its behalf.`
      : "";
    return `${systemPrompt}\n\n${ORCHESTRATION_GUIDELINES}${supervisorNotice}${profileNotice}${missionNotice}${wrapNotice}`;
  }

  private assertOpen(): void {
    if (this.shutdownController.signal.aborted || this.shutdownPromise)
      throw new Error("The parent session is shutting down.");
  }

  private publish(force = false): void {
    if (this.shutdownController.signal.aborted && !force) {
      if (this.restoredParent) this.updateEvaluationLedger(this.hubSnapshot());
      return;
    }
    const snapshot = this.hubSnapshot();
    if (this.restoredParent) this.updateEvaluationLedger(snapshot);
    const summary = this.store.summary();
    const blockingRequests = snapshot.requests.filter(
      (request) => request.blocking && request.status === "pending",
    );
    const oldestBlockingRequest = blockingRequests[0];
    this.pi.events.emit(events.subagentsStatus, {
      ...summary,
      capacity: snapshot.capacity,
      batches: snapshot.batchCounts,
      blockingRequestCount: blockingRequests.length,
      ...(oldestBlockingRequest
        ? {
            oldestBlockingRequest: {
              id: oldestBlockingRequest.id,
              title: oldestBlockingRequest.title,
              createdAt: oldestBlockingRequest.createdAt,
              action: "open /agents inbox and answer",
            },
          }
        : {}),
      agents: snapshot.runs.sort((left, right) => {
        const priority = (value: RunSnapshot) =>
          value.status === "blocked"
            ? 0
            : value.wrappingUp
              ? 1
              : value.status === "failed"
                ? 2
                : value.status === "stopped"
                  ? 3
                  : ACTIVE_STATUSES.has(value.status)
                    ? 4
                    : 5;
        return priority(left) - priority(right);
      }),
    });
    const activeWriterRunIds = new Set(
      snapshot.batches
        .filter(
          (batch) =>
            batch.codeChanging &&
            ["collecting", "ready", "in-flight"].includes(batch.phase) &&
            (batch.route !== "pi" || this.isActiveTopLevelBatch(batch)),
        )
        .flatMap((batch) => batch.members.map((member) => member.runId)),
    );
    this.pi.events.emit(events.hacklerActivity, {
      active: summary.active,
      writers: snapshot.runs.filter(
        (run) =>
          activeWriterRunIds.has(run.id) &&
          ["write", "orchestrator"].includes(run.profileClass ?? "") &&
          ACTIVE_STATUSES.has(run.status),
      ).length,
      integrating:
        snapshot.batches.filter(
          (batch) =>
            batch.codeChanging &&
            batch.phase === "in-flight" &&
            (batch.route !== "pi" || this.isActiveTopLevelBatch(batch)),
        ).length +
        snapshot.requests.filter(
          (request) => request.kind === "integration-ready" && request.status === "pending",
        ).length,
      relevantBatchIds: snapshot.batches
        .filter(
          (batch) =>
            batch.codeChanging &&
            ["collecting", "ready", "in-flight"].includes(batch.phase) &&
            (batch.route !== "pi" || this.isActiveTopLevelBatch(batch)),
        )
        .map((batch) => batch.id),
    });
    this.pi.events.emit(events.subagentsHub, snapshot);
    for (const listener of this.hubListeners) listener(snapshot);
    this.queuePersist();
  }

  private async refreshProfiles(ctx: ExtensionContext): Promise<SubagentConfig> {
    const discovered = await this.discoverProfiles({
      cwd: ctx.cwd,
      trustedProject: ctx.isProjectTrusted(),
    });
    let config: SubagentConfig;
    const diagnostics = [...discovered.diagnostics];
    try {
      config = await this.loadConfig();
    } catch (cause) {
      diagnostics.push({
        path: CONFIG_PATH,
        code: "config-error",
        message: cause instanceof Error ? cause.message : String(cause),
      });
      config = {
        ...DEFAULT_SUBAGENT_CONFIG,
        runtime: { ...DEFAULT_SUBAGENT_CONFIG.runtime },
        retention: { ...DEFAULT_SUBAGENT_CONFIG.retention },
        models: { overrides: {} },
        capabilities: {},
        runners: {},
        herdr: { ...DEFAULT_SUBAGENT_CONFIG.herdr },
        profiles: {},
      };
    }
    this.runtimeLimits = { ...config.runtime };
    this.profiles = discovered.profiles.map((profile) => ({
      ...profileClone(profile),
      metadata: config.profiles[profile.name] ? { ...config.profiles[profile.name] } : undefined,
    }));
    const knownProfiles = new Set(this.profiles.map((profile) => profile.name));
    for (const name of Object.keys(config.models.overrides))
      if (!knownProfiles.has(name))
        diagnostics.push({
          path: CONFIG_PATH,
          code: "config-error",
          message: `models.overrides.${name} does not match a discovered profile.`,
        });
    for (const name of Object.keys(config.profiles))
      if (!knownProfiles.has(name))
        diagnostics.push({
          path: CONFIG_PATH,
          code: "config-error",
          message: `profiles.${name} does not match a discovered profile.`,
        });
    for (const name of Object.keys(config.runners)) {
      const profile = this.profiles.find((candidate) => candidate.name === name);
      if (profile?.runner !== "external")
        diagnostics.push({
          path: CONFIG_PATH,
          code: "config-error",
          message: `runners.${name} does not match an external profile.`,
        });
    }
    for (const profile of this.profiles) {
      const authority = profileAuthorityDiagnostics(profile);
      const capabilities = resolveAgentCapabilities(profile, config);
      capabilities.diagnostics.push(...capabilityCeilingDiagnostics(profile, capabilities));
      for (const message of [
        ...authority,
        ...capabilities.diagnostics.map((entry) => entry.message),
      ])
        diagnostics.push({
          path: profile.path ?? `builtin:${profile.name}`,
          code: "policy",
          message,
        });
      if (profile.runner === "external" && !config.runners[profile.name])
        diagnostics.push({
          path: profile.path ?? `builtin:${profile.name}`,
          code: "policy",
          message: `External profile ${profile.name} requires runners.${profile.name}.`,
        });
    }
    this.diagnostics = diagnostics;
    this.herdr = {
      enabled: config.herdr.enabled,
      available: HerdrClient.environmentState() === "complete",
    };
    return config;
  }

  private async leaveParentSession(): Promise<void> {
    const active = this.store.active();
    const activeIds = new Set(active.map((run) => run.id));
    await Promise.all(
      active
        .filter((run) => !run.parentId || !activeIds.has(run.parentId))
        .map((run) => this.beginTermination(run, "session_change", { phase: "cleanup" })),
    );
    for (const mission of this.missions.values())
      if (mission.status === "running" || mission.status === "blocked") mission.status = "parked";
    await this.inspectors.shutdown();
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = undefined;
    this.enqueuePersist();
    await this.persistenceTail;
    this.restoredParent = undefined;
    this.store.clear();
    this.inbox.reset();
    this.claims.clear();
    this.missions.clear();
    this.batches.clear();
    this.batchRoutes.clear();
    this.pendingContinuationReceipts.clear();
    this.batchSequence = 0;
    this.leaseRuntimes.clear();
    this.parentWrapNotices.length = 0;
  }

  private async pruneRetention(config: SubagentConfig): Promise<void> {
    const candidates = this.store.prune(config.retention);
    const removed: RunRecord[] = [];
    for (const run of candidates) {
      try {
        if (run.worktree) {
          await removeMissionWorktree(run.worktree, { force: true });
          run.worktree = undefined;
          run.candidate = undefined;
        }
        const child = relative(this.sessionRoot, run.sessionDir);
        if (!child || child.startsWith("..") || child.split(/[\\/]/u).includes(".."))
          throw new Error(`Refused to remove unsafe session directory ${run.sessionDir}.`);
        await fs.rm(run.sessionDir, { recursive: true, force: true });
        removed.push(run);
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        run.cleanupFailure = { at: iso(), message };
        run.error = `Retention cleanup failed: ${message}`;
        this.appendActivity(run, "error", run.error);
        this.store.add(run);
        this.diagnostics.push({
          path: this.statePath(this.restoredParent ?? "unknown-parent"),
          code: "read-error",
          message: `Run ${run.id} was retained after cleanup failed: ${message}`,
        });
      }
    }
    const removedIds = new Set(removed.map((run) => run.id));
    if (removedIds.size) {
      this.evaluationActivities = this.evaluationActivities.filter(
        (activity) => !removedIds.has(activity.runId),
      );
      for (const [requestId, request] of this.evaluationRequests)
        if (removedIds.has(request.runId)) this.evaluationRequests.delete(requestId);
      const retainedStarts = this.store.all().map((run) => Date.parse(run.startedAt));
      if (retainedStarts.length) {
        const earliest = Math.min(...retainedStarts);
        const baseline = [...this.evaluationCapacity]
          .reverse()
          .find((point) => Date.parse(point.at) <= earliest);
        this.evaluationCapacity = [
          ...(baseline ? [baseline] : []),
          ...this.evaluationCapacity.filter((point) => Date.parse(point.at) > earliest),
        ];
      } else this.evaluationCapacity = this.evaluationCapacity.slice(-1);
    }
    for (const [id, mission] of this.missions) {
      if (!removedIds.has(mission.orchestratorId)) continue;
      try {
        if (mission.worktree) {
          await removeMissionWorktree(mission.worktree, { force: true });
          mission.worktree = undefined;
          mission.candidate = undefined;
        }
        this.missions.delete(id);
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        mission.status = "failed";
        mission.cleanupFailure = { at: iso(), message };
        this.diagnostics.push({
          path: this.statePath(this.restoredParent ?? "unknown-parent"),
          code: "read-error",
          message: `Mission ${mission.id} was retained after cleanup failed: ${message}`,
        });
      }
    }
  }

  async status(ctx: ExtensionContext): Promise<HubSnapshot> {
    await this.attachUi(ctx);
    return this.hubSnapshot();
  }

  async setProfileEnabled(
    name: string,
    enabled: boolean,
    ctx: ExtensionContext,
  ): Promise<AgentDefinition> {
    await this.attachUi(ctx);
    const profile = this.profiles.find((candidate) => candidate.name === name);
    if (!profile) throw new Error(`Unknown profile: ${name}.`);
    await updateProfileControl(name, { enabled, disabled: !enabled });
    await this.refreshProfiles(ctx);
    this.publish();
    return profileClone(this.profiles.find((candidate) => candidate.name === name) ?? profile);
  }

  async ejectProfile(
    name: string,
    target: "user" | "project",
    ctx: ExtensionContext,
  ): Promise<string> {
    await this.attachUi(ctx);
    if (target === "project" && !ctx.isProjectTrusted())
      throw new Error("Project profile ejection requires an explicitly trusted project.");
    const directory = target === "user" ? AGENT_DIR : join(ctx.cwd, CONFIG_DIR_NAME, "agents");
    const path = await ejectBuiltinProfile(name, directory);
    await updateProfileControl(name, { ejected: true, enabled: true, disabled: false });
    await this.refreshProfiles(ctx);
    this.publish();
    return path;
  }

  private batchForMember(runId: string, generation: number): DispatchBatch | undefined {
    return [...this.batches.values()].find((batch) =>
      batch.members.some((member) => member.runId === runId && member.generation === generation),
    );
  }

  private batchContent(batch: DispatchBatch): string {
    const results = batch.members
      .map((member) =>
        batch.results.find(
          (result) => result.runId === member.runId && result.generation === member.generation,
        ),
      )
      .filter((result): result is DispatchBatchResult => Boolean(result));
    return [
      `Hackler batch ${batch.id} · ${results.length} result${results.length === 1 ? "" : "s"}`,
      ...results.map((result) => {
        const run = result.snapshot;
        const label = run?.name ?? result.runId;
        const reason = result.terminationReason?.code ?? "legacy_unknown";
        const evidence =
          result.status === "failed"
            ? `Failure reason: ${reason}${result.error ? ` · ${result.error}` : ""}${result.report ? `\n\nPartial report:\n${result.report}` : ""}`
            : result.status === "stopped"
              ? `Stop reason: ${reason}${result.error ? ` · ${result.error}` : ""}${result.report ? `\n\nPartial report:\n${result.report}` : ""}`
              : result.report || result.error || "(no report)";
        const cleanup = result.cleanupFailure
          ? `\n\nCleanup retained: ${result.cleanupFailure.message}`
          : "";
        return `\n## ${label} · ${result.status}\n${evidence}${cleanup}`;
      }),
    ].join("\n");
  }

  private emitBatchGate(
    batch: DispatchBatch,
    active: boolean,
    phase?: "dispatch" | "running" | "review" | "integration",
  ): void {
    const branchActive = batch.route !== "pi" || this.isActiveTopLevelBatch(batch);
    this.pi.events.emit(events.hacklerBatchGate, {
      batchId: batch.id,
      active: active && branchActive,
      relevant: batch.codeChanging || batch.reviewing === true,
      phase:
        phase ??
        (batch.phase === "collecting" ? "running" : batch.codeChanging ? "integration" : "review"),
    });
  }

  private registerBatch(
    members: Array<{ runId: string; generation: number }>,
    prepared: PreparedRun[],
    ctx: ExtensionContext,
    options: DispatchOptions,
  ): DispatchBatch {
    const route =
      options.route ??
      (options.parentId
        ? "owner"
        : prepared.every((item) => item.profile.hidden)
          ? "silent"
          : "pi");
    const sessionId = parentSessionId(ctx);
    const identity = options.toolCallId
      ? `${sessionId}\u0000${options.parentId ?? "pi"}\u0000${options.toolCallId}`
      : `${sessionId}\u0000${options.parentId ?? "pi"}\u0000dispatch-${this.batchSequence + 1}`;
    const id = `batch-${stableId(identity)}`;
    const existing = this.batches.get(id);
    if (existing) throw new Error(`Hackler dispatch batch ${id} is already registered.`);
    const appendEntry = (
      this.pi as ExtensionAPI & { appendEntry?: (customType: string, data: unknown) => void }
    ).appendEntry;
    appendEntry?.(DISPATCH_MARKER_ENTRY_TYPE, {
      schemaVersion: 1,
      batchId: id,
      sessionId,
      toolCallId: options.toolCallId,
      ownerRunId: options.parentId,
      members,
    });
    const sessionManager = ctx.sessionManager as typeof ctx.sessionManager & {
      getLeafId?: () => string | undefined;
    };
    const marker = sessionManager.getLeafId?.() ?? null;
    const now = iso();
    const batch: DispatchBatch = {
      id,
      sequence: ++this.batchSequence,
      members: members.map((member) => ({ ...member })),
      originSessionId: sessionId,
      originEntryId: marker,
      dispatchMarkerId: marker,
      route,
      ...(options.parentId ? { ownerRunId: options.parentId } : {}),
      codeChanging: prepared.some((item) =>
        ["write", "orchestrator"].includes(profileClass(item.profile)),
      ),
      reviewing: prepared.some((item) => profileClass(item.profile) === "review"),
      phase: "collecting",
      results: [],
      createdAt: now,
      updatedAt: now,
    };
    this.batches.set(id, batch);
    this.emitBatchGate(batch, true, "dispatch");
    this.publish();
    return batch;
  }

  private registerRevivalBatch(
    run: RunRecord,
    generation: number,
    ctx: ExtensionContext,
  ): DispatchBatch {
    const prepared = [{ profile: run.profile }] as PreparedRun[];
    return this.registerBatch([{ runId: run.id, generation }], prepared, ctx, {
      parentId: run.parentId,
      toolCallId: `revival:${run.id}:${generation}`,
      route: run.parentId ? "owner" : run.profile.hidden ? "silent" : "pi",
    });
  }

  private settleBatchMember(run: RunRecord, generation: number): void {
    const batch = this.batchForMember(run.id, generation);
    if (
      !batch ||
      batch.results.some((result) => result.runId === run.id && result.generation === generation)
    )
      return;
    const snapshot = runSnapshot(run);
    if (!["parked", "failed", "stopped"].includes(snapshot.status)) return;
    batch.results.push({
      runId: run.id,
      generation,
      status: snapshot.status as DispatchBatchResult["status"],
      terminationReason: snapshot.terminationReason
        ? structuredClone(snapshot.terminationReason)
        : undefined,
      report: snapshot.report,
      error: snapshot.error,
      cleanupFailure: snapshot.cleanupFailure ? { ...snapshot.cleanupFailure } : undefined,
      snapshot,
      completedAt: iso(),
    });
    batch.results.sort(
      (left, right) =>
        batch.members.findIndex(
          (member) => member.runId === left.runId && member.generation === left.generation,
        ) -
        batch.members.findIndex(
          (member) => member.runId === right.runId && member.generation === right.generation,
        ),
    );
    batch.updatedAt = iso();
    if (batch.phase === "orphaned") this.foldOrphanEvidence(batch);
    if (batch.phase === "collecting" && batch.results.length === batch.members.length) {
      batch.phase = "ready";
      batch.readyAt = batch.updatedAt;
      void this.routeBatch(batch);
    }
    this.publish();
  }

  private settleMissingBatchMembers(batch: DispatchBatch, message: string): void {
    for (const member of batch.members) {
      if (
        batch.results.some(
          (result) => result.runId === member.runId && result.generation === member.generation,
        )
      )
        continue;
      const run = this.store.get(member.runId);
      if (run) continue;
      const at = iso();
      batch.results.push({
        ...member,
        status: "failed",
        terminationReason: {
          code: "startup_error",
          at,
          generation: member.generation,
          phase: "startup",
        },
        report: "",
        error: message,
        completedAt: at,
      });
    }
    if (batch.results.length === batch.members.length && batch.phase === "collecting") {
      batch.phase = "ready";
      batch.readyAt = iso();
      batch.updatedAt = batch.readyAt;
      void this.routeBatch(batch);
    }
  }

  private batchDeliveryDetails(batch: DispatchBatch): {
    schemaVersion: 3;
    batch: DispatchBatch;
    runs: RunSnapshot[];
  } {
    const immutable = structuredClone(batch);
    immutable.phase = "ready";
    immutable.updatedAt = immutable.readyAt ?? immutable.createdAt;
    delete immutable.continuationId;
    delete immutable.inFlightAt;
    delete immutable.deliveredAt;
    delete immutable.orphanedAt;
    return {
      schemaVersion: 3,
      batch: immutable,
      runs: batch.results.map((result) => result.snapshot).filter(Boolean) as RunSnapshot[],
    };
  }

  private applyContinuationReceipt(requestId: string): void {
    const receipt = this.pendingContinuationReceipts.get(requestId);
    if (!receipt) return;
    const batch = [...this.batches.values()].find(
      (candidate) =>
        candidate.continuationId === requestId ||
        `${COMPLETION_PRODUCER_ID}:${candidate.id}` === requestId,
    );
    if (!batch) return;
    if (batch.phase === "delivered" || batch.phase === "orphaned") {
      this.pendingContinuationReceipts.delete(requestId);
      return;
    }
    if (batch.phase !== "in-flight") return;
    this.pendingContinuationReceipts.delete(requestId);
    if (receipt.status === "settled") this.markBatchDelivered(batch);
    else this.orphanBatch(batch, "continuation cancelled");
  }

  private routeBatch(batch: DispatchBatch): Promise<void> {
    const existing = this.batchRoutes.get(batch.id);
    if (existing) return existing;
    const operation = this.routeBatchOnce(batch).finally(() => {
      if (this.batchRoutes.get(batch.id) === operation) this.batchRoutes.delete(batch.id);
    });
    this.batchRoutes.set(batch.id, operation);
    return operation;
  }

  private async routeBatchOnce(batch: DispatchBatch): Promise<void> {
    if (batch.phase !== "ready") return;
    if (batch.route === "silent") {
      this.markBatchDelivered(batch);
      return;
    }
    if (batch.route === "owner") {
      const owner = batch.ownerRunId ? this.store.get(batch.ownerRunId) : undefined;
      const runtime = owner ? this.leaseRuntimes.get(owner.id) : undefined;
      if (!owner || !runtime || runtime.phase !== "active" || !ACTIVE_STATUSES.has(owner.status)) {
        this.orphanBatch(batch, "owning orchestrator terminated before delivery");
        return;
      }
      // Owner aggregates are follow-ups, never steering injections. Wait for a factual idle
      // boundary so collect can claim the batch while an orchestrator turn is still active.
      if (!runtime.idle) return;
      if (batch.claimedBy === owner.id) {
        this.markBatchDelivered(batch);
        if (runtime.idle && !this.hasOpenOwnedBatches(owner.id))
          await this.completeRun(owner, runtime.generation);
        return;
      }
      batch.phase = "in-flight";
      batch.inFlightAt = iso();
      batch.updatedAt = batch.inFlightAt;
      this.publish();
      try {
        if (owner.runner !== "native")
          throw new Error("Nested aggregate delivery requires a live native orchestrator.");
        await this.native.followUp(owner.id, this.batchContent(batch));
        if (batch.phase !== "in-flight") return;
        this.markBatchDelivered(batch);
        const current = this.leaseRuntimes.get(owner.id);
        if (current?.phase === "active" && !this.hasOpenOwnedBatches(owner.id))
          await this.completeRun(owner, current.generation);
      } catch (cause) {
        this.orphanBatch(
          batch,
          `owner delivery failed: ${cause instanceof Error ? cause.message : String(cause)}`,
        );
        const current = this.leaseRuntimes.get(owner.id);
        if (current?.phase === "active" && !this.hasOpenOwnedBatches(owner.id))
          await this.completeRun(owner, current.generation);
      }
      return;
    }
    const requestId = `${COMPLETION_PRODUCER_ID}:${batch.id}`;
    let response: { accepted: boolean; requestId?: string; reason?: string } | undefined;
    this.pi.events.emit(events.continuationEnqueue, {
      producerId: COMPLETION_PRODUCER_ID,
      requestId,
      dedupeKey: batch.id,
      sessionId: batch.originSessionId,
      originEntryId: batch.originEntryId,
      message: {
        customType: COMPLETION_MESSAGE_TYPE,
        content: this.batchContent(batch),
        display: true,
        details: this.batchDeliveryDetails(batch),
      },
      respond(result: { accepted: boolean; requestId?: string; reason?: string }) {
        response = result;
      },
    });
    const reconciled =
      response?.accepted === true ||
      (response?.requestId === requestId && response.reason === "deduplicated");
    if (!reconciled) {
      batch.updatedAt = iso();
      this.emitBatchGate(batch, true);
      this.publish();
      return;
    }
    batch.continuationId = response?.requestId ?? requestId;
    batch.phase = "in-flight";
    batch.inFlightAt = iso();
    batch.updatedAt = batch.inFlightAt;
    this.emitBatchGate(batch, false);
    this.publish();
    this.applyContinuationReceipt(batch.continuationId);
  }

  private markBatchDelivered(batch: DispatchBatch): void {
    if (batch.phase === "delivered") return;
    batch.phase = "delivered";
    batch.deliveredAt = iso();
    batch.updatedAt = batch.deliveredAt;
    if (batch.codeChanging || (batch.route === "pi" && batch.reviewing))
      this.pi.events.emit(events.implementationWaveAdvance, {
        producerId: COMPLETION_PRODUCER_ID,
        reason: `Hackler batch ${batch.id} completed`,
        branchEntryId: batch.originEntryId ?? undefined,
        ...(batch.reviewing && !batch.codeChanging ? { requiresArmed: true } : {}),
      });
    this.emitBatchGate(batch, false);
    this.publish();
  }

  private hasOpenOwnedBatches(ownerRunId: string): boolean {
    return [...this.batches.values()].some(
      (batch) =>
        batch.ownerRunId === ownerRunId &&
        ["collecting", "ready", "in-flight"].includes(batch.phase),
    );
  }

  private orphanBatch(batch: DispatchBatch, reason: string): void {
    if (batch.phase === "delivered" || batch.phase === "orphaned") return;
    batch.phase = "orphaned";
    batch.orphanedAt = iso();
    batch.updatedAt = batch.orphanedAt;
    this.emitBatchGate(batch, false);
    const owner = batch.ownerRunId ? this.store.get(batch.ownerRunId) : undefined;
    if (owner) {
      this.appendActivity(owner, "error", `nested batch ${batch.id} orphaned: ${reason}`);
      this.foldOrphanEvidence(batch);
    }
    this.publish();
  }

  private foldOrphanEvidence(batch: DispatchBatch): void {
    const owner = batch.ownerRunId ? this.store.get(batch.ownerRunId) : undefined;
    if (!owner) return;
    const marker = "\n\n## Orphaned nested result · batch ";
    const base = owner.report.split(marker)[0]?.trimEnd() ?? "";
    const evidence = [...this.batches.values()]
      .filter((candidate) => candidate.ownerRunId === owner.id && candidate.phase === "orphaned")
      .flatMap((candidate) =>
        candidate.results.map((result) => {
          const parts = [
            `${marker}${candidate.id}`,
            `### ${result.runId} · ${result.status}`,
            `Termination: ${result.terminationReason?.code ?? "legacy_unknown"}`,
            ...(result.error ? [`Error: ${result.error}`] : []),
            ...(result.cleanupFailure ? [`Cleanup failure: ${result.cleanupFailure.message}`] : []),
            result.report ? `Partial report:\n${result.report}` : "Partial report: (none)",
          ];
          return parts.join("\n");
        }),
      )
      .join("\n");
    owner.report = `${base}${evidence}`;
    batch.foldedResultKeys = batch.results.map((result) => `${result.runId}:${result.generation}`);
  }

  claimOwnedBatches(ownerRunId: string, ids: readonly string[]): void {
    const selected = new Set(ids);
    for (const batch of this.batches.values()) {
      if (
        batch.ownerRunId !== ownerRunId ||
        !batch.members.every((member) => selected.has(member.runId)) ||
        !["collecting", "ready"].includes(batch.phase)
      )
        continue;
      batch.claimedBy = ownerRunId;
      batch.claimedAt ??= iso();
      batch.updatedAt = iso();
      if (batch.phase === "ready") this.markBatchDelivered(batch);
      this.publish();
    }
  }

  acknowledgeOwnedBatches(ownerRunId: string, ids: readonly string[]): void {
    const selected = new Set(ids);
    for (const batch of this.batches.values()) {
      if (
        batch.ownerRunId !== ownerRunId ||
        !batch.members.every((member) => selected.has(member.runId)) ||
        !["collecting", "ready", "in-flight"].includes(batch.phase)
      )
        continue;
      if (batch.phase === "collecting") {
        delete batch.claimedBy;
        delete batch.claimedAt;
        batch.updatedAt = iso();
        this.publish();
        continue;
      }
      batch.claimedBy = ownerRunId;
      batch.claimedAt = iso();
      this.markBatchDelivered(batch);
      this.publish();
    }
  }

  async dispatch(
    tasks: readonly DispatchInput[],
    ctx: ExtensionContext,
    options: DispatchOptions = {},
  ): Promise<RunRecord[]> {
    let release!: () => void;
    const previous = this.dispatchTail;
    this.dispatchTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await this.dispatchNow(tasks, ctx, options);
    } finally {
      release();
    }
  }

  private async dispatchNow(
    tasks: readonly DispatchInput[],
    ctx: ExtensionContext,
    options: DispatchOptions,
  ): Promise<RunRecord[]> {
    this.assertOpen();
    await this.attachUi(ctx);
    this.assertOpen();
    const config = await this.loadConfig();
    this.assertOpen();
    const enabledProfiles = this.profiles.filter(
      (profile) => profile.metadata?.disabled !== true && profile.metadata?.enabled !== false,
    );
    const profiles = new Map(enabledProfiles.map((profile) => [profile.name, profile]));
    const kinds = new Map(
      enabledProfiles.map((profile) => [
        profile.name,
        WRITE_CLASSES.has(profileClass(profile)) ? ("write" as const) : ("read" as const),
      ]),
    );
    const effectiveTasks = tasks.map((task) => {
      const profile = profiles.get(task.agent);
      return {
        ...task,
        workspace:
          task.workspace ??
          (profile?.class === "write" && profile.workspace === "isolated"
            ? ("worktree" as const)
            : ("shared" as const)),
      };
    });
    const parent = options.parentId ? this.store.get(options.parentId) : undefined;
    if (options.parentId && !parent) throw new Error(`Unknown parent run: ${options.parentId}.`);
    if (parent) {
      const allowed = new Set(parent.profile.allowedNestedProfiles ?? []);
      for (const task of effectiveTasks)
        if (!allowed.has(task.agent))
          throw new Error(`Profile ${task.agent} is not allowed beneath ${parent.profile.name}.`);
      const depthLimit = Math.min(config.runtime.maxDepth, parent.profile.maxDepth);
      if (this.depth(parent) >= depthLimit)
        throw new Error(
          `Nested Hackler depth is limited to ${depthLimit} for ${parent.profile.name}.`,
        );
    }
    validateDispatchBatch(effectiveTasks, {
      kinds,
      existing: this.claims.all(),
      maxSharedWriters: config.runtime.maxSharedWriters,
    });
    if (this.store.active().length + effectiveTasks.length > config.runtime.maxActive)
      throw new Error(`Dispatch would exceed the ${config.runtime.maxActive}-session limit.`);

    const prepared: PreparedRun[] = [];
    for (const task of effectiveTasks) {
      const profile = profiles.get(task.agent);
      if (!profile) throw new Error(`Unknown or disabled profile: ${task.agent}.`);
      if (this.planMode && WRITE_CLASSES.has(profileClass(profile)))
        throw new Error(`Write profile ${profile.name} cannot start while Plan Mode is active.`);
      const authority = profileAuthorityDiagnostics(profile);
      if (authority.length) throw new Error(authority.join("\n"));
      const capabilities = resolveAgentCapabilities(profile, config);
      capabilities.diagnostics.push(...capabilityCeilingDiagnostics(profile, capabilities));
      if (capabilities.diagnostics.length)
        throw new Error(capabilities.diagnostics.map((entry) => entry.message).join("\n"));
      if (
        profile.runner === "rpc" &&
        (profile.class === "write" || profile.class === "orchestrator")
      )
        throw new Error(
          `RPC isolation is limited to non-writing profiles because supervisor approvals and nested tools require native AgentSession binding.`,
        );
      if (
        profile.runner === "rpc" &&
        capabilities.capabilities.some((capability) => capability.approval !== "allow")
      )
        throw new Error(`RPC profiles may select only capabilities with approval 'allow'.`);
      if (
        profile.runner === "rpc" &&
        capabilities.tools.some((pattern) => pattern.includes("*") || pattern.includes("?"))
      )
        throw new Error(`RPC profiles require exact capability tool names, not wildcard patterns.`);
      let externalRunner = profile.runner === "external" ? config.runners[profile.name] : undefined;
      if (profile.runner === "external" && !externalRunner)
        throw new Error(`External profile ${profile.name} requires runners.${profile.name}.`);
      if (externalRunner) {
        if (capabilities.approval !== "allow")
          throw new Error(`External runner ${profile.name} requires pre-approved capabilities.`);
        const prefixes = capabilities.executableArgvPrefixes;
        if (!prefixes.length)
          throw new Error(
            `External runner ${profile.name} requires a selected capability with an executable argv-prefix rule.`,
          );
        if (
          !matchesAnyExecutableArgvPrefix(
            [externalRunner.command, ...externalRunner.args],
            prefixes,
          )
        )
          throw new Error(
            `External runner ${profile.name} does not match any selected executable argv-prefix rule.`,
          );
        externalRunner = {
          ...externalRunner,
          envAllowlist: [
            ...new Set([...externalRunner.envAllowlist, ...capabilities.envAllowlist]),
          ],
        };
      }
      const resolved = resolveAgentModelPolicy(
        profile,
        config,
        ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
        ctx.thinkingLevel,
        options.modelOverride,
      );
      const model =
        profile.runner === "external" ? undefined : await this.resolveModel(resolved.model, ctx);
      this.assertOpen();
      prepared.push({
        task,
        profile,
        config,
        capabilities,
        model,
        modelName: resolved.model,
        thinking: resolved.thinking,
        externalRunner,
        cwd: options.cwd ?? ctx.cwd,
      });
    }

    const dispatchKey = options.toolCallId ?? `dispatch-${this.batchSequence + 1}`;
    const allocatedIds = prepared.map(
      (item, index) =>
        `${item.profile.name}-${stableId(`${parentSessionId(ctx)}\u0000${options.parentId ?? "pi"}\u0000${dispatchKey}\u0000${index}`)}`,
    );
    const batch = this.registerBatch(
      allocatedIds.map((runId) => ({ runId, generation: 1 })),
      prepared,
      ctx,
      options,
    );
    const runs: RunRecord[] = [];
    try {
      await this.flushPersistence();
      for (const [index, item] of prepared.entries()) {
        this.assertOpen();
        const run = await this.startPrepared(
          item,
          ctx,
          options.parentId,
          options.missionId,
          allocatedIds[index],
        );
        runs.push(run);
        await this.flushPersistence();
      }
      if (batch.phase === "collecting") this.emitBatchGate(batch, true, "running");
      return runs;
    } catch (cause) {
      await Promise.all(runs.map((run) => this.stop(run.id).catch(() => undefined)));
      this.settleMissingBatchMembers(batch, cause instanceof Error ? cause.message : String(cause));
      throw cause;
    }
  }

  private effectiveLimits(prepared: PreparedRun): EffectiveRunLimits {
    const profileWall = prepared.profile.timeout;
    const runnerWall = prepared.externalRunner
      ? prepared.externalRunner.timeoutMs / 1_000
      : undefined;
    const maxWallSeconds = Math.min(
      prepared.config.runtime.maxWallSeconds,
      profileWall ?? Number.POSITIVE_INFINITY,
      runnerWall ?? Number.POSITIVE_INFINITY,
    );
    return {
      maxWallSeconds,
      maxTurns:
        prepared.profile.runner === "external"
          ? "notApplicable"
          : Math.min(
              prepared.config.runtime.maxTurns,
              prepared.profile.turnBudget ?? Number.POSITIVE_INFINITY,
            ),
      wrapUpRatio: prepared.config.runtime.wrapUpRatio,
      tokenBudget: prepared.profile.tokenBudget,
      costBudget: prepared.profile.costBudget,
    };
  }

  private tightenedRevivalLimits(run: RunRecord, runtime: RuntimeLimits): EffectiveRunLimits {
    return {
      ...cloneLimits(run.originalEffectiveLimits),
      maxWallSeconds: Math.min(run.originalEffectiveLimits.maxWallSeconds, runtime.maxWallSeconds),
      maxTurns:
        run.originalEffectiveLimits.maxTurns === "notApplicable"
          ? "notApplicable"
          : Math.min(run.originalEffectiveLimits.maxTurns, runtime.maxTurns),
      wrapUpRatio: Math.min(run.originalEffectiveLimits.wrapUpRatio, runtime.wrapUpRatio),
    };
  }

  private lease(run: RunRecord, generation = run.activeLeaseGeneration): RunLease | undefined {
    if (generation === undefined) return undefined;
    return run.leaseHistory.find((candidate) => candidate.generation === generation);
  }

  private transition(
    run: RunRecord,
    next: RunRecord["status"],
    cause: string,
    at = Date.now(),
    generation = run.activeLeaseGeneration ?? run.leaseHistory.at(-1)?.generation ?? 0,
  ): void {
    if (run.status === next) return;
    const previous = run.status;
    run.status = next;
    run.statusChangedAt = iso(at);
    run.statusTransitions.push({ from: previous, to: next, at: iso(at), generation, cause });
  }

  private setOperation(
    run: RunRecord,
    kind: RunOperation["kind"],
    name: string,
    at = Date.now(),
  ): void {
    run.currentOperation = {
      kind,
      name,
      startedAt: iso(at),
      generation: run.activeLeaseGeneration ?? 0,
    };
  }

  private openLease(run: RunRecord, limits: EffectiveRunLimits, at = Date.now()): LeaseRuntime {
    const generation = (run.leaseHistory.at(-1)?.generation ?? 0) + 1;
    const wallMs = Math.max(1, Math.round(limits.maxWallSeconds * 1_000));
    const wrapMs = Math.min(wallMs - 1, Math.ceil(wallMs * limits.wrapUpRatio));
    const lease: RunLease = {
      id: `${run.id}:${generation}`,
      generation,
      startedAt: iso(at),
      wrapAt: iso(at + wrapMs),
      deadlineAt: iso(at + wallMs),
      effectiveLimits: cloneLimits(limits),
    };
    let resolveDone!: () => void;
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    const runtime: LeaseRuntime = {
      generation,
      controller: new AbortController(),
      phase: "active",
      idle: false,
      resolveDone,
      done,
      wrapDelivery: "none",
    };
    run.leaseHistory.push(lease);
    run.activeLeaseGeneration = generation;
    run.wrappingUp = false;
    run.blockedSince = undefined;
    run.terminationReason = undefined;
    run.lastEventAt = iso(at);
    this.leaseRuntimes.set(run.id, runtime);
    runtime.wrapTimer = setTimeout(
      () => this.onWallTimer(run.id, generation, "wrap"),
      Math.max(0, Date.parse(lease.wrapAt) - Date.now()),
    );
    runtime.deadlineTimer = setTimeout(
      () => this.onWallTimer(run.id, generation, "deadline"),
      Math.max(0, Date.parse(lease.deadlineAt) - Date.now()),
    );
    runtime.wrapTimer.unref?.();
    runtime.deadlineTimer.unref?.();
    return runtime;
  }

  private clearLeaseTimers(runtime: LeaseRuntime): void {
    if (runtime.wrapTimer) clearTimeout(runtime.wrapTimer);
    if (runtime.deadlineTimer) clearTimeout(runtime.deadlineTimer);
    runtime.wrapTimer = undefined;
    runtime.deadlineTimer = undefined;
  }

  private onWallTimer(runId: string, generation: number, kind: "wrap" | "deadline"): void {
    const run = this.store.get(runId);
    const runtime = this.leaseRuntimes.get(runId);
    const lease = run ? this.lease(run, generation) : undefined;
    if (!run || !lease || runtime?.generation !== generation || runtime.phase === "closed") return;
    const now = Date.now();
    if (now >= Date.parse(lease.deadlineAt)) {
      void this.beginTermination(run, "wall_limit", {
        phase: runtime.phase === "completing" ? "finalization" : "execution",
        limit: {
          kind: "wall",
          maximum: lease.effectiveLimits.maxWallSeconds,
          observed: Math.max(0, (now - Date.parse(lease.startedAt)) / 1_000),
        },
      });
      return;
    }
    if (kind === "wrap" && now >= Date.parse(lease.wrapAt)) this.triggerWrap(run, "wall", now);
  }

  private triggerWrap(run: RunRecord, requestedCause: "wall" | "turn", at = Date.now()): void {
    const runtime = this.leaseRuntimes.get(run.id);
    const lease = this.lease(run);
    if (!runtime || !lease || runtime.phase !== "active" || lease.wrapTriggeredAt) return;
    const cause = at >= Date.parse(lease.wrapAt) ? "wall" : requestedCause;
    lease.wrapTriggeredAt = iso(at);
    lease.wrapCause = cause;
    run.wrappingUp = true;
    run.lastEventAt = iso(at);
    this.appendActivity(run, "status", `wrapping up at the ${cause} limit threshold`);
    this.parentWrapNotices.push({ runId: run.id, cause, at: iso(at) });
    this.ctx?.ui?.notify?.(
      `${run.profile.name} is wrapping up before its ${cause} limit.`,
      "warning",
    );
    const appendEntry = (
      this.pi as ExtensionAPI & {
        appendEntry?: (customType: string, data: unknown) => void;
      }
    ).appendEntry;
    appendEntry?.(WRAP_ENTRY_TYPE, {
      schemaVersion: 1,
      runId: run.id,
      cause,
      at: iso(at),
      deadlineAt: lease.deadlineAt,
    });
    const turnCap = lease.effectiveLimits.maxTurns;
    if (turnCap !== "notApplicable" && run.turns >= turnCap) {
      runtime.wrapDelivery = "suppressed_no_turns";
    } else if (run.runner === "external") {
      runtime.wrapDelivery = "external_warning";
    } else if (run.status === "blocked" || run.status === "starting") {
      runtime.wrapDelivery = "queued";
    } else {
      void this.deliverWrap(run, runtime.generation);
    }
    this.store.changed();
  }

  private async deliverWrap(run: RunRecord, generation: number): Promise<void> {
    const runtime = this.leaseRuntimes.get(run.id);
    if (
      !runtime ||
      runtime.generation !== generation ||
      runtime.phase !== "active" ||
      !run.wrappingUp ||
      run.status === "blocked"
    )
      return;
    const lease = this.lease(run, generation);
    if (!lease) return;
    const cap = lease.effectiveLimits.maxTurns;
    if (cap !== "notApplicable" && run.turns >= cap) {
      runtime.wrapDelivery = "suppressed_no_turns";
      return;
    }
    runtime.wrapDelivery = "sending";
    const guidance =
      "Private limit notice: stop new exploration now. Produce the best supported final report from current evidence, including validation, blockers, and remaining risk.";
    try {
      if (run.runner === "native") await this.native.steer(run.id, guidance);
      else if (run.runner === "rpc") await this.rpc.steer(run.id, guidance);
      else {
        runtime.wrapDelivery = "external_warning";
        return;
      }
      if (this.leaseRuntimes.get(run.id) === runtime && runtime.phase === "active")
        runtime.wrapDelivery = "sent";
    } catch (cause) {
      if (this.leaseRuntimes.get(run.id) === runtime && runtime.phase === "active") {
        runtime.wrapDelivery = "failed";
        this.appendActivity(
          run,
          "error",
          `private wrap instruction failed: ${cause instanceof Error ? cause.message : String(cause)}`,
        );
        this.store.changed();
      }
    }
  }

  private maybeDeliverQueuedWrap(run: RunRecord): void {
    const runtime = this.leaseRuntimes.get(run.id);
    if (runtime?.wrapDelivery === "queued" && run.status === "running")
      void this.deliverWrap(run, runtime.generation);
  }

  private terminationMessage(reason: TerminationReasonCode): string {
    const messages: Record<TerminationReasonCode, string> = {
      completed: "Run completed and parked.",
      wall_limit: "Wall-time limit reached.",
      turn_limit: "Turn limit reached before another model request.",
      token_limit: "Token limit reached.",
      cost_limit: "Cost limit reached.",
      explicit_stop: "Stopped by the supervisor.",
      parent_shutdown: "Parent session shut down; run parked.",
      session_change: "Parent session changed; run parked.",
      startup_error: "Run startup failed.",
      runner_error: "Child runner failed.",
      ancestor_terminated: "Ancestor run terminated.",
      legacy_unknown: "Legacy run has no trustworthy termination reason.",
    };
    return messages[reason];
  }

  private beginTermination(
    run: RunRecord,
    code: Exclude<TerminationReasonCode, "completed">,
    details: Omit<StructuredTerminationReason, "code" | "at" | "generation"> = {},
    errorDetail?: string,
  ): Promise<void> {
    const runtime = this.leaseRuntimes.get(run.id);
    const generation = run.activeLeaseGeneration ?? runtime?.generation;
    if (
      !runtime ||
      generation === undefined ||
      runtime.generation !== generation ||
      runtime.phase === "closed"
    )
      return Promise.resolve();
    if (runtime.terminalization) return runtime.terminalization;
    const at = Date.now();
    const reason: StructuredTerminationReason = {
      code,
      at: iso(at),
      generation,
      ...details,
    };
    runtime.phase = "terminalizing";
    const lease = this.lease(run, generation);
    if (lease) {
      lease.endedAt = reason.at;
      lease.endReason = code;
    }
    run.terminationReason = reason;
    run.terminationHistory.push({
      ...reason,
      limit: reason.limit ? { ...reason.limit } : undefined,
    });
    run.finishedAt = reason.at;
    run.wrappingUp = false;
    const finalStatus = terminalStatus(code);
    run.error = finalStatus === "failed" ? errorDetail || this.terminationMessage(code) : undefined;
    this.transition(run, finalStatus, code, at, generation);
    this.appendActivity(
      run,
      finalStatus === "failed" ? "error" : "park",
      errorDetail || this.terminationMessage(code),
    );
    this.clearLeaseTimers(runtime);
    this.setOperation(run, "cleanup", "transport cleanup", at);
    this.inbox.cancelByRun(run.id, this.terminationMessage(code));
    this.claims.release(run.id);
    for (const batch of this.batches.values())
      if (batch.ownerRunId === run.id) this.orphanBatch(batch, `owner terminated: ${code}`);
    runtime.controller.abort(new Error(this.terminationMessage(code)));

    const descendants = this.store
      .children(run.id)
      .filter((child) => ACTIVE_STATUSES.has(child.status))
      .map((child) =>
        this.beginTermination(
          child,
          "ancestor_terminated",
          { phase: "cleanup", ancestorRunId: run.id },
          `Ancestor ${run.id} terminated.`,
        ),
      );
    let abort: Promise<void>;
    let park: Promise<void>;
    try {
      abort = this.abortTransport(run);
    } catch (cause) {
      abort = Promise.reject(cause);
    }
    try {
      park = this.parkTransport(run);
    } catch (cause) {
      park = Promise.reject(cause);
    }
    this.store.changed();
    runtime.terminalization = (async () => {
      const results = await Promise.allSettled([abort, park, ...descendants]);
      for (const result of results)
        if (result.status === "rejected")
          this.appendActivity(
            run,
            "error",
            `cleanup failed: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`,
          );
      const parkResult = results[1];
      if (parkResult?.status === "rejected") {
        const message =
          parkResult.reason instanceof Error
            ? parkResult.reason.message
            : String(parkResult.reason);
        run.cleanupFailure = { at: iso(), message: `Transport cleanup failed: ${message}` };
      }
      await this.inspectors.close(run.id).catch(() => {});
      if (this.leaseRuntimes.get(run.id) === runtime) {
        runtime.phase = "closed";
        run.activeLeaseGeneration = undefined;
        run.currentOperation = undefined;
        runtime.resolveDone();
      }
      if (code !== "parent_shutdown" && code !== "session_change")
        this.settleBatchMember(run, generation);
      this.store.changed();
      if (run.missionId) await this.maybeFinalizeMission(run.missionId);
    })();
    return runtime.terminalization;
  }

  private completeRun(run: RunRecord, generation: number): Promise<void> {
    const runtime = this.leaseRuntimes.get(run.id);
    const lease = this.lease(run, generation);
    if (!runtime || !lease || runtime.generation !== generation) return Promise.resolve();
    if (runtime.terminalization) return runtime.terminalization;
    if (runtime.completion) return runtime.completion;
    if (Date.now() >= Date.parse(lease.deadlineAt))
      return this.beginTermination(run, "wall_limit", {
        phase: "finalization",
        limit: {
          kind: "wall",
          maximum: lease.effectiveLimits.maxWallSeconds,
          observed: Math.max(0, (Date.now() - Date.parse(lease.startedAt)) / 1_000),
        },
      });
    runtime.phase = "completing";
    this.setOperation(run, "finalization", "parking transport and finalizing output");
    runtime.completion = (async () => {
      try {
        await this.parkTransport(run);
        if (runtime.phase !== "completing" || this.leaseRuntimes.get(run.id) !== runtime) return;
        if (run.worktree && !run.candidate)
          await this.finalizeRunWorktree(run, runtime.controller.signal);
        const mission = run.missionId ? this.missions.get(run.missionId) : undefined;
        if (mission?.orchestratorId === run.id) {
          this.setOperation(run, "finalization", "waiting for mission children");
          await this.waitForMissionChildren(mission.id, run.id, runtime.controller.signal);
          if (runtime.phase !== "completing" || this.leaseRuntimes.get(run.id) !== runtime) return;
          const unsafeChild = this.store
            .all()
            .find(
              (candidate) =>
                candidate.id !== run.id &&
                candidate.missionId === mission.id &&
                candidate.cleanupFailure,
            );
          if (unsafeChild)
            throw new Error(
              `Mission child ${unsafeChild.id} did not complete transport cleanup; the mission worktree was retained.`,
            );
          if (mission.worktree && !mission.candidate) {
            this.setOperation(run, "worktree", "capturing mission candidate");
            const candidate = await captureWorktreeCandidate(mission.worktree, {
              signal: runtime.controller.signal,
            });
            if (candidate.hasChanges) mission.candidate = candidate;
            else {
              await removeMissionWorktree(mission.worktree, {
                force: true,
                signal: runtime.controller.signal,
              });
              mission.worktree = undefined;
            }
          }
        }
        if (runtime.phase !== "completing" || this.leaseRuntimes.get(run.id) !== runtime) return;
        const now = Date.now();
        if (now >= Date.parse(lease.deadlineAt)) {
          await this.beginTermination(run, "wall_limit", {
            phase: "finalization",
            limit: {
              kind: "wall",
              maximum: lease.effectiveLimits.maxWallSeconds,
              observed: Math.max(0, (now - Date.parse(lease.startedAt)) / 1_000),
            },
          });
          return;
        }
        const reason: StructuredTerminationReason = {
          code: "completed",
          at: iso(now),
          generation,
        };
        lease.endedAt = reason.at;
        lease.endReason = "completed";
        run.terminationReason = reason;
        run.terminationHistory.push(reason);
        run.finishedAt = reason.at;
        run.error = undefined;
        run.wrappingUp = false;
        this.transition(run, "parked", "completed", now, generation);
        this.appendActivity(run, "park", "completed session parked; live resources released");
        this.clearLeaseTimers(runtime);
        this.claims.release(run.id);
        await this.inspectors
          .close(run.id)
          .catch((cause: unknown) =>
            this.appendActivity(
              run,
              "error",
              `inspector cleanup failed: ${cause instanceof Error ? cause.message : String(cause)}`,
            ),
          );
        runtime.phase = "closed";
        run.activeLeaseGeneration = undefined;
        run.currentOperation = undefined;
        runtime.resolveDone();
        this.settleBatchMember(run, generation);
        this.store.changed();
        if (run.missionId) await this.maybeFinalizeMission(run.missionId);
      } catch (cause) {
        if (runtime.phase !== "completing") return;
        await this.beginTermination(
          run,
          runtime.controller.signal.aborted && Date.now() >= Date.parse(lease.deadlineAt)
            ? "wall_limit"
            : "runner_error",
          { phase: "finalization" },
          cause instanceof Error ? cause.message : String(cause),
        );
      }
    })();
    return runtime.completion;
  }

  private beforeModelRequest(runId: string, generation: number): boolean {
    const run = this.store.get(runId);
    const runtime = this.leaseRuntimes.get(runId);
    const lease = run ? this.lease(run, generation) : undefined;
    if (
      !run ||
      !runtime ||
      !lease ||
      runtime.generation !== generation ||
      runtime.phase !== "active"
    )
      return false;
    const now = Date.now();
    if (now >= Date.parse(lease.deadlineAt)) {
      void this.beginTermination(run, "wall_limit", {
        phase: "execution",
        limit: {
          kind: "wall",
          maximum: lease.effectiveLimits.maxWallSeconds,
          observed: Math.max(0, (now - Date.parse(lease.startedAt)) / 1_000),
        },
      });
      return false;
    }
    const cap = lease.effectiveLimits.maxTurns;
    if (cap !== "notApplicable" && run.turns >= cap) {
      void this.beginTermination(run, "turn_limit", {
        phase: "execution",
        limit: { kind: "turn", maximum: cap, observed: run.turns + 1 },
      });
      return false;
    }
    const tokenBudget = lease.effectiveLimits.tokenBudget;
    if (tokenBudget !== undefined && run.usage.total >= tokenBudget) {
      void this.beginTermination(run, "token_limit", {
        phase: "execution",
        limit: { kind: "token", maximum: tokenBudget, observed: run.usage.total },
      });
      return false;
    }
    const costBudget = lease.effectiveLimits.costBudget;
    if (costBudget !== undefined && run.usage.cost >= costBudget) {
      void this.beginTermination(run, "cost_limit", {
        phase: "execution",
        limit: { kind: "cost", maximum: costBudget, observed: run.usage.cost },
      });
      return false;
    }
    this.setOperation(run, "model", `turn ${run.turns + 1}`, now);
    run.lastEventAt = iso(now);
    this.store.changed();
    return true;
  }

  private async startPrepared(
    prepared: PreparedRun,
    ctx: ExtensionContext,
    parentId?: string,
    missionId?: string,
    allocatedId?: string,
  ): Promise<RunRecord> {
    this.assertOpen();
    const id =
      allocatedId ??
      `${prepared.profile.name}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    const sessionDir = join(this.sessionRoot, parentSessionId(ctx), id);
    const startedAt = Date.now();
    const limits = this.effectiveLimits(prepared);
    const run: RunRecord = {
      id,
      parentId,
      missionId,
      profile: profileClone(prepared.profile),
      profileSnapshot: profileClone(prepared.profile),
      task: prepared.task.task,
      taskHistory: [prepared.task.task],
      ownership: {
        key: prepared.task.key,
        owns: [...prepared.task.owns],
        deliverable: prepared.task.deliverable,
        acceptance: prepared.task.acceptance,
        stopConditions: [...prepared.task.stopConditions],
        workspace: prepared.task.workspace ?? "shared",
      },
      status: "starting",
      runner: prepared.profile.runner,
      startedAt: iso(startedAt),
      originalEffectiveLimits: cloneLimits(limits),
      leaseHistory: [],
      statusChangedAt: iso(startedAt),
      statusTransitions: [
        { to: "starting", at: iso(startedAt), generation: 1, cause: "allocation" },
      ],
      lastEventAt: iso(startedAt),
      terminationHistory: [],
      wrappingUp: false,
      sessionDir,
      report: "",
      usage: emptyUsage(),
      turns: 0,
      activity: [],
      effectiveModel: prepared.model
        ? `${prepared.model.provider}/${prepared.model.id}`
        : prepared.profile.runner === "external"
          ? `external/${prepared.profile.name}`
          : prepared.modelName,
      effectiveThinking: prepared.thinking,
      capabilityNames: [...prepared.profile.capabilities],
      capabilityPolicy: capabilityPolicySnapshot(prepared.capabilities),
      completionReported: false,
    };
    this.appendActivity(
      run,
      "spawn",
      `starting ${prepared.profile.name} through ${prepared.profile.runner} runner`,
    );
    let registered = false;
    let runtime: LeaseRuntime | undefined;
    try {
      this.store.add(run);
      registered = true;
      runtime = this.openLease(run, limits, startedAt);
      this.claims.reserve(
        id,
        prepared.task,
        WRITE_CLASSES.has(profileClass(prepared.profile)) ? "write" : "read",
      );
      // The run, lease, and claim must be durable before worktree creation or transport startup.
      await this.flushPersistence();
      const mission = missionId ? this.missions.get(missionId) : undefined;
      if (
        ["write", "orchestrator"].includes(prepared.profile.class) &&
        prepared.task.workspace === "worktree"
      ) {
        this.setOperation(run, "worktree", "creating isolated worktree");
        this.store.changed();
        const retainWorktree = (worktree: MissionWorktree) => {
          if (mission) mission.worktree = worktree;
          else run.worktree = worktree;
          this.store.changed();
        };
        const worktree = await createMissionWorktree(prepared.cwd, missionId ?? id, {
          signal: runtime.controller.signal,
          onPrepared: retainWorktree,
        });
        retainWorktree(worktree);
      }
      this.assertOpen();
      const runCwd = run.worktree?.cwd ?? mission?.worktree?.cwd ?? prepared.cwd;
      this.setOperation(run, "transport", `starting ${prepared.profile.runner} transport`);
      this.store.changed();
      const task = [
        filteredParentContext(
          ctx,
          prepared.task.context ??
            (prepared.profile.defaultContext as DispatchContextMode | undefined) ??
            "fresh",
        ),
        `Task key: ${prepared.task.key}`,
        `Owned scope: ${prepared.task.owns.join(", ")}`,
        `Required deliverable: ${prepared.task.deliverable}`,
        `Acceptance criteria: ${prepared.task.acceptance}`,
        "Stop conditions:",
        ...prepared.task.stopConditions.map((condition) => `- ${condition}`),
        "",
        prepared.task.task,
      ].join("\n");
      const extensionPaths = prepared.capabilities.capabilities.flatMap((capability) => [
        ...(capability.extensionPath ? [capability.extensionPath] : []),
        ...(capability.extensionPackage ? [capability.extensionPackage] : []),
      ]);
      const skillPaths = [...prepared.profile.skills, ...prepared.capabilities.skills];
      if (prepared.profile.name === "researcher") {
        extensionPaths.push(fileURLToPath(new URL("../web-search/index.ts", import.meta.url)));
        skillPaths.push(
          fileURLToPath(new URL("../web-search/skills/web-search/SKILL.md", import.meta.url)),
        );
      }
      const systemPrompt = this.childSystemPrompt(prepared.profile, prepared.capabilities);
      if (prepared.profile.runner === "native") {
        await this.native.start(
          {
            id,
            cwd: runCwd,
            agentDir: PI_AGENT_DIR,
            sessionDir,
            parentSessionFile: ctx.sessionManager.getSessionFile(),
            task,
            systemPrompt,
            model: prepared.model,
            modelRuntime: (ctx.modelRegistry as unknown as { runtime?: ModelRuntime }).runtime,
            thinkingLevel: prepared.thinking as ThinkingLevel | undefined,
            tools: prepared.profile.tools,
            toolPatterns: prepared.capabilities.tools,
            extensionPaths: [...new Set(extensionPaths)],
            skillPaths: [...new Set(skillPaths)],
            customTools: this.childTools(run, ctx, prepared.config),
            extensionFactories: [this.capabilityGuard(run, prepared.capabilities)],
            timeoutMs: limits.maxWallSeconds * 1_000,
            signal: runtime.controller.signal,
            beforeModelRequest: () => this.beforeModelRequest(run.id, runtime!.generation),
          },
          (event) => this.onRunnerEvent(run.id, runtime!.generation, event),
        );
      } else if (prepared.profile.runner === "rpc") {
        await this.rpc.start(
          {
            id,
            cwd: runCwd,
            sessionDir,
            task,
            systemPrompt,
            model: prepared.modelName,
            thinking: prepared.thinking,
            tools: [...new Set([...prepared.profile.tools, ...prepared.capabilities.tools])],
            extensionPaths: [...new Set(extensionPaths)],
            skillPaths: [...new Set(skillPaths)],
            timeoutMs: limits.maxWallSeconds * 1_000,
            signal: runtime.controller.signal,
            beforeModelRequest: () => this.beforeModelRequest(run.id, runtime!.generation),
            initialCompletedTurns: run.turns,
            maxTurns: limits.maxTurns === "notApplicable" ? undefined : limits.maxTurns,
            deadlineAtMs: Date.parse(this.lease(run, runtime!.generation)!.deadlineAt),
          },
          (event) => this.onRunnerEvent(run.id, runtime!.generation, event),
        );
      } else {
        if (!prepared.externalRunner)
          throw new Error(`External runner ${prepared.profile.name} is missing.`);
        await this.external.start(
          {
            id,
            cwd: runCwd,
            sessionDir,
            task: `${systemPrompt}\n\n${task}`,
            runner: prepared.externalRunner,
            signal: runtime.controller.signal,
          },
          (event) => this.onRunnerEvent(run.id, runtime!.generation, event),
        );
      }
      return run;
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      if (registered && runtime)
        await this.beginTermination(run, "startup_error", { phase: "startup" }, message);
      else this.claims.release(run.id);
      throw cause;
    }
  }

  private childSystemPrompt(
    profile: AgentDefinition,
    capabilities: EffectiveCapabilityPolicy,
  ): string {
    const capabilitySummary = capabilities.capabilities.length
      ? capabilities.capabilities
          .map(
            (capability) =>
              `${capability.name}: ${capability.approval}, ${capability.state}, tools ${capability.toolPatterns?.join(", ") || "none"}`,
          )
          .join("\n")
      : "No optional workplace capabilities are enabled.";
    return [
      `You are the ${profile.name} Hackler running through the ${profile.runner} runner.`,
      profile.prompt,
      profileClass(profile) === "orchestrator" ? ORCHESTRATION_GUIDELINES : "",
      "Work only inside the explicitly assigned ownership. Do not duplicate a peer's scope.",
      profile.runner === "native"
        ? ["write", "orchestrator"].includes(profileClass(profile))
          ? "Do not ask the user directly. Use contact_supervisor for a required decision, approval, blocker, meaningful progress update, or integration handoff."
          : "Do not ask the user directly. Use contact_supervisor only for a required decision, approval, or blocker. Return progress, integration notes, and final findings in the report; do not send integration-ready for read-only work."
        : "Do not request interactive UI. Return decisions, blockers, and integration notes in the final report.",
      "Do not invent tools or capabilities. The effective capability policy is static and cannot be expanded by the child.",
      `Effective optional capabilities:\n${capabilitySummary}`,
      "Finish with a self-contained report containing evidence, changed files, validation, blockers, and remaining risk.",
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  private reconcileBlocking(run: RunRecord): void {
    const runtime = this.leaseRuntimes.get(run.id);
    if (runtime?.phase !== "active" || !ACTIVE_STATUSES.has(run.status)) return;
    const pending = this.inbox.pendingForRun(run.id).filter((request) => request.blocking);
    if (pending.length) {
      const oldest = pending[0]!;
      run.blockedSince = oldest.createdAt;
      this.transition(run, "blocked", "supervisor_request", Date.parse(oldest.createdAt));
      run.currentOperation = {
        kind: "supervisor",
        name: oldest.kind,
        startedAt: oldest.createdAt,
        generation: runtime.generation,
      };
    } else {
      run.blockedSince = undefined;
      if (run.status === "blocked") {
        const lease = this.lease(run, runtime.generation);
        this.transition(run, lease?.acceptedAt ? "running" : "starting", "requests_resolved");
        run.currentOperation = undefined;
      }
      this.maybeDeliverQueuedWrap(run);
    }
    if (run.missionId) {
      const mission = this.missions.get(run.missionId);
      if (mission) {
        const missionBlocked = this.inbox
          .open()
          .some((request) => request.missionId === run.missionId && request.blocking);
        if (missionBlocked) mission.status = "blocked";
        else if (mission.status === "blocked")
          mission.status = this.store
            .all()
            .some(
              (candidate) =>
                candidate.missionId === run.missionId && ACTIVE_STATUSES.has(candidate.status),
            )
            ? "running"
            : "parked";
      }
    }
    this.store.changed();
  }

  private requestFromRun(
    run: RunRecord,
    input: Omit<SupervisorRequestInput, "fromRunId" | "missionId">,
  ): ReturnType<SupervisorInbox["request"]> {
    const runtime = this.leaseRuntimes.get(run.id);
    if (runtime?.phase !== "active" || !ACTIVE_STATUSES.has(run.status))
      throw new Error(`Run ${run.id} cannot create a supervisor request while ${run.status}.`);
    const outcome = this.inbox.request({
      ...input,
      fromRunId: run.id,
      missionId: run.missionId,
    });
    if (outcome.request.blocking) {
      this.reconcileBlocking(run);
      void outcome.resolution.finally(() => this.reconcileBlocking(run));
    }
    return outcome;
  }

  private capabilityGuard(run: RunRecord, policy: EffectiveCapabilityPolicy): InlineExtension {
    return {
      name: `subagent-policy-${run.id}`,
      hidden: true,
      factory: (api) => {
        api.on("tool_call", async (event) => {
          if (
            [
              "contact_supervisor",
              "subagent_status",
              "subagent_dispatch",
              "subagent_collect",
            ].includes(event.toolName)
          )
            return undefined;
          const matching = policy.capabilities.filter((capability) =>
            matchesAnyToolPattern(event.toolName, capability.toolPatterns ?? []),
          );
          if (matching.some((capability) => capability.approval === "deny"))
            return { block: true, reason: `Capability policy denies ${event.toolName}.` };
          const risk = riskReason(event.toolName, event.input);
          const needsApproval =
            risk || matching.some((capability) => capability.approval === "ask");
          if (!needsApproval) return undefined;
          this.appendActivity(run, "approval", `waiting for approval: ${risk ?? event.toolName}`);
          this.store.changed();
          const { resolution } = this.requestFromRun(run, {
            kind: "approval",
            title: `Approve ${event.toolName}?`,
            detail: `${
              risk
                ? `The child requested a ${risk}.`
                : `Capability policy requires approval for ${event.toolName}.`
            }\n\nTool input:\n${summarizeToolInput(event.input)}`,
            choices: [
              { value: "allow", label: "Allow once" },
              { value: "deny", label: "Deny" },
            ],
          });
          const answer = await resolution;
          this.appendActivity(
            run,
            "approval",
            `${event.toolName} ${answer.answer === "allow" ? "approved" : "denied"}`,
          );
          this.store.changed();
          return answer.status === "answered" && answer.answer === "allow"
            ? undefined
            : { block: true, reason: `Supervisor denied ${event.toolName}.` };
        });
      },
    };
  }

  private childTools(
    run: RunRecord,
    ctx: ExtensionContext,
    config: SubagentConfig,
  ): ToolDefinition[] {
    const tools: ToolDefinition[] = [
      defineTool({
        name: "contact_supervisor",
        label: "Contact supervisor",
        description:
          "Send a typed decision, approval, blocker, progress, or integration request to the owning Pi session. Blocking requests wait for the response.",
        parameters: Type.Object({
          kind: Type.Union([
            Type.Literal("decision"),
            Type.Literal("approval"),
            Type.Literal("blocker"),
            Type.Literal("progress"),
            Type.Literal("integration-ready"),
          ]),
          title: Type.String(),
          detail: Type.String(),
          choices: Type.Optional(
            Type.Array(Type.Object({ value: Type.String(), label: Type.String() })),
          ),
        }),
        execute: async (_toolCallId, params, signal) => {
          const toolSignal = signal ?? new AbortController().signal;
          if (toolSignal.aborted)
            throw toolSignal.reason instanceof Error
              ? toolSignal.reason
              : new Error("The supervisor request was aborted.");
          const kind =
            params.kind === "integration-ready" &&
            !["write", "orchestrator"].includes(profileClass(run.profile))
              ? "progress"
              : params.kind;
          const { request, resolution } = this.requestFromRun(run, {
            kind,
            title: params.title,
            detail: params.detail,
            choices: params.choices,
          });
          if (!request.blocking) return textResult("Progress update recorded.");
          const onAbort = () => {
            if (this.inbox.all().find((entry) => entry.id === request.id)?.status === "pending")
              this.inbox.cancel(request.id, "The originating child operation was aborted.");
          };
          toolSignal.addEventListener("abort", onAbort, { once: true });
          let answer: Awaited<typeof resolution>;
          try {
            answer = await resolution;
          } finally {
            toolSignal.removeEventListener("abort", onAbort);
          }
          this.store.changed();
          return textResult(
            answer.status === "answered"
              ? `Supervisor response: ${answer.answer ?? "acknowledged"}`
              : `Supervisor request ${answer.status}: ${answer.answer ?? "no reason supplied"}`,
            answer.status !== "answered",
          );
        },
      }),
    ];
    if (profileClass(run.profile) !== "orchestrator") return tools;
    if (this.depth(run) >= Math.min(config.runtime.maxDepth, run.profile.maxDepth)) return tools;
    tools.push(
      defineTool({
        name: "subagent_status",
        label: "Hackler status",
        description:
          "Inspect current general and shared-writer capacity plus owned child states before selecting the next adaptive wave.",
        parameters: Type.Object({}),
        execute: async () => {
          const hub = this.hubSnapshot();
          const children = this.store.children(run.id);
          const pending = this.inbox
            .open()
            .filter(
              (request) =>
                request.fromRunId === run.id ||
                children.some((child) => child.id === request.fromRunId),
            );
          return textResult(
            [
              `Capacity: slots ${hub.capacity.used}/${hub.capacity.limit} used · ${hub.capacity.free} free · shared writers ${hub.capacity.sharedWritersUsed}/${hub.capacity.sharedWritersLimit}`,
              `Owned children: ${children.length}`,
              ...(children.length
                ? children.map(
                    (child) =>
                      `- ${child.id} · ${child.status} · ${child.ownership.key} · ${child.ownership.owns.join(", ")}`,
                  )
                : ["(none)"]),
              `Pending owned requests: ${pending.length}`,
            ].join("\n"),
          );
        },
      }),
      defineTool({
        name: "subagent_dispatch",
        label: "Dispatch Hackler",
        description:
          "Dispatch the smallest justified batch from the independent ready frontier, up to current free capacity; never invent work to fill slots.",
        parameters: Type.Object({
          tasks: Type.Array(
            Type.Object({
              key: Type.String(),
              agent: Type.String(),
              task: Type.String(),
              owns: Type.Array(Type.String()),
              deliverable: Type.String({ minLength: 1 }),
              acceptance: Type.String({ minLength: 1 }),
              stopConditions: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
              context: Type.Optional(
                Type.Union([
                  Type.Literal("fresh"),
                  Type.Literal("decisions"),
                  Type.Literal("plan"),
                ]),
              ),
              workspace: Type.Optional(
                Type.Union([Type.Literal("shared"), Type.Literal("worktree")]),
              ),
            }),
            { minItems: 1 },
          ),
        }),
        prepareArguments: (args: unknown) => {
          if (!args || typeof args !== "object") return args as { tasks: DispatchTask[] };
          const input = args as { tasks?: unknown[] };
          if (!Array.isArray(input.tasks)) return args as { tasks: DispatchTask[] };
          return {
            ...input,
            tasks: input.tasks.map((value) => {
              if (!value || typeof value !== "object") return value;
              const task = value as Record<string, unknown>;
              return {
                ...task,
                ...(task.acceptance === undefined && typeof task.deliverable === "string"
                  ? { acceptance: task.deliverable }
                  : {}),
                ...(task.stopConditions === undefined
                  ? {
                      stopConditions: [
                        "Stop when the deliverable is complete or report a blocker that prevents completion.",
                      ],
                    }
                  : {}),
              };
            }),
          } as { tasks: DispatchTask[] };
        },
        execute: async (toolCallId, params) => {
          try {
            const mission = run.missionId ? this.missions.get(run.missionId) : undefined;
            // A sidecar's mission worktree is already isolated from the source checkout. Its
            // children share that tree, so shared-writer limits still apply inside the mission.
            const tasks = mission?.worktree
              ? params.tasks.map((task) => ({ ...task, workspace: "shared" as const }))
              : params.tasks;
            const children = await this.dispatch(tasks, ctx, {
              parentId: run.id,
              missionId: run.missionId,
              cwd: mission?.worktree?.cwd ?? ctx.cwd,
              toolCallId,
            });
            return textResult(
              children.map((child) => `${child.ownership.key}: ${child.id}`).join("\n"),
            );
          } catch (error) {
            return textResult(error instanceof Error ? error.message : String(error), true);
          }
        },
      }),
      defineTool({
        name: "subagent_collect",
        label: "Collect Hackler",
        description:
          "Wait a bounded time for owned children; after timeout continue unowned work instead of polling immediately.",
        parameters: Type.Object({
          ids: Type.Optional(Type.Array(Type.String())),
          wait: Type.Optional(
            Type.Union([Type.Literal("none"), Type.Literal("next"), Type.Literal("all")]),
          ),
          timeoutSeconds: Type.Optional(Type.Integer({ minimum: 10, maximum: 3600 })),
        }),
        execute: async (_toolCallId, params, signal) => {
          const owned = this.store.children(run.id).map((child) => child.id);
          const ids = params.ids ?? owned;
          if (ids.some((id) => !owned.includes(id)))
            return textResult("An orchestrator may collect only its owned children.", true);
          this.claimOwnedBatches(run.id, ids);
          const collected = await this.collect(
            ids,
            params.wait ?? "all",
            signal,
            params.timeoutSeconds,
          );
          this.acknowledgeOwnedBatches(run.id, ids);
          return textResult(
            `${collected.runs
              .map(
                (child) =>
                  `## ${child.name} · ${child.status}\n${child.report || child.error || "(no report)"}`,
              )
              .join("\n\n")}\n\nWait ended: ${collected.waitReason ?? "none"}`,
          );
        },
      }),
    );
    return tools;
  }

  private depth(run: RunRecord): number {
    let depth = 1;
    let parent = run.parentId ? this.store.get(run.parentId) : undefined;
    while (parent) {
      depth += 1;
      parent = parent.parentId ? this.store.get(parent.parentId) : undefined;
    }
    return depth;
  }

  private async resolveModel(
    name: string | undefined,
    ctx: ExtensionContext,
  ): Promise<Model<any> | undefined> {
    if (!name) return ctx.model;
    await ctx.modelRegistry.refresh();
    const separator = name.indexOf("/");
    const model =
      separator > 0
        ? ctx.modelRegistry.find(name.slice(0, separator), name.slice(separator + 1))
        : ctx.modelRegistry.getAll().find((candidate) => candidate.id === name);
    if (!model) throw new Error(`Configured Hackler model ${name} is unavailable.`);
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok)
      throw new Error(`Configured Hackler model ${name} is not authenticated: ${auth.error}.`);
    return model;
  }

  private enforceUsageBudget(run: RunRecord, generation: number): void {
    const runtime = this.leaseRuntimes.get(run.id);
    const lease = this.lease(run, generation);
    if (!runtime || !lease || runtime.generation !== generation || runtime.phase !== "active")
      return;
    const now = Date.now();
    if (now >= Date.parse(lease.deadlineAt)) {
      void this.beginTermination(run, "wall_limit", {
        phase: "execution",
        limit: {
          kind: "wall",
          maximum: lease.effectiveLimits.maxWallSeconds,
          observed: Math.max(0, (now - Date.parse(lease.startedAt)) / 1_000),
        },
      });
      return;
    }
    const tokenBudget = lease.effectiveLimits.tokenBudget;
    if (tokenBudget !== undefined && run.usage.total >= tokenBudget) {
      void this.beginTermination(run, "token_limit", {
        phase: "execution",
        limit: { kind: "token", maximum: tokenBudget, observed: run.usage.total },
      });
      return;
    }
    const costBudget = lease.effectiveLimits.costBudget;
    if (costBudget !== undefined && run.usage.cost >= costBudget)
      void this.beginTermination(run, "cost_limit", {
        phase: "execution",
        limit: { kind: "cost", maximum: costBudget, observed: run.usage.cost },
      });
  }

  private onRunnerEvent(runId: string, generation: number, event: NativeRunEvent): void {
    const run = this.store.get(runId);
    const runtime = this.leaseRuntimes.get(runId);
    const lease = run ? this.lease(run, generation) : undefined;
    if (
      !run ||
      !runtime ||
      !lease ||
      runtime.generation !== generation ||
      runtime.phase === "closed"
    )
      return;
    const cleanupEvent =
      event.type === "text" ||
      event.type === "usage" ||
      event.type === "session" ||
      event.type === "turn_end";
    if (runtime.phase === "terminalizing" && !cleanupEvent) return;
    const now = Date.now();
    run.lastEventAt = iso(now);
    if (event.type === "accepted") {
      runtime.idle = false;
      lease.acceptedAt = iso(now);
      this.transition(run, "running", "accepted", now, generation);
      run.sessionFile = event.sessionFile;
      if (run.currentOperation?.kind !== "model") run.currentOperation = undefined;
      this.appendActivity(run, "prompt", `initial prompt accepted by ${run.runner} runner`);
      this.maybeDeliverQueuedWrap(run);
    } else if (event.type === "session") {
      run.sessionFile = event.sessionFile;
    } else if (event.type === "text") {
      run.report = event.text;
      for (const batch of this.batches.values())
        if (batch.ownerRunId === run.id && batch.phase === "orphaned")
          this.foldOrphanEvidence(batch);
      this.recordAssistantWritingActivity(run);
    } else if (event.type === "tool_start" && runtime.phase === "active") {
      run.currentTool = event.toolName;
      this.setOperation(run, "tool", event.toolName, now);
      this.appendActivity(run, "tool", `started ${event.toolName}`);
    } else if (event.type === "tool_end" && runtime.phase === "active") {
      run.currentTool = undefined;
      run.currentOperation = undefined;
      this.appendActivity(
        run,
        "tool",
        `${event.toolName} ${event.isError ? "failed" : "finished"}`,
      );
    } else if (event.type === "deadline_reached" && runtime.phase === "active") {
      void this.beginTermination(run, "wall_limit", {
        phase: "execution",
        limit: {
          kind: "wall",
          maximum: lease.effectiveLimits.maxWallSeconds,
          observed: Math.max(0, (now - Date.parse(lease.startedAt)) / 1_000),
        },
      });
    } else if (event.type === "turn_limit" && runtime.phase === "active") {
      const cap = lease.effectiveLimits.maxTurns;
      void this.beginTermination(run, "turn_limit", {
        phase: "execution",
        ...(cap === "notApplicable"
          ? {}
          : { limit: { kind: "turn" as const, maximum: cap, observed: run.turns + 1 } }),
      });
    } else if (event.type === "turn_end") {
      const cap = lease.effectiveLimits.maxTurns;
      if (runtime.phase === "active" && cap !== "notApplicable" && run.turns >= cap) {
        void this.beginTermination(run, "turn_limit", {
          phase: "execution",
          limit: { kind: "turn", maximum: cap, observed: run.turns + 1 },
        });
      } else if (cap === "notApplicable" || run.turns < cap) {
        run.turns += 1;
        run.currentOperation = undefined;
        if (
          runtime.phase === "active" &&
          cap !== "notApplicable" &&
          run.turns >= Math.ceil(cap * lease.effectiveLimits.wrapUpRatio)
        )
          this.triggerWrap(run, "turn", now);
      }
    } else if (event.type === "usage") {
      run.usage.input += event.input;
      run.usage.output += event.output;
      run.usage.cacheRead += event.cacheRead;
      run.usage.cacheWrite += event.cacheWrite;
      run.usage.total =
        run.usage.input + run.usage.output + run.usage.cacheRead + run.usage.cacheWrite;
      run.usage.cost += event.cost;
      this.enforceUsageBudget(run, generation);
    } else if (event.type === "model" && runtime.phase === "active") {
      run.effectiveModel = `${event.provider}/${event.id}`;
    } else if (event.type === "settled" && runtime.phase === "active") {
      runtime.idle = true;
      run.report = event.report || run.report;
      for (const batch of this.batches.values())
        if (batch.ownerRunId === run.id && batch.phase === "ready") void this.routeBatch(batch);
      if (this.hasOpenOwnedBatches(run.id)) {
        this.appendActivity(run, "status", "idle while owned Hackler batches remain open");
        run.currentOperation = {
          kind: "supervisor",
          name: "collecting owned batches",
          startedAt: iso(now),
          generation,
        };
      } else if (now >= Date.parse(lease.deadlineAt))
        void this.beginTermination(run, "wall_limit", {
          phase: "execution",
          limit: {
            kind: "wall",
            maximum: lease.effectiveLimits.maxWallSeconds,
            observed: Math.max(0, (now - Date.parse(lease.startedAt)) / 1_000),
          },
        });
      else void this.completeRun(run, generation);
    } else if (event.type === "error" && runtime.phase === "active") {
      void this.beginTermination(run, "runner_error", { phase: "execution" }, event.error.message);
    }
    if (runtime.phase === "active" && now >= Date.parse(lease.deadlineAt))
      void this.beginTermination(run, "wall_limit", {
        phase: "execution",
        limit: {
          kind: "wall",
          maximum: lease.effectiveLimits.maxWallSeconds,
          observed: Math.max(0, (now - Date.parse(lease.startedAt)) / 1_000),
        },
      });
    this.store.changed();
  }

  private async waitForMissionChildren(
    missionId: string,
    orchestratorId: string,
    signal: AbortSignal,
  ): Promise<void> {
    const hasActiveChildren = () =>
      this.store.all().some((candidate) => {
        if (candidate.id === orchestratorId || candidate.missionId !== missionId) return false;
        const runtime = this.leaseRuntimes.get(candidate.id);
        return (
          ACTIVE_STATUSES.has(candidate.status) || Boolean(runtime && runtime.phase !== "closed")
        );
      });
    if (!hasActiveChildren()) return;
    await new Promise<void>((resolve, reject) => {
      let done = false;
      let unsubscribe = (): void => {};
      const finish = (cause?: unknown) => {
        if (done) return;
        done = true;
        unsubscribe();
        signal.removeEventListener("abort", onAbort);
        if (cause !== undefined) reject(cause);
        else resolve();
      };
      const onAbort = () =>
        finish(signal.reason instanceof Error ? signal.reason : new Error("Mission lease ended."));
      const inspect = () => {
        if (signal.aborted) onAbort();
        else if (!hasActiveChildren()) finish();
      };
      unsubscribe = this.store.subscribe(inspect);
      if (done) {
        unsubscribe();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
      inspect();
      if (done) {
        unsubscribe();
        signal.removeEventListener("abort", onAbort);
      }
    });
  }

  private async finalizeRunWorktree(run: RunRecord, signal?: AbortSignal): Promise<void> {
    if (!run.worktree) return;
    const candidate = await captureWorktreeCandidate(run.worktree, { signal });
    run.candidate = candidate;
    if (!candidate.hasChanges) {
      await removeMissionWorktree(run.worktree, { force: true, signal });
      run.worktree = undefined;
      this.appendActivity(run, "status", "isolated worktree had no changes and was removed");
      return;
    }
    const { request } = this.inbox.request({
      fromRunId: run.id,
      kind: "integration-ready",
      title: `${run.profile.name} candidate ready to integrate`,
      detail: `${candidate.files.length} changed file(s): ${candidate.files.join(", ")}`,
      choices: [
        { value: "integrate", label: "Apply candidate" },
        { value: "keep", label: "Keep worktree" },
      ],
    });
    run.integrationRequestId = request.id;
    this.appendActivity(
      run,
      "status",
      `integration candidate ready: ${candidate.files.join(", ")}`,
    );
  }

  private selectRuns(ids: readonly string[] | undefined): RunRecord[] {
    if (ids === undefined) return this.store.all();
    const selected: RunRecord[] = [];
    const seen = new Set<string>();
    for (const id of ids) {
      if (seen.has(id)) continue;
      seen.add(id);
      const run = this.store.get(id);
      if (!run) throw new Error(`Unknown Hackler run: ${id}.`);
      selected.push(run);
    }
    return selected;
  }

  async collect(
    ids: readonly string[] | undefined,
    wait: CollectMode,
    signal?: AbortSignal,
    timeoutSeconds = DEFAULT_COLLECT_TIMEOUT_SECONDS,
  ): Promise<CollectResult> {
    if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 10 || timeoutSeconds > 3600)
      throw new Error("Collect timeoutSeconds must be an integer from 10 through 3600.");
    const selected = this.selectRuns(ids);
    if (wait === "none") return { runs: selected.map((run) => runSnapshot(run)) };
    if (!selected.length) return { runs: [], waitReason: signal?.aborted ? "aborted" : "settled" };
    let waitReason: CollectWaitReason | undefined;
    await new Promise<void>((resolve) => {
      let done = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let unsubscribe = (): void => {};
      const finish = (reason: CollectWaitReason) => {
        if (done) return;
        done = true;
        waitReason = reason;
        if (timer) clearTimeout(timer);
        unsubscribe();
        signal?.removeEventListener("abort", onAbort);
        resolve();
      };
      const inspect = () => {
        if (signal?.aborted) return finish("aborted");
        if (selected.some((run) => run.status === "blocked")) return finish("blocked");
        const settled = selected.filter((run) => !ACTIVE_STATUSES.has(run.status)).length;
        if (wait === "next" ? settled > 0 : settled === selected.length) finish("settled");
      };
      const onAbort = () => finish("aborted");
      unsubscribe = this.store.subscribe(inspect);
      if (done) {
        unsubscribe();
        return;
      }
      signal?.addEventListener("abort", onAbort, { once: true });
      timer = setTimeout(() => finish("timeout"), timeoutSeconds * 1_000);
      timer.unref?.();
      inspect();
    });
    return { runs: selected.map((run) => runSnapshot(run)), waitReason };
  }

  /**
   * Take child usage that has not yet been attached to a parent Pi tool result.
   * The ledger is persisted with each run so repeated collection and parent-session
   * reloads do not double-count the same child turns.
   */
  takeUnreportedUsage(ids: readonly string[] | undefined): Usage {
    const selected = this.selectRuns(ids);
    const total = emptyUsage();
    let changed = false;
    for (const run of selected) {
      const delta = usageDelta(run.usage, run.accountedUsage);
      if (!usageHasValue(delta)) continue;
      addUsage(total, delta);
      run.accountedUsage = cloneUsage(run.usage);
      changed = true;
    }
    if (changed) this.store.changed();
    return total;
  }

  async steer(id: string, message: string): Promise<RunRecord> {
    const run = this.store.get(id);
    if (!run) throw new Error(`Unknown Hackler run: ${id}.`);
    if (!message.trim()) throw new Error("Steering guidance must not be empty.");
    if (this.planMode && run.profile.class === "write")
      throw new Error(
        `Write profile ${run.profile.name} cannot be steered while Plan Mode is active.`,
      );
    if (run.status === "parked") return this.revive(run, message);
    if (run.status !== "running" && run.status !== "blocked")
      throw new Error(`Hackler run ${id} cannot be steered while ${run.status}.`);
    run.task = message;
    run.taskHistory.push(message);
    this.appendActivity(run, "steer", message.slice(0, 160));
    if (run.runner === "native") await this.native.steer(id, message);
    else if (run.runner === "rpc") await this.rpc.steer(id, message);
    else throw new Error("One-shot external runners cannot be steered; start a new run instead.");
    this.store.changed();
    return run;
  }

  private abortTransport(run: RunRecord): Promise<void> {
    if (run.runner === "native") return this.native.abort(run.id);
    if (run.runner === "rpc") return this.rpc.abort(run.id);
    return this.external.abort(run.id);
  }

  private parkTransport(run: RunRecord): Promise<void> {
    if (run.runner === "native") return this.native.park(run.id);
    if (run.runner === "rpc") return this.rpc.park(run.id);
    return this.external.park(run.id);
  }

  private async revive(run: RunRecord, message: string): Promise<RunRecord> {
    let release!: () => void;
    const previous = this.dispatchTail;
    this.dispatchTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await this.reviveNow(run, message);
    } finally {
      release();
    }
  }

  private async reviveNow(run: RunRecord, message: string): Promise<RunRecord> {
    this.assertOpen();
    if (run.status !== "parked")
      throw new Error(`Stale revival rejected because Hackler run ${run.id} is now ${run.status}.`);
    if (!this.ctx) throw new Error("The parent Pi session is unavailable.");
    if (run.runner === "external")
      throw new Error("One-shot external runners cannot be revived; dispatch a new task instead.");
    const mission = run.missionId ? this.missions.get(run.missionId) : undefined;
    if (mission) {
      const orchestratorRuntime = this.leaseRuntimes.get(mission.orchestratorId);
      if (orchestratorRuntime?.phase === "completing" || this.missionFinalizers.has(mission.id))
        throw new Error(
          `Mission ${mission.id} is finalizing; dispatch a newly scoped run after its handoff instead.`,
        );
      if (
        mission.candidate ||
        mission.status === "failed" ||
        mission.status === "integrated" ||
        (mission.status === "parked" && !mission.worktree)
      )
        throw new Error(
          `Mission ${mission.id} already produced or disposed its integration candidate; dispatch a new task instead.`,
        );
    }
    if (
      run.ownership.workspace === "worktree" &&
      (run.candidate || (!run.worktree && !mission?.worktree))
    )
      throw new Error(
        `Isolated run ${run.id} already produced or disposed its integration candidate; dispatch a new task instead.`,
      );
    if (!run.sessionFile)
      throw new Error(`Hackler run ${run.id} has no persistent session to revive.`);
    const priorRuntime = this.leaseRuntimes.get(run.id);
    if (priorRuntime && priorRuntime.phase !== "closed") await priorRuntime.done;
    if (run.status !== "parked")
      throw new Error(`Stale revival rejected because Hackler run ${run.id} is now ${run.status}.`);
    const config = await this.refreshProfiles(this.ctx);
    const enabledProfiles = this.profiles.filter(
      (profile) => profile.metadata?.disabled !== true && profile.metadata?.enabled !== false,
    );
    const currentProfile = enabledProfiles.find((profile) => profile.name === run.profile.name);
    if (!currentProfile) throw new Error(`Profile ${run.profile.name} is currently disabled.`);
    if (this.planMode && run.profileSnapshot.class === "write")
      throw new Error(`Write profile ${run.profile.name} cannot revive while Plan Mode is active.`);
    if (this.store.active().length >= config.runtime.maxActive)
      throw new Error("No active Hackler capacity is available.");
    if (
      run.terminationReason &&
      ["wall_limit", "turn_limit", "token_limit", "cost_limit"].includes(run.terminationReason.code)
    )
      throw new Error("A hard-limit failure cannot be revived; dispatch a newly scoped run.");
    if (run.terminationReason?.code === "legacy_unknown")
      throw new Error("This legacy run has no trustworthy captured limits and cannot be revived.");
    const limits = this.tightenedRevivalLimits(run, config.runtime);
    if (limits.maxTurns !== "notApplicable" && run.turns >= limits.maxTurns)
      throw new Error(
        `Run ${run.id} exhausted its cumulative turn limit (${run.turns}/${limits.maxTurns}); dispatch a newly scoped run.`,
      );
    if (limits.tokenBudget !== undefined && run.usage.total >= limits.tokenBudget)
      throw new Error(
        `Run ${run.id} exhausted its cumulative token limit (${run.usage.total}/${limits.tokenBudget}); dispatch a newly scoped run.`,
      );
    if (limits.costBudget !== undefined && run.usage.cost >= limits.costBudget)
      throw new Error(
        `Run ${run.id} exhausted its cumulative cost limit (${run.usage.cost}/${limits.costBudget}); dispatch a newly scoped run.`,
      );
    const proposedTask: DispatchTask = {
      key: run.ownership.key,
      agent: run.profile.name,
      task: message,
      owns: [...run.ownership.owns],
      deliverable: run.ownership.deliverable,
      acceptance: run.ownership.acceptance,
      stopConditions: [...run.ownership.stopConditions],
      workspace: run.ownership.workspace,
    };
    validateDispatchBatch([proposedTask], {
      kinds: new Map(
        enabledProfiles.map((profile) => [
          profile.name,
          WRITE_CLASSES.has(profileClass(profile)) ? ("write" as const) : ("read" as const),
        ]),
      ),
      existing: this.claims.all(),
      maxSharedWriters: config.runtime.maxSharedWriters,
    });
    const validatedWorktree = run.worktree
      ? await validateMissionWorktree(run.worktree, this.ctx.cwd, {
          signal: this.shutdownController.signal,
        })
      : undefined;
    const validatedMissionWorktree = mission?.worktree
      ? await validateMissionWorktree(mission.worktree, this.ctx.cwd, {
          signal: this.shutdownController.signal,
        })
      : undefined;
    const capabilities = capabilityPolicySnapshot(run.capabilityPolicy);
    if (capabilities.diagnostics.length)
      throw new Error(capabilities.diagnostics.map((entry) => entry.message).join("\n"));
    const extensionPaths = capabilities.capabilities.flatMap((capability) => [
      ...(capability.extensionPath ? [capability.extensionPath] : []),
      ...(capability.extensionPackage ? [capability.extensionPackage] : []),
    ]);
    const skillPaths = [...run.profileSnapshot.skills, ...capabilities.skills];
    if (run.profile.name === "researcher") {
      extensionPaths.push(fileURLToPath(new URL("../web-search/index.ts", import.meta.url)));
      skillPaths.push(
        fileURLToPath(new URL("../web-search/skills/web-search/SKILL.md", import.meta.url)),
      );
    }
    const model = await this.resolveModel(run.effectiveModel, this.ctx);
    this.assertOpen();
    this.claims.reserve(
      run.id,
      proposedTask,
      WRITE_CLASSES.has(profileClass(run.profile)) ? "write" : "read",
    );
    run.worktree = validatedWorktree;
    if (mission && validatedMissionWorktree) mission.worktree = validatedMissionWorktree;
    run.finishedAt = undefined;
    run.task = message;
    run.taskHistory.push(message);
    run.error = undefined;
    const runtime = this.openLease(run, limits);
    this.registerRevivalBatch(run, runtime.generation, this.ctx);
    this.transition(run, "starting", "revival", Date.now(), runtime.generation);
    this.setOperation(run, "transport", `reviving ${run.runner} transport`);
    this.store.changed();
    const revivalTask = [
      `Acceptance criteria: ${run.ownership.acceptance}`,
      "Stop conditions:",
      ...run.ownership.stopConditions.map((condition) => `- ${condition}`),
      "",
      message,
    ].join("\n");
    try {
      if (run.runner === "native")
        await this.native.start(
          {
            id: run.id,
            cwd: run.worktree?.cwd ?? validatedMissionWorktree?.cwd ?? this.ctx.cwd,
            agentDir: PI_AGENT_DIR,
            sessionDir: run.sessionDir,
            resumeSessionFile: run.sessionFile,
            task: revivalTask,
            systemPrompt: this.childSystemPrompt(run.profileSnapshot, capabilities),
            model,
            modelRuntime: (this.ctx.modelRegistry as unknown as { runtime?: ModelRuntime }).runtime,
            thinkingLevel: run.effectiveThinking as ThinkingLevel | undefined,
            tools: run.profileSnapshot.tools,
            toolPatterns: capabilities.tools,
            extensionPaths,
            skillPaths,
            customTools: this.childTools(run, this.ctx, config),
            extensionFactories: [this.capabilityGuard(run, capabilities)],
            timeoutMs: limits.maxWallSeconds * 1_000,
            signal: runtime.controller.signal,
            beforeModelRequest: () => this.beforeModelRequest(run.id, runtime.generation),
          },
          (event) => this.onRunnerEvent(run.id, runtime.generation, event),
        );
      else
        await this.rpc.start(
          {
            id: run.id,
            cwd: run.worktree?.cwd ?? validatedMissionWorktree?.cwd ?? this.ctx.cwd,
            sessionDir: run.sessionDir,
            resumeSessionFile: run.sessionFile,
            task: revivalTask,
            systemPrompt: this.childSystemPrompt(run.profileSnapshot, capabilities),
            model: run.effectiveModel,
            thinking: run.effectiveThinking,
            tools: [...new Set([...run.profileSnapshot.tools, ...capabilities.tools])],
            extensionPaths,
            skillPaths,
            timeoutMs: limits.maxWallSeconds * 1_000,
            signal: runtime.controller.signal,
            beforeModelRequest: () => this.beforeModelRequest(run.id, runtime.generation),
            initialCompletedTurns: run.turns,
            maxTurns: limits.maxTurns === "notApplicable" ? undefined : limits.maxTurns,
            deadlineAtMs: Date.parse(this.lease(run, runtime.generation)!.deadlineAt),
          },
          (event) => this.onRunnerEvent(run.id, runtime.generation, event),
        );
      return run;
    } catch (cause) {
      await this.beginTermination(
        run,
        "startup_error",
        { phase: "startup" },
        cause instanceof Error ? cause.message : String(cause),
      );
      throw cause;
    }
  }

  async stop(id: string): Promise<RunRecord> {
    const run = this.store.get(id);
    if (!run) throw new Error(`Unknown Hackler run: ${id}.`);
    if (run.status === "stopped") return run;
    if (!ACTIVE_STATUSES.has(run.status))
      throw new Error(`Hackler run ${id} cannot be stopped while ${run.status}.`);
    await this.beginTermination(run, "explicit_stop", { phase: "cleanup" });
    return run;
  }

  async openInspector(id: string): Promise<void> {
    const run = this.store.get(id);
    if (!run) throw new Error(`Unknown Hackler run: ${id}.`);
    if (!run.sessionFile) throw new Error("This Hackler run has no persisted transcript yet.");
    const config = await this.loadConfig();
    if (!config.herdr.enabled)
      throw new Error("Herdr transcript inspection is disabled in Hackler v2 configuration.");
    const activeTheme = this.ctx?.ui?.theme;
    const themeName =
      activeTheme && typeof activeTheme.name === "string" && activeTheme.name.trim()
        ? activeTheme.name
        : undefined;
    await this.inspectors.open(id, run.sessionFile, this.ctx?.cwd ?? process.cwd(), {
      direction: config.herdr.direction,
      maxOutputBytes: config.herdr.maxOutputBytes,
      themeName,
    });
    this.store.changed();
  }

  request(input: SupervisorRequestInput): ReturnType<SupervisorInbox["request"]> {
    return this.inbox.request(input);
  }

  async respondRequest(id: string, answer: string): Promise<SupervisorRequest> {
    const inFlight = this.requestResponses.get(id);
    if (inFlight) {
      if (inFlight.answer !== answer)
        throw new Error(`Supervisor request ${id} already has a response in progress.`);
      return inFlight.promise;
    }
    const operation = this.respondRequestOnce(id, answer);
    this.requestResponses.set(id, { answer, promise: operation });
    try {
      return await operation;
    } finally {
      if (this.requestResponses.get(id)?.promise === operation) this.requestResponses.delete(id);
    }
  }

  private async respondRequestOnce(id: string, answer: string): Promise<SupervisorRequest> {
    const pending = this.inbox.all().find((request) => request.id === id);
    if (!pending) throw new Error(`Unknown supervisor request: ${id}.`);
    if (
      pending.kind === "integration-ready" &&
      answer === "integrate" &&
      pending.status === "pending"
    ) {
      if (pending.missionId) await this.integrateMission(pending.missionId);
      else await this.integrateRunCandidate(pending.fromRunId);
    }
    const resolved = this.inbox.resolve(id, answer);
    const run = this.store.get(resolved.fromRunId);
    if (run) this.reconcileBlocking(run);
    return resolved;
  }

  private async integrateRunCandidate(id: string): Promise<void> {
    const run = this.store.get(id);
    if (!run?.worktree || !run.candidate)
      throw new Error(`Run ${id} has no isolated integration candidate.`);
    await applyCandidate(run.worktree.sourceRoot, run.candidate);
    await removeMissionWorktree(run.worktree, { force: true });
    run.candidate = { ...run.candidate, patch: "" };
    run.worktree = undefined;
    this.appendActivity(run, "status", "integration candidate applied to the source checkout");
    this.store.changed();
    this.pi.events.emit(events.implementationWaveAdvance, {
      producerId: COMPLETION_PRODUCER_ID,
      reason: `integrated worktree candidate from ${run.id}`,
      branchEntryId: this.ctx?.sessionManager.getLeafId?.() ?? undefined,
    });
  }

  async startMission(
    task: string,
    scope: string[],
    ctx: ExtensionContext,
    workspace: "shared" | "worktree" = "worktree",
  ): Promise<MissionRecord> {
    this.assertOpen();
    await this.attachUi(ctx);
    this.assertOpen();
    if (this.planMode)
      throw new Error("An implementation sidecar cannot start while Plan Mode is active.");
    if (
      [...this.missions.values()].some((mission) => ["running", "blocked"].includes(mission.status))
    )
      throw new Error("This Pi session already has an active sidecar orchestrator.");
    if (!task.trim()) throw new Error("An orchestrator mission requires a task.");
    if (!scope.length) throw new Error("An orchestrator mission requires an explicit owned scope.");
    const id = `mission-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    const mission: MissionRecord = {
      id,
      task,
      scope: [...scope],
      status: "running",
      orchestratorId: "pending",
      startedAt: new Date().toISOString(),
      workspace,
    };
    this.missions.set(id, mission);
    try {
      const [orchestrator] = await this.dispatch(
        [
          {
            key: "mission",
            agent: "orchestrator",
            task,
            owns: scope,
            deliverable:
              "A reviewed implementation candidate, validation evidence, and integration handoff.",
            acceptance:
              "Every owned slice is reviewed, integrated or handed off explicitly, and supported by validation evidence.",
            stopConditions: [
              "Stop when the mission deliverable is ready, or report a blocker that prevents safe completion.",
            ],
            context: "decisions",
            workspace: workspace === "worktree" ? "worktree" : "shared",
          },
        ],
        ctx,
        { missionId: id, cwd: ctx.cwd },
      );
      if (!orchestrator) throw new Error("Failed to start orchestrator.");
      mission.orchestratorId = orchestrator.id;
      await this.maybeFinalizeMission(id);
      this.publish();
      return { ...mission, scope: [...mission.scope] };
    } catch (cause) {
      const worktree = mission.worktree;
      if (worktree) {
        try {
          await removeMissionWorktree(worktree, { force: true });
          mission.worktree = undefined;
        } catch (cleanupCause) {
          const cleanupMessage =
            cleanupCause instanceof Error ? cleanupCause.message : String(cleanupCause);
          mission.status = "failed";
          mission.finishedAt = iso();
          mission.cleanupFailure = { at: mission.finishedAt, message: cleanupMessage };
          this.publish();
          throw new Error(
            `${cause instanceof Error ? cause.message : String(cause)} Worktree retained at ${worktree.root} because cleanup failed: ${cleanupMessage}`,
            { cause },
          );
        }
      }
      this.missions.delete(id);
      throw cause;
    }
  }

  private async maybeFinalizeMission(id: string): Promise<void> {
    const inFlight = this.missionFinalizers.get(id);
    if (inFlight) return inFlight;
    const operation = this.maybeFinalizeMissionOnce(id);
    this.missionFinalizers.set(id, operation);
    try {
      await operation;
    } finally {
      if (this.missionFinalizers.get(id) === operation) this.missionFinalizers.delete(id);
    }
  }

  private async maybeFinalizeMissionOnce(id: string): Promise<void> {
    const mission = this.missions.get(id);
    if (!mission || mission.orchestratorId === "pending") return;
    const missionRuns = this.store.all().filter((run) => run.missionId === id);
    const orchestrator = this.store.get(mission.orchestratorId);
    if (!orchestrator || ACTIVE_STATUSES.has(orchestrator.status)) return;
    if (missionRuns.some((run) => ACTIVE_STATUSES.has(run.status))) return;
    if (["failed", "stopped"].includes(orchestrator.status)) {
      mission.status = "failed";
      mission.finishedAt = new Date().toISOString();
      this.publish();
      return;
    }
    try {
      await this.finalizeMission(id);
    } catch (cause) {
      mission.status = "failed";
      mission.finishedAt = new Date().toISOString();
      this.inbox.request({
        missionId: id,
        fromRunId: mission.orchestratorId,
        kind: "blocker",
        title: "Mission finalization failed",
        detail: cause instanceof Error ? cause.message : String(cause),
        choices: [{ value: "keep", label: "Keep worktree for manual recovery" }],
      });
      this.publish();
    }
  }

  private async finalizeMission(id: string): Promise<void> {
    const mission = this.missions.get(id);
    if (!mission || mission.status === "integrated") return;
    mission.status = "parked";
    mission.finishedAt = new Date().toISOString();
    if (mission.worktree) {
      if (!mission.candidate)
        throw new Error(
          `Mission ${id} worktree finalization did not complete inside its orchestrator lease; the worktree was retained.`,
        );
      if (mission.candidate.hasChanges) {
        const { request } = this.inbox.request({
          missionId: id,
          fromRunId: mission.orchestratorId,
          kind: "integration-ready",
          title: "Mission candidate ready to integrate",
          detail: `${mission.candidate.files.length} changed file(s): ${mission.candidate.files.join(", ")}`,
          choices: [
            { value: "integrate", label: "Apply candidate" },
            { value: "keep", label: "Keep worktree" },
          ],
        });
        mission.integrationRequestId = request.id;
      }
    }
    this.publish();
  }

  private async integrateMission(id: string): Promise<void> {
    const mission = this.missions.get(id);
    if (!mission?.worktree || !mission.candidate)
      throw new Error(`Mission ${id} has no isolated integration candidate.`);
    await applyCandidate(mission.worktree.sourceRoot, mission.candidate);
    await removeMissionWorktree(mission.worktree, { force: true });
    mission.candidate = { ...mission.candidate, patch: "" };
    mission.worktree = undefined;
    mission.status = "integrated";
    mission.finishedAt = new Date().toISOString();
    this.pi.events.emit(events.implementationWaveAdvance, {
      producerId: COMPLETION_PRODUCER_ID,
      reason: `integrated mission worktree ${mission.id}`,
      branchEntryId: this.ctx?.sessionManager.getLeafId?.() ?? undefined,
    });
    this.publish();
  }

  private async runPlanReview(
    task: string,
    ctx: ExtensionContext,
    model?: string,
    thinking?: string,
  ): Promise<{
    reviewerId?: string;
    model?: string;
    thinking?: string;
    report?: string;
    error?: string;
  }> {
    const [run] = await this.dispatch(
      [
        {
          key: `plan-review-${Date.now().toString(36)}`,
          agent: "plan-reviewer",
          task,
          owns: ["topic:implementation-plan"],
          deliverable: "Evidence-backed plan risks, omissions, and concrete revisions.",
          acceptance: "Findings cite repository evidence and identify actionable plan corrections.",
          stopConditions: [
            "Stop when the plan review is complete, or report a blocker that prevents evidence-backed review.",
          ],
          context: "plan",
          workspace: "shared",
        },
      ],
      ctx,
      {
        modelOverride: { model, thinking: thinking as ThinkingPolicy | undefined },
        route: "silent",
        toolCallId: `plan-review:${Date.now().toString(36)}`,
      },
    );
    if (!run) throw new Error("Plan reviewer did not start.");
    const { runs: results } = await this.collect([run.id], "all");
    const [result] = results;
    return {
      reviewerId: run.id,
      model: model ?? result?.effectiveModel,
      thinking: thinking ?? result?.effectiveThinking,
      report: result?.report,
      ...(result?.status === "failed" ? { error: result.error ?? "Reviewer failed." } : {}),
    };
  }

  private statePath(parent: string): string {
    return join(this.sessionRoot, parent, "runs.json");
  }

  private async flushPersistence(): Promise<void> {
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = undefined;
    this.enqueuePersist(false);
    await this.persistenceTail;
  }

  private queuePersist(): void {
    if (this.shutdownController.signal.aborted || !this.restoredParent || this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = undefined;
      this.enqueuePersist();
    }, 100);
    this.persistTimer.unref?.();
  }

  private enqueuePersist(suppressErrors = true): void {
    if (!this.restoredParent) return;
    const path = this.statePath(this.restoredParent);
    const payload = JSON.stringify(
      {
        schemaVersion: 3,
        batchSequence: this.batchSequence,
        batches: this.batchSnapshots(),
        runs: this.store.all(),
        missions: [...this.missions.values()].map((mission) => ({
          ...mission,
          scope: [...mission.scope],
          worktree: mission.worktree ? { ...mission.worktree } : undefined,
          candidate: mission.candidate
            ? { ...mission.candidate, files: [...mission.candidate.files] }
            : undefined,
        })),
        evaluation: this.evaluationTrace(),
      },
      null,
      2,
    );
    const write = this.persistenceTail
      .catch(() => {})
      .then(async () => {
        await fs.mkdir(dirname(path), { recursive: true });
        const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
        await fs.writeFile(temporary, payload, { mode: 0o600 });
        await fs.rename(temporary, path);
      });
    this.persistenceTail = suppressErrors ? write.catch(() => {}) : write;
  }

  private async recoverPersistedCost(run: RunRecord): Promise<void> {
    if (!run.sessionFile) return;
    try {
      const source = await fs.readFile(run.sessionFile, "utf8");
      let persistedCost = 0;
      let foundCost = false;
      for (const line of source.split("\n")) {
        let entry: unknown;
        try {
          entry = JSON.parse(line);
        } catch {
          continue;
        }
        if (!entry || typeof entry !== "object") continue;
        const message = (entry as { type?: unknown; message?: unknown }).message;
        if (!message || typeof message !== "object") continue;
        const value = message as { role?: unknown; usage?: unknown };
        if (value.role !== "assistant" || !value.usage || typeof value.usage !== "object") continue;
        const cost = (value.usage as { cost?: unknown }).cost;
        const total =
          typeof cost === "number"
            ? cost
            : cost &&
                typeof cost === "object" &&
                typeof (cost as { total?: unknown }).total === "number"
              ? (cost as { total: number }).total
              : 0;
        if (Number.isFinite(total)) {
          persistedCost += total;
          foundCost = true;
        }
      }
      if (foundCost && persistedCost > 0 && Math.abs(run.usage.cost - persistedCost) > 1e-12)
        run.usage.cost = persistedCost;
    } catch {
      // A missing or partially written child transcript must not block parent restore.
    }
  }

  private restoreIntegrationRequests(): void {
    for (const run of this.store.all()) {
      if (!run.worktree || !run.candidate?.hasChanges) continue;
      const { request } = this.inbox.request({
        fromRunId: run.id,
        kind: "integration-ready",
        title: `${run.profile.name} candidate ready to integrate`,
        detail: `${run.candidate.files.length} changed file(s): ${run.candidate.files.join(", ")}`,
        choices: [
          { value: "integrate", label: "Apply candidate" },
          { value: "keep", label: "Keep worktree" },
        ],
      });
      run.integrationRequestId = request.id;
    }
    for (const mission of this.missions.values()) {
      if (!mission.worktree || !mission.candidate?.hasChanges) continue;
      const { request } = this.inbox.request({
        missionId: mission.id,
        fromRunId: mission.orchestratorId,
        kind: "integration-ready",
        title: "Mission candidate ready to integrate",
        detail: `${mission.candidate.files.length} changed file(s): ${mission.candidate.files.join(", ")}`,
        choices: [
          { value: "integrate", label: "Apply candidate" },
          { value: "keep", label: "Keep worktree" },
        ],
      });
      mission.integrationRequestId = request.id;
    }
  }

  private async restore(parent: string): Promise<void> {
    if (this.store.all().length) return;
    try {
      const parsed = JSON.parse(await fs.readFile(this.statePath(parent), "utf8")) as {
        schemaVersion?: number;
        batchSequence?: number;
        batches?: DispatchBatch[];
        runs?: RunRecord[];
        missions?: MissionRecord[];
        evaluation?: EvaluationTraceV1;
      };
      if (parsed.schemaVersion !== 2 && parsed.schemaVersion !== 3) return;
      if (parsed.schemaVersion === 3) {
        this.batchSequence = Number.isSafeInteger(parsed.batchSequence)
          ? Math.max(0, parsed.batchSequence ?? 0)
          : 0;
        for (const batch of parsed.batches ?? []) {
          if (
            !batch ||
            typeof batch.id !== "string" ||
            !Array.isArray(batch.members) ||
            !Array.isArray(batch.results) ||
            !["pi", "owner", "silent"].includes(batch.route) ||
            !["collecting", "ready", "in-flight", "delivered", "orphaned"].includes(batch.phase)
          )
            continue;
          this.batches.set(batch.id, structuredClone(batch));
          this.batchSequence = Math.max(this.batchSequence, batch.sequence || 0);
        }
      }
      if (parsed.evaluation?.schemaVersion === 1) {
        const restored = buildEvaluationTraceV1(parsed.evaluation);
        this.evaluationActivities = restored.activities;
        this.evaluationCapacity = restored.capacityTimeline;
        this.evaluationRequests = new Map(
          restored.requests.map((request) => [request.id, request]),
        );
      }
      for (const run of parsed.runs ?? []) {
        run.turns ??= 0;
        run.ownership.acceptance ??= run.ownership.deliverable;
        run.ownership.stopConditions ??= [
          "Stop when the deliverable is complete or report a blocker that prevents completion.",
        ];
        const legacyLimits: EffectiveRunLimits = {
          maxWallSeconds: Math.min(
            this.runtimeLimits.maxWallSeconds,
            run.profileSnapshot?.timeout ?? Number.POSITIVE_INFINITY,
          ),
          maxTurns:
            run.runner === "external"
              ? "notApplicable"
              : Math.min(
                  this.runtimeLimits.maxTurns,
                  run.profileSnapshot?.turnBudget ?? Number.POSITIVE_INFINITY,
                ),
          wrapUpRatio: this.runtimeLimits.wrapUpRatio,
          tokenBudget: run.profileSnapshot?.tokenBudget,
          costBudget: run.profileSnapshot?.costBudget,
        };
        const migratedLegacyLimits = !run.originalEffectiveLimits;
        run.originalEffectiveLimits ??= legacyLimits;
        run.leaseHistory ??= [];
        run.statusChangedAt ??= run.finishedAt ?? run.startedAt;
        run.statusTransitions ??= [
          {
            to: run.status,
            at: run.statusChangedAt,
            generation: 0,
            cause: "legacy_restore",
          },
        ];
        run.lastEventAt ??= run.activity.at(-1)?.at ?? run.startedAt;
        run.terminationHistory ??= [];
        run.wrappingUp ??= false;
        if (migratedLegacyLimits && !run.terminationReason && !ACTIVE_STATUSES.has(run.status)) {
          run.terminationReason = {
            code: "legacy_unknown",
            at: run.finishedAt ?? run.startedAt,
            generation: 0,
          };
          run.terminationHistory.push({ ...run.terminationReason });
        }
        run.capabilityPolicy ??= {
          requested: [...(run.capabilityNames ?? [])],
          capabilities: [],
          tools: [],
          executableArgvPrefixes: [],
          skills: [],
          envAllowlist: [],
          state: "isolated",
          approval: "deny",
          diagnostics: [
            {
              code: "invalid",
              message:
                "The persisted run predates its immutable capability snapshot and cannot be revived.",
            },
          ],
        };
        if (ACTIVE_STATUSES.has(run.status)) {
          const at = Date.now();
          const generation = run.activeLeaseGeneration ?? run.leaseHistory.at(-1)?.generation ?? 0;
          const reason: StructuredTerminationReason = migratedLegacyLimits
            ? run.terminationReason?.code === "legacy_unknown"
              ? run.terminationReason
              : { code: "legacy_unknown", at: iso(at), generation }
            : { code: "parent_shutdown", at: iso(at), generation };
          run.terminationReason = reason;
          if (
            run.terminationHistory.at(-1)?.code !== reason.code ||
            run.terminationHistory.at(-1)?.at !== reason.at
          )
            run.terminationHistory.push(reason);
          run.statusTransitions.push({
            from: run.status,
            to: "parked",
            at: reason.at,
            generation,
            cause: reason.code,
          });
          run.status = "parked";
          run.statusChangedAt = reason.at;
          run.finishedAt = reason.at;
          run.activeLeaseGeneration = undefined;
          const lease = run.leaseHistory.find((candidate) => candidate.generation === generation);
          if (lease) {
            lease.endedAt ??= reason.at;
            lease.endReason ??= reason.code;
          }
          this.appendActivity(
            run,
            "park",
            migratedLegacyLimits
              ? "legacy run restored without trustworthy captured limits; revival disabled"
              : "restored after parent shutdown; manual revival required",
          );
        }
        if (run.worktree) {
          try {
            run.worktree = await validateMissionWorktree(
              run.worktree,
              this.ctx?.cwd ?? run.worktree.sourceRoot,
            );
          } catch (cause) {
            const message = cause instanceof Error ? cause.message : String(cause);
            const at = iso();
            const generation = run.leaseHistory.at(-1)?.generation ?? 0;
            const hardReason =
              run.terminationReason &&
              ["wall_limit", "turn_limit", "token_limit", "cost_limit"].includes(
                run.terminationReason.code,
              );
            if (!hardReason) {
              const reason: StructuredTerminationReason = {
                code: "startup_error",
                at,
                generation,
                phase: "startup",
              };
              if (run.status !== "failed")
                run.statusTransitions.push({
                  from: run.status,
                  to: "failed",
                  at,
                  generation,
                  cause: "startup_error",
                });
              run.status = "failed";
              run.statusChangedAt = at;
              run.finishedAt = at;
              run.terminationReason = reason;
              run.terminationHistory.push(reason);
            }
            run.error = `Persisted worktree rejected and retained: ${message}`;
            run.cleanupFailure = {
              at,
              message: `Safe cleanup cannot be proven after validation failed: ${message}`,
            };
            run.candidate = undefined;
            this.diagnostics.push({
              path: this.statePath(parent),
              code: "read-error",
              message: `Run ${run.id}: ${message}`,
            });
          }
        }
        await this.recoverPersistedCost(run);
        this.store.add(run);
      }
      for (const mission of parsed.missions ?? []) {
        if (mission.status === "running" || mission.status === "blocked") mission.status = "parked";
        if (mission.worktree) {
          try {
            mission.worktree = await validateMissionWorktree(
              mission.worktree,
              this.ctx?.cwd ?? mission.worktree.sourceRoot,
            );
          } catch (cause) {
            const message = cause instanceof Error ? cause.message : String(cause);
            mission.status = "failed";
            mission.cleanupFailure = {
              at: iso(),
              message: `Safe cleanup cannot be proven after validation failed: ${message}`,
            };
            mission.candidate = undefined;
            this.diagnostics.push({
              path: this.statePath(parent),
              code: "read-error",
              message: `Mission ${mission.id}: ${message}`,
            });
          }
        }
        this.missions.set(mission.id, mission);
      }
      this.restoreIntegrationRequests();
      if (parsed.schemaVersion === 3) {
        for (const batch of this.batches.values()) {
          this.settleMissingBatchMembers(
            batch,
            "member run state was unavailable after manager restore",
          );
          for (const member of batch.members) {
            if (
              batch.results.some(
                (result) =>
                  result.runId === member.runId && result.generation === member.generation,
              )
            )
              continue;
            const run = this.store.get(member.runId);
            if (run && !ACTIVE_STATUSES.has(run.status))
              this.settleBatchMember(run, member.generation);
          }
          if (batch.route === "owner") {
            const owner = batch.ownerRunId ? this.store.get(batch.ownerRunId) : undefined;
            if (!owner || !ACTIVE_STATUSES.has(owner.status))
              this.orphanBatch(batch, "owning orchestrator was not active after restore");
          } else if (batch.phase === "ready" || batch.phase === "in-flight") {
            // Re-enqueueing the same canonical request reconciles with the continuation ledger.
            if (batch.phase === "in-flight") batch.phase = "ready";
            void this.routeBatch(batch);
          }
        }
      }
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT")
        this.diagnostics.push({
          path: this.statePath(parent),
          code: "read-error",
          message: cause instanceof Error ? cause.message : String(cause),
        });
    }
  }

  private async parkActiveForShutdown(): Promise<void> {
    const active = this.store.active();
    const activeIds = new Set(active.map((run) => run.id));
    await Promise.all(
      active
        .filter((run) => !run.parentId || !activeIds.has(run.parentId))
        .map((run) => this.beginTermination(run, "parent_shutdown", { phase: "cleanup" })),
    );
  }

  shutdown(): Promise<void> {
    this.unsubscribePlanMode();
    this.unsubscribePlanReview();
    this.unsubscribeContinuationReceipt();
    if (!this.shutdownPromise) {
      this.shutdownController.abort(new Error("Parent session is shutting down."));
      this.shutdownPromise = this.shutdownNow();
    }
    return this.shutdownPromise;
  }

  private async shutdownNow(): Promise<void> {
    await this.parkActiveForShutdown();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const dispatchSettled = await Promise.race([
      this.dispatchTail.then(() => true),
      new Promise<false>((resolve) => {
        timeout = setTimeout(() => resolve(false), 5_000);
      }),
    ]);
    if (timeout) clearTimeout(timeout);
    if (!dispatchSettled)
      this.diagnostics.push({
        path: "subagent-runtime",
        code: "lifecycle",
        message:
          "Dispatch startup did not settle within five seconds; shutdown continued after cancellation.",
      });
    await this.parkActiveForShutdown();
    for (const mission of this.missions.values())
      if (mission.status === "running" || mission.status === "blocked") mission.status = "parked";
    await this.inspectors.shutdown();
    const shutdowns = await Promise.allSettled([
      this.native.shutdown(),
      this.rpc.shutdown(),
      this.external.shutdown(),
    ]);
    for (const result of shutdowns)
      if (result.status === "rejected")
        this.diagnostics.push({
          path: "subagent-runtime",
          code: "lifecycle",
          message: `Child transport cleanup failed: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`,
        });
    await this.parkActiveForShutdown();
    this.inbox.dispose();
    this.publish(true);
    this.hubListeners.clear();
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = undefined;
    this.enqueuePersist();
    await this.persistenceTail;
  }
}

export { CONFIG_PATH };
