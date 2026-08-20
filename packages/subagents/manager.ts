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
  resolveAgentCapabilities,
  resolveAgentModelPolicy,
  SESSION_ROOT,
  type SubagentConfig,
  type ThinkingPolicy,
  updateProfileControl,
} from "./config.js";
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
  emptyUsage,
  type ProfileClass,
  type RunActivityKind,
  type RunRecord,
  type RunSnapshot,
  runSnapshot,
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
};

export type MissionSnapshot = Omit<MissionRecord, "candidate"> & {
  candidate?: { files: string[]; hasChanges: boolean };
};

export type HubSnapshot = {
  runs: RunSnapshot[];
  requests: SupervisorRequest[];
  missions: MissionSnapshot[];
  profiles: AgentDefinition[];
  diagnostics: AgentDiagnostic[];
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

function recordActivity(run: RunRecord, kind: RunActivityKind, text: string): void {
  run.activity.push({
    at: new Date().toISOString(),
    kind,
    text: text.replace(/\s+/gu, " ").trim(),
  });
  if (run.activity.length > 200) run.activity.splice(0, run.activity.length - 200);
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
  private readonly missionFinalizers = new Map<string, Promise<void>>();
  private readonly requestResponses = new Map<
    string,
    { answer: string; promise: Promise<SupervisorRequest> }
  >();
  private readonly hubListeners = new Set<(snapshot: HubSnapshot) => void>();
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
    this.store.subscribe(() => this.publish());
    this.inbox.subscribe(() => this.publish());
  }

  async attachUi(ctx: ExtensionContext): Promise<void> {
    this.ctx = ctx;
    const parent = parentSessionId(ctx);
    const parentChanged = this.restoredParent !== parent;
    if (parentChanged) {
      if (this.restoredParent) await this.leaveParentSession();
      this.restoredParent = parent;
    }
    const config = await this.refreshProfiles(ctx);
    if (parentChanged) await this.restore(parent);
    await this.pruneRetention(config);
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

  hubSnapshot(): HubSnapshot {
    return {
      runs: this.snapshots(),
      requests: this.inbox.all(),
      missions: this.missionSnapshots(),
      profiles: this.profiles.map(profileClone),
      diagnostics: this.diagnostics.map((diagnostic) => ({ ...diagnostic })),
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
          reason: `Subagent ${claim.runId} owns ${claim.owns.join(", ")}. Stop or collect that run before editing its scope in the parent.`,
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
          reason: `Subagent ${claim.runId} owns a path referenced by this command.`,
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
      "\n\nIf a child reports a pending supervisor request, inspect it with subagent_status and resolve it with subagent_respond before waiting again. Do not leave a blocked child inside an indefinite subagent_collect wait.";
    return `${systemPrompt}\n\n${ORCHESTRATION_GUIDELINES}${supervisorNotice}${profileNotice}${missionNotice}`;
  }

  private assertOpen(): void {
    if (this.shutdownController.signal.aborted || this.shutdownPromise)
      throw new Error("The parent session is shutting down.");
  }

  private publish(force = false): void {
    if (this.shutdownController.signal.aborted && !force) return;
    const snapshot = this.hubSnapshot();
    const summary = this.store.summary();
    this.pi.events.emit(events.subagentsStatus, {
      ...summary,
      agents: snapshot.runs
        .filter((run) => ACTIVE_STATUSES.has(run.status) || run.status === "failed")
        .slice(-4),
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
    for (const run of this.store.active()) {
      await this.abortTransport(run).catch(() => {});
      await this.parkTransport(run).catch(() => {});
      run.status = "parked";
      run.finishedAt = new Date().toISOString();
      recordActivity(run, "park", "parent session changed; run stopped and parked");
      this.claims.release(run.id);
      this.inbox.cancelByRun(run.id, "Parent session changed.");
    }
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
  }

  private async pruneRetention(config: SubagentConfig): Promise<void> {
    const removed = this.store.prune(config.retention);
    await Promise.all(
      removed.map(async (run) => {
        if (run.worktree)
          await removeMissionWorktree(run.worktree, { force: true }).catch(() => {});
        const child = relative(this.sessionRoot, run.sessionDir);
        if (!child || child.startsWith("..") || child.split(/[\\/]/u).includes("..")) return;
        await fs.rm(run.sessionDir, { recursive: true, force: true }).catch(() => {});
      }),
    );
    const removedIds = new Set(removed.map((run) => run.id));
    for (const [id, mission] of this.missions) {
      if (!removedIds.has(mission.orchestratorId)) continue;
      if (mission.worktree)
        await removeMissionWorktree(mission.worktree, { force: true }).catch(() => {});
      this.missions.delete(id);
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
          `Nested subagent depth is limited to ${depthLimit} for ${parent.profile.name}.`,
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
          timeoutMs: profile.timeout ? profile.timeout * 1_000 : externalRunner.timeoutMs,
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

    const runs: RunRecord[] = [];
    try {
      for (const item of prepared) {
        this.assertOpen();
        runs.push(await this.startPrepared(item, ctx, options.parentId, options.missionId));
      }
      return runs;
    } catch (cause) {
      await Promise.all(runs.map((run) => this.stop(run.id).catch(() => undefined)));
      throw cause;
    }
  }

  private async startPrepared(
    prepared: PreparedRun,
    ctx: ExtensionContext,
    parentId?: string,
    missionId?: string,
  ): Promise<RunRecord> {
    this.assertOpen();
    const id = `${prepared.profile.name}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    const sessionDir = join(this.sessionRoot, parentSessionId(ctx), id);
    const runWorktree =
      prepared.profile.class === "write" && prepared.task.workspace === "worktree" && !missionId
        ? await createMissionWorktree(prepared.cwd, id)
        : undefined;
    if (this.shutdownController.signal.aborted) {
      if (runWorktree) await removeMissionWorktree(runWorktree, { force: true }).catch(() => {});
      this.assertOpen();
    }
    const runCwd = runWorktree?.cwd ?? prepared.cwd;
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
        workspace: prepared.task.workspace ?? "shared",
      },
      status: "starting",
      runner: prepared.profile.runner,
      startedAt: new Date().toISOString(),
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
      worktree: runWorktree,
      completionReported: false,
    };
    recordActivity(
      run,
      "spawn",
      `starting ${prepared.profile.name} through ${prepared.profile.runner} runner`,
    );
    let registered = false;
    try {
      this.store.add(run);
      registered = true;
      this.claims.reserve(
        id,
        prepared.task,
        WRITE_CLASSES.has(profileClass(prepared.profile)) ? "write" : "read",
      );
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
            timeoutMs: prepared.profile.timeout ? prepared.profile.timeout * 1_000 : undefined,
            signal: this.shutdownController.signal,
          },
          (event) => this.onRunnerEvent(run, event),
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
            timeoutMs: prepared.profile.timeout ? prepared.profile.timeout * 1_000 : undefined,
            signal: this.shutdownController.signal,
          },
          (event) => this.onRunnerEvent(run, event),
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
            signal: this.shutdownController.signal,
          },
          (event) => this.onRunnerEvent(run, event),
        );
      }
      return run;
    } catch (cause) {
      if (registered) await this.parkTransport(run).catch(() => {});
      else this.claims.release(run.id);
      if (run.worktree) {
        try {
          await removeMissionWorktree(run.worktree, { force: true });
          run.worktree = undefined;
        } catch (cleanupCause) {
          recordActivity(
            run,
            "error",
            `startup worktree cleanup failed: ${cleanupCause instanceof Error ? cleanupCause.message : String(cleanupCause)}`,
          );
        }
      }
      if (registered) {
        this.fail(run, cause instanceof Error ? cause.message : String(cause));
        this.store.changed();
      }
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
      `You are the ${profile.name} subagent running through the ${profile.runner} runner.`,
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

  private requestFromRun(
    run: RunRecord,
    input: Omit<SupervisorRequestInput, "fromRunId" | "missionId">,
  ): ReturnType<SupervisorInbox["request"]> {
    const outcome = this.inbox.request({
      ...input,
      fromRunId: run.id,
      missionId: run.missionId,
    });
    if (outcome.request.blocking && run.missionId) {
      const mission = this.missions.get(run.missionId);
      if (mission?.status === "running") mission.status = "blocked";
      void outcome.resolution.finally(() => {
        const current = this.missions.get(run.missionId!);
        if (current?.status === "blocked")
          current.status = this.store
            .all()
            .some(
              (candidate) =>
                candidate.missionId === run.missionId && ACTIVE_STATUSES.has(candidate.status),
            )
            ? "running"
            : "parked";
        this.publish();
      });
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
            ["contact_supervisor", "subagent_dispatch", "subagent_collect"].includes(event.toolName)
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
          const prior = run.status;
          run.status = "blocked";
          recordActivity(run, "approval", `waiting for approval: ${risk ?? event.toolName}`);
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
          if (run.status === "blocked") run.status = prior === "blocked" ? "running" : prior;
          recordActivity(
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
        execute: async (_toolCallId, params) => {
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
          const previous = run.status;
          run.status = "blocked";
          this.store.changed();
          const answer = await resolution;
          if (run.status === "blocked") run.status = previous === "blocked" ? "running" : previous;
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
        name: "subagent_dispatch",
        label: "Dispatch subagents",
        description:
          "Dispatch all independent ready specialist tasks in one batch with disjoint ownership.",
        parameters: Type.Object({
          tasks: Type.Array(
            Type.Object({
              key: Type.String(),
              agent: Type.String(),
              task: Type.String(),
              owns: Type.Array(Type.String()),
              deliverable: Type.String(),
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
        execute: async (_toolCallId, params) => {
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
        label: "Collect subagents",
        description: "Wait for owned children and return their reports.",
        parameters: Type.Object({
          ids: Type.Optional(Type.Array(Type.String())),
          wait: Type.Optional(
            Type.Union([Type.Literal("none"), Type.Literal("next"), Type.Literal("all")]),
          ),
        }),
        execute: async (_toolCallId, params, signal) => {
          const owned = this.store.children(run.id).map((child) => child.id);
          const ids = params.ids ?? owned;
          if (ids.some((id) => !owned.includes(id)))
            return textResult("An orchestrator may collect only its owned children.", true);
          const collected = await this.collect(ids, params.wait ?? "all", signal);
          return textResult(
            collected
              .map(
                (child) =>
                  `## ${child.name} · ${child.status}\n${child.report || child.error || "(no report)"}`,
              )
              .join("\n\n"),
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
    if (!model) throw new Error(`Configured subagent model ${name} is unavailable.`);
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok)
      throw new Error(`Configured subagent model ${name} is not authenticated: ${auth.error}.`);
    return model;
  }

  private enforceBudget(run: RunRecord): void {
    if (!ACTIVE_STATUSES.has(run.status)) return;
    const profile = run.profileSnapshot;
    let reason: string | undefined;
    if (profile.turnBudget !== undefined && run.turns > profile.turnBudget)
      reason = `Turn budget exceeded (${run.turns}/${profile.turnBudget}).`;
    else if (profile.tokenBudget !== undefined && run.usage.total > profile.tokenBudget)
      reason = `Token budget exceeded (${run.usage.total}/${profile.tokenBudget}).`;
    else if (profile.costBudget !== undefined && run.usage.cost > profile.costBudget)
      reason = `Cost budget exceeded ($${run.usage.cost.toFixed(4)}/$${profile.costBudget.toFixed(4)}).`;
    if (!reason) return;
    this.fail(run, reason);
    void this.releaseFailedRun(run);
  }

  private onRunnerEvent(run: RunRecord, event: NativeRunEvent): void {
    if (this.shutdownController.signal.aborted || !ACTIVE_STATUSES.has(run.status)) return;
    if (event.type === "accepted") {
      run.status = "running";
      run.sessionFile = event.sessionFile;
      recordActivity(run, "prompt", `initial prompt accepted by ${run.runner} runner`);
    } else if (event.type === "session") {
      run.sessionFile = event.sessionFile;
    } else if (event.type === "text") {
      run.report = event.text;
      recordActivity(run, "message", event.delta.slice(-160));
    } else if (event.type === "tool_start") {
      run.currentTool = event.toolName;
      recordActivity(run, "tool", `started ${event.toolName}`);
    } else if (event.type === "tool_end") {
      run.currentTool = undefined;
      recordActivity(run, "tool", `${event.toolName} ${event.isError ? "failed" : "finished"}`);
    } else if (event.type === "turn_end") {
      run.turns += 1;
      this.enforceBudget(run);
    } else if (event.type === "usage") {
      run.usage.input += event.input;
      run.usage.output += event.output;
      run.usage.cacheRead += event.cacheRead;
      run.usage.cacheWrite += event.cacheWrite;
      run.usage.total =
        run.usage.input + run.usage.output + run.usage.cacheRead + run.usage.cacheWrite;
      run.usage.cost += event.cost;
      this.enforceBudget(run);
    } else if (event.type === "model") {
      run.effectiveModel = `${event.provider}/${event.id}`;
    } else if (event.type === "settled") {
      run.report = event.report || run.report;
      void this.park(run.id);
    } else if (event.type === "error") {
      this.fail(run, event.error.message);
      void this.releaseFailedRun(run);
    }
    this.store.changed();
  }

  private async releaseFailedRun(run: RunRecord): Promise<void> {
    for (const child of this.store.children(run.id))
      if (ACTIVE_STATUSES.has(child.status)) await this.stop(child.id).catch(() => {});
    await this.parkTransport(run).catch(() => {});
    await this.inspectors.close(run.id);
    if (run.missionId) await this.maybeFinalizeMission(run.missionId);
  }

  private fail(run: RunRecord, error: string): void {
    if (!ACTIVE_STATUSES.has(run.status)) return;
    run.status = "failed";
    run.error = error;
    run.finishedAt = new Date().toISOString();
    recordActivity(run, "error", error);
    this.claims.release(run.id);
    this.inbox.cancelByRun(run.id, "Source run failed.");
    this.reportCompletion(run);
    this.store.changed();
  }

  private async park(id: string): Promise<RunRecord> {
    const run = this.store.get(id);
    if (!run) throw new Error(`Unknown subagent: ${id}.`);
    if (run.status === "parked") return run;
    await this.parkTransport(run);
    if (ACTIVE_STATUSES.has(run.status) && run.worktree && !run.candidate) {
      try {
        await this.finalizeRunWorktree(run);
      } catch (cause) {
        this.fail(run, cause instanceof Error ? cause.message : String(cause));
      }
    }
    if (ACTIVE_STATUSES.has(run.status)) {
      run.status = "parked";
      run.finishedAt = new Date().toISOString();
      recordActivity(run, "park", "completed session parked; live resources released");
    }
    this.claims.release(id);
    await this.inspectors.close(id);
    this.reportCompletion(run);
    this.store.changed();
    if (run.missionId) await this.maybeFinalizeMission(run.missionId);
    return run;
  }

  private async finalizeRunWorktree(run: RunRecord): Promise<void> {
    if (!run.worktree) return;
    const candidate = await captureWorktreeCandidate(run.worktree);
    run.candidate = candidate;
    if (!candidate.hasChanges) {
      await removeMissionWorktree(run.worktree, { force: true });
      run.worktree = undefined;
      recordActivity(run, "status", "isolated worktree had no changes and was removed");
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
    recordActivity(run, "status", `integration candidate ready: ${candidate.files.join(", ")}`);
  }

  async collect(
    ids: readonly string[] | undefined,
    wait: CollectMode,
    signal?: AbortSignal,
  ): Promise<RunSnapshot[]> {
    const selected = ids?.length
      ? ids.map((id) => this.store.get(id)).filter((run): run is RunRecord => Boolean(run))
      : this.store.all();
    if (wait !== "none" && selected.some((run) => ACTIVE_STATUSES.has(run.status)))
      await new Promise<void>((resolve) => {
        let done = false;
        const finish = () => {
          if (done) return;
          const settled = selected.filter((run) => !ACTIVE_STATUSES.has(run.status)).length;
          const blocked = selected.some((run) => run.status === "blocked");
          if (
            signal?.aborted ||
            blocked ||
            (wait === "next" ? settled > 0 : settled === selected.length)
          ) {
            done = true;
            unsubscribe();
            signal?.removeEventListener("abort", finish);
            resolve();
          }
        };
        let unsubscribe = (): void => {};
        unsubscribe = this.store.subscribe(finish);
        signal?.addEventListener("abort", finish, { once: true });
        finish();
      });
    return selected.map((run) => runSnapshot(run));
  }

  /**
   * Take child usage that has not yet been attached to a parent Pi tool result.
   * The ledger is persisted with each run so repeated collection and parent-session
   * reloads do not double-count the same child turns.
   */
  takeUnreportedUsage(ids: readonly string[] | undefined): Usage {
    const selected = ids?.length
      ? ids.map((id) => this.store.get(id)).filter((run): run is RunRecord => Boolean(run))
      : this.store.all();
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
    if (!run) throw new Error(`Unknown subagent: ${id}.`);
    if (!message.trim()) throw new Error("Steering guidance must not be empty.");
    if (this.planMode && run.profile.class === "write")
      throw new Error(
        `Write profile ${run.profile.name} cannot be steered while Plan Mode is active.`,
      );
    if (run.status === "parked") return this.revive(run, message);
    if (run.status !== "running" && run.status !== "blocked")
      throw new Error(`Subagent ${id} cannot be steered while ${run.status}.`);
    run.task = message;
    run.taskHistory.push(message);
    recordActivity(run, "steer", message.slice(0, 160));
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
    this.assertOpen();
    if (!this.ctx) throw new Error("The parent Pi session is unavailable.");
    if (run.runner === "external")
      throw new Error("One-shot external runners cannot be revived; dispatch a new task instead.");
    if (run.ownership.workspace === "worktree" && (run.candidate || !run.worktree))
      throw new Error(
        `Isolated run ${run.id} already produced or disposed its integration candidate; dispatch a new task instead.`,
      );
    if (!run.sessionFile)
      throw new Error(`Subagent ${run.id} has no persistent session to revive.`);
    const config = await this.loadConfig();
    if (this.store.active().length >= config.runtime.maxActive)
      throw new Error("No active subagent capacity is available.");
    run.status = "starting";
    run.finishedAt = undefined;
    run.task = message;
    run.taskHistory.push(message);
    run.error = undefined;
    run.completionReported = false;
    this.claims.reserve(
      run.id,
      {
        key: run.ownership.key,
        agent: run.profile.name,
        task: message,
        owns: run.ownership.owns,
        deliverable: run.ownership.deliverable,
        workspace: run.ownership.workspace,
      },
      WRITE_CLASSES.has(profileClass(run.profile)) ? "write" : "read",
    );
    const capabilities = capabilityPolicySnapshot(run.capabilityPolicy);
    if (capabilities.diagnostics.length) {
      this.claims.release(run.id);
      run.status = "parked";
      run.finishedAt = new Date().toISOString();
      throw new Error(capabilities.diagnostics.map((entry) => entry.message).join("\n"));
    }
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
    try {
      if (run.runner === "native")
        await this.native.start(
          {
            id: run.id,
            cwd: run.worktree?.cwd ?? this.ctx.cwd,
            agentDir: PI_AGENT_DIR,
            sessionDir: run.sessionDir,
            resumeSessionFile: run.sessionFile,
            task: message,
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
            timeoutMs: run.profileSnapshot.timeout
              ? run.profileSnapshot.timeout * 1_000
              : undefined,
            signal: this.shutdownController.signal,
          },
          (event) => this.onRunnerEvent(run, event),
        );
      else
        await this.rpc.start(
          {
            id: run.id,
            cwd: run.worktree?.cwd ?? this.ctx.cwd,
            sessionDir: run.sessionDir,
            resumeSessionFile: run.sessionFile,
            task: message,
            systemPrompt: this.childSystemPrompt(run.profileSnapshot, capabilities),
            model: run.effectiveModel,
            thinking: run.effectiveThinking,
            tools: [...new Set([...run.profileSnapshot.tools, ...capabilities.tools])],
            extensionPaths,
            skillPaths,
            timeoutMs: run.profileSnapshot.timeout
              ? run.profileSnapshot.timeout * 1_000
              : undefined,
            signal: this.shutdownController.signal,
          },
          (event) => this.onRunnerEvent(run, event),
        );
      return run;
    } catch (cause) {
      this.claims.release(run.id);
      run.status = "parked";
      run.finishedAt = new Date().toISOString();
      recordActivity(run, "error", cause instanceof Error ? cause.message : String(cause));
      this.store.changed();
      throw cause;
    }
  }

  async stop(id: string): Promise<RunRecord> {
    const run = this.store.get(id);
    if (!run) throw new Error(`Unknown subagent: ${id}.`);
    if (run.status === "stopped") return run;
    if (!ACTIVE_STATUSES.has(run.status))
      throw new Error(`Subagent ${id} cannot be stopped while ${run.status}.`);
    for (const child of this.store.children(id))
      if (ACTIVE_STATUSES.has(child.status)) await this.stop(child.id);
    this.inbox.cancelByRun(id);
    await this.abortTransport(run).catch(() => {});
    await this.parkTransport(run).catch(() => {});
    if (run.worktree && !run.candidate) {
      try {
        await this.finalizeRunWorktree(run);
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        recordActivity(run, "error", `could not capture stopped worktree: ${message}`);
        this.inbox.request({
          fromRunId: run.id,
          kind: "blocker",
          title: "Stopped worktree needs manual recovery",
          detail: `${message}\nWorktree retained at ${run.worktree.root}.`,
          choices: [{ value: "keep", label: "Keep worktree" }],
        });
      }
    }
    run.status = "stopped";
    run.finishedAt = new Date().toISOString();
    recordActivity(run, "park", "stopped by supervisor; transcript and recovery state retained");
    this.claims.release(id);
    await this.inspectors.close(id);
    this.reportCompletion(run);
    this.store.changed();
    if (run.missionId) await this.maybeFinalizeMission(run.missionId);
    return run;
  }

  async openInspector(id: string): Promise<void> {
    const run = this.store.get(id);
    if (!run) throw new Error(`Unknown subagent: ${id}.`);
    if (!run.sessionFile) throw new Error("This subagent has no persisted transcript yet.");
    const config = await this.loadConfig();
    if (!config.herdr.enabled)
      throw new Error("Herdr transcript inspection is disabled in Subagents v2 configuration.");
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
    return this.inbox.resolve(id, answer);
  }

  private async integrateRunCandidate(id: string): Promise<void> {
    const run = this.store.get(id);
    if (!run?.worktree || !run.candidate)
      throw new Error(`Run ${id} has no isolated integration candidate.`);
    await applyCandidate(run.worktree.sourceRoot, run.candidate);
    await removeMissionWorktree(run.worktree, { force: true });
    run.candidate = { ...run.candidate, patch: "" };
    run.worktree = undefined;
    recordActivity(run, "status", "integration candidate applied to the source checkout");
    this.store.changed();
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
    const worktree =
      workspace === "worktree" ? await createMissionWorktree(ctx.cwd, id) : undefined;
    if (this.shutdownController.signal.aborted) {
      if (worktree) await removeMissionWorktree(worktree, { force: true }).catch(() => {});
      this.assertOpen();
    }
    const mission: MissionRecord = {
      id,
      task,
      scope: [...scope],
      status: "running",
      orchestratorId: "pending",
      startedAt: new Date().toISOString(),
      workspace,
      worktree,
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
            context: "decisions",
            workspace: workspace === "worktree" ? "worktree" : "shared",
          },
        ],
        ctx,
        { missionId: id, cwd: worktree?.cwd ?? ctx.cwd },
      );
      if (!orchestrator) throw new Error("Failed to start orchestrator.");
      mission.orchestratorId = orchestrator.id;
      await this.maybeFinalizeMission(id);
      this.publish();
      return { ...mission, scope: [...mission.scope] };
    } catch (cause) {
      this.missions.delete(id);
      if (worktree) await removeMissionWorktree(worktree, { force: true }).catch(() => {});
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
      mission.candidate = await captureWorktreeCandidate(mission.worktree);
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
          context: "plan",
          workspace: "shared",
        },
      ],
      ctx,
      { modelOverride: { model, thinking: thinking as ThinkingPolicy | undefined } },
    );
    if (!run) throw new Error("Plan reviewer did not start.");
    const [result] = await this.collect([run.id], "all");
    return {
      reviewerId: run.id,
      model: model ?? result?.effectiveModel,
      thinking: thinking ?? result?.effectiveThinking,
      report: result?.report,
      ...(result?.status === "failed" ? { error: result.error ?? "Reviewer failed." } : {}),
    };
  }

  private reportCompletion(run: RunRecord): void {
    if (run.completionReported) return;
    run.completionReported = true;
    if (run.profile.hidden) return;
    this.pi.sendMessage(
      {
        customType: "subagent-completion-v2",
        content: `${run.profile.name} · ${run.status}\n\n${run.report || run.error || "(no report)"}`,
        display: true,
        details: { run: runSnapshot(run) },
      },
      { triggerTurn: true, deliverAs: "followUp" },
    );
  }

  private statePath(parent: string): string {
    return join(this.sessionRoot, parent, "runs.json");
  }

  private queuePersist(): void {
    if (this.shutdownController.signal.aborted || !this.restoredParent || this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = undefined;
      this.enqueuePersist();
    }, 100);
    this.persistTimer.unref?.();
  }

  private enqueuePersist(): void {
    if (!this.restoredParent) return;
    const path = this.statePath(this.restoredParent);
    const payload = JSON.stringify(
      {
        schemaVersion: 2,
        runs: this.store.all(),
        missions: [...this.missions.values()].map((mission) => ({
          ...mission,
          scope: [...mission.scope],
          worktree: mission.worktree ? { ...mission.worktree } : undefined,
          candidate: mission.candidate
            ? { ...mission.candidate, files: [...mission.candidate.files] }
            : undefined,
        })),
      },
      null,
      2,
    );
    this.persistenceTail = this.persistenceTail
      .catch(() => {})
      .then(async () => {
        await fs.mkdir(dirname(path), { recursive: true });
        const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
        await fs.writeFile(temporary, payload, { mode: 0o600 });
        await fs.rename(temporary, path);
      })
      .catch(() => {});
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

  private async restore(parent: string): Promise<void> {
    if (this.store.all().length) return;
    try {
      const parsed = JSON.parse(await fs.readFile(this.statePath(parent), "utf8")) as {
        schemaVersion?: number;
        runs?: RunRecord[];
        missions?: MissionRecord[];
      };
      if (parsed.schemaVersion !== 2) return;
      for (const run of parsed.runs ?? []) {
        run.turns ??= 0;
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
          run.status = "parked";
          run.finishedAt ??= new Date().toISOString();
          recordActivity(run, "park", "restored after parent shutdown; manual revival required");
        }
        if (run.worktree) {
          try {
            run.worktree = await validateMissionWorktree(
              run.worktree,
              this.ctx?.cwd ?? run.worktree.sourceRoot,
            );
          } catch (cause) {
            const message = cause instanceof Error ? cause.message : String(cause);
            run.status = "failed";
            run.error = `Persisted worktree rejected: ${message}`;
            run.worktree = undefined;
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
            mission.worktree = undefined;
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
    await Promise.all(
      this.store.active().map(async (run) => {
        try {
          await this.abortTransport(run);
        } catch (cause) {
          this.diagnostics.push({
            path: `subagent-runtime:${run.id}`,
            code: "lifecycle",
            message: `Could not abort child transport: ${cause instanceof Error ? cause.message : String(cause)}`,
          });
        }
        try {
          await this.parkTransport(run);
        } catch (cause) {
          this.diagnostics.push({
            path: `subagent-runtime:${run.id}`,
            code: "lifecycle",
            message: `Could not park child transport: ${cause instanceof Error ? cause.message : String(cause)}`,
          });
        }
        if (ACTIVE_STATUSES.has(run.status)) {
          run.status = "parked";
          run.finishedAt = new Date().toISOString();
          recordActivity(run, "park", "parent session closed; run stopped and parked");
        }
        this.claims.release(run.id);
        this.inbox.cancelByRun(run.id, "Parent session closed.");
      }),
    );
  }

  shutdown(): Promise<void> {
    this.unsubscribePlanMode();
    this.unsubscribePlanReview();
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
