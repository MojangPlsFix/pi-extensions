import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { events } from "../../shared/events.js";
import { consumeRpcTelemetry, recordActivity, SessionPoller } from "./agent-telemetry.js";
import { discoverAgents, safeName } from "./agents.js";
import type { SubagentBackend } from "./backend.js";
import {
  childEnvironment,
  childIsolationOverrides,
  childPiArgs,
  childPrompt,
  childSystemPromptPath,
  piInvocation,
} from "./child-runtime.js";
import {
  loadSubagentConfig,
  MAX_ACTIVE,
  MAX_WORKERS,
  resolveAgentModelPolicy,
  SESSION_ROOT,
} from "./config.js";
import { HerdrBackend } from "./herdr-backend.js";
import { HerdrClient } from "./herdr-client.js";
import { formatAgent } from "./renderers.js";
import { RpcBackend } from "./rpc-backend.js";
import type { RpcEvent } from "./rpc-client.js";
import { AgentStore } from "./store.js";
import {
  type AgentSnapshot,
  type AgentStatus,
  agentSnapshot,
  emptyUsage,
  type ManagedAgent,
} from "./types.js";

export { childPiArgs, childPrompt, childSystemPromptPath } from "./child-runtime.js";

function parentSessionId(ctx: ExtensionContext): string {
  return (
    safeName(
      ctx.sessionManager.getSessionFile()
        ? basename(ctx.sessionManager.getSessionFile()!, ".jsonl")
        : "unsaved-parent",
    ) || "unsaved-parent"
  );
}
function modelName(ctx: ExtensionContext): string | undefined {
  const model = ctx.model as unknown as { provider?: string; id?: string } | undefined;
  return model?.id ? (model.provider ? `${model.provider}/${model.id}` : model.id) : undefined;
}

export class SubagentManager {
  readonly store = new AgentStore();
  private planMode = false;
  private readonly rpc: RpcBackend;
  private herdr?: HerdrBackend;
  private verifiedHerdrClient?: HerdrClient;
  private readonly pollers = new Map<string, SessionPoller>();
  private readonly contextDirs = new Map<string, string>();
  private readonly operationTails = new Map<string, Promise<unknown>>();
  private readonly reportTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly releases = new Map<string, Promise<void>>();
  private readonly released = new Set<string>();
  private pendingActive = 0;
  private pendingWorkers = 0;
  private shutdownPromise?: Promise<void>;
  private ui?: ExtensionContext["ui"];
  private readonly unsubscribePlanMode: () => void;

  private enqueue<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.operationTails.get(id) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(operation);
    this.operationTails.set(id, next);
    void next
      .finally(() => {
        if (this.operationTails.get(id) === next) this.operationTails.delete(id);
      })
      .catch(() => {});
    return next;
  }

  constructor(private readonly pi: ExtensionAPI) {
    this.rpc = new RpcBackend(
      (agent, event) => this.onRpcEvent(agent, event),
      (agent, code, signal) => this.onClose(agent, code, signal),
    );
    const unsubscribePlanMode = pi.events.on(events.planMode, (data: unknown) => {
      this.planMode = (data as { enabled?: boolean }).enabled === true;
    });
    this.unsubscribePlanMode =
      typeof unsubscribePlanMode === "function" ? unsubscribePlanMode : () => {};
  }

  attachUi(ctx: ExtensionContext): void {
    this.ui = ctx.ui;
    this.publish();
  }
  snapshots(): AgentSnapshot[] {
    return this.store.all().map((agent) => agentSnapshot(agent));
  }

  publish(): void {
    this.pi.events.emit(events.subagentsStatus, {
      ...this.store.summary(),
      agents: this.store.inline(4).map((agent) => agentSnapshot(agent)),
    });
  }

  private assertParentOpen(): void {
    if (this.shutdownPromise) throw new Error("The parent session is shutting down.");
  }

  async spawn(
    agentName: string | undefined,
    task: string,
    ctx: ExtensionContext,
  ): Promise<ManagedAgent> {
    this.assertParentOpen();
    this.attachUi(ctx);
    const definitions = await discoverAgents();
    const requestedName = agentName ? safeName(agentName) : "explorer";
    const definition = definitions.find((agent) => agent.name === requestedName);
    if (!definition)
      throw new Error(
        `Unknown subagent ${agentName}. Available: ${definitions.map((agent) => agent.name).join(", ")}.`,
      );
    const open = this.store.open();
    const workerCount = open.filter((agent) => agent.definition.mode === "worker").length;
    if (open.length + this.pendingActive >= MAX_ACTIVE)
      throw new Error(`At most ${MAX_ACTIVE} subagents may remain open at once. Close one first.`);
    if (definition.mode === "worker" && this.pendingWorkers + workerCount >= MAX_WORKERS)
      throw new Error(`Only ${MAX_WORKERS} worker may remain open at once.`);
    if (definition.mode === "worker" && this.planMode)
      throw new Error("Workers cannot start while Plan Mode is active.");

    this.pendingActive++;
    if (definition.mode === "worker") this.pendingWorkers++;
    let reserved = true;
    let allocatedContextDir: string | undefined;
    let allocatedSessionDir: string | undefined;
    let resourcesOwned = false;
    const releaseReservation = () => {
      if (!reserved) return;
      reserved = false;
      this.pendingActive--;
      if (definition.mode === "worker") this.pendingWorkers--;
    };
    try {
      const resolved = resolveAgentModelPolicy(
        definition,
        await loadSubagentConfig(),
        modelName(ctx),
        ctx.thinkingLevel,
      );
      // Model existence and auth are checked before allocating files, processes, tabs, or panes.
      await this.preflightModel(resolved.model, ctx);
      this.assertParentOpen();
      const backend = await this.selectBackend();
      this.assertParentOpen();
      const id = `${safeName(definition.name)}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
      const sessionDir = join(SESSION_ROOT, parentSessionId(ctx), id);
      allocatedSessionDir = sessionDir;
      const contextDir = await fs.mkdtemp(join(tmpdir(), "pi-subagent-context-"));
      allocatedContextDir = contextDir;
      await fs.mkdir(sessionDir, { recursive: true });
      await Promise.all([
        fs.mkdir(join(contextDir, "context-mode"), { recursive: true }),
        fs.mkdir(join(contextDir, "todos"), { recursive: true }),
      ]);
      await fs.writeFile(childSystemPromptPath({ sessionDir }), childPrompt(definition));
      this.assertParentOpen();
      if (backend === "herdr") this.ensureHerdr(ctx, contextDir);
      const agent: ManagedAgent = {
        id,
        name: definition.name,
        definition,
        task,
        taskHistory: [task],
        status: "running",
        backend,
        startedAt: new Date().toISOString(),
        sessionDir,
        stderr: "",
        output: "",
        usage: emptyUsage(),
        completionReported: false,
        requestedModel: resolved.model,
        requestedThinking: resolved.thinking,
        activity: [],
      };
      recordActivity(agent, "spawn", `starting ${definition.mode} via ${backend}`);
      this.store.add(agent);
      releaseReservation();
      this.contextDirs.set(id, contextDir);
      resourcesOwned = true;
      const poller = new SessionPoller(agent, () => this.publish(), backend === "herdr");
      this.pollers.set(id, poller);
      poller.start();
      await poller.beginPrompt(task);
      try {
        this.assertParentOpen();
        if (backend === "rpc") await this.spawnRpc(agent, task, ctx, contextDir);
        else await this.spawnHerdr(agent, task, ctx, contextDir);
        this.publish();
        return agent;
      } catch (cause) {
        this.settle(agent, "failed", cause instanceof Error ? cause.message : String(cause));
        throw cause;
      }
    } finally {
      releaseReservation();
      if (!resourcesOwned) {
        if (allocatedContextDir) await fs.rm(allocatedContextDir, { recursive: true, force: true });
        if (allocatedSessionDir) await fs.rm(allocatedSessionDir, { recursive: true, force: true });
      }
    }
  }

  async send(id: string, message: string): Promise<ManagedAgent> {
    return this.enqueue(id, () => this.sendNow(id, message));
  }

  private async sendNow(id: string, message: string): Promise<ManagedAgent> {
    if (this.shutdownPromise) throw new Error("The parent session is shutting down.");
    const agent = this.store.get(id);
    if (!agent || !["running", "completed"].includes(agent.status))
      throw new Error("No open resumable subagent with that id.");
    if (this.planMode && agent.definition.mode === "worker")
      throw new Error("Workers cannot resume while Plan Mode is active.");
    const previous = {
      status: agent.status,
      finishedAt: agent.finishedAt,
      task: agent.task,
      taskHistoryLength: agent.taskHistory.length,
      error: agent.error,
      completionReported: agent.completionReported,
      activityLength: agent.activity.length,
    };
    agent.status = "running";
    agent.finishedAt = undefined;
    agent.task = message;
    agent.taskHistory.push(message);
    agent.error = undefined;
    agent.completionReported = false;
    const poller = this.pollers.get(id);
    const promptPoller = poller as
      | (SessionPoller & {
          beginPrompt?: (text: string) => Promise<void>;
          rollbackPromptBoundary?: () => void;
        })
      | undefined;
    if (typeof promptPoller?.beginPrompt === "function") await promptPoller.beginPrompt(message);
    else promptPoller?.resetPromptBoundary();
    promptPoller?.start();
    recordActivity(
      agent,
      "guidance",
      `queued guidance: ${message.replace(/\s+/gu, " ").slice(0, 160)}`,
    );
    try {
      await this.backendFor(agent).send(agent, message);
    } catch (cause) {
      // Do not leave a poller running for a follow-up that the backend rejected.
      promptPoller?.stop();
      promptPoller?.rollbackPromptBoundary?.();
      agent.status = previous.status;
      agent.finishedAt = previous.finishedAt;
      agent.task = previous.task;
      agent.taskHistory.splice(previous.taskHistoryLength);
      agent.error = previous.error;
      agent.completionReported = previous.completionReported;
      agent.activity.splice(previous.activityLength);
      if (previous.status === "running") poller?.start();
      this.publish();
      throw cause;
    }
    if (agent.backend === "herdr") await this.herdr?.updateMetadata?.(agent);
    this.publish();
    return agent;
  }

  async redirect(id: string, message: string): Promise<ManagedAgent> {
    return this.enqueue(id, () => this.redirectNow(id, message));
  }

  private async redirectNow(id: string, message: string): Promise<ManagedAgent> {
    if (this.shutdownPromise) throw new Error("The parent session is shutting down.");
    const agent = this.store.get(id);
    if (agent?.status !== "running")
      throw new Error("Only a running subagent can be stopped and redirected.");
    if (this.planMode && agent.definition.mode === "worker")
      throw new Error("Workers cannot be redirected while Plan Mode is active.");
    const previous = {
      taskHistoryLength: agent.taskHistory.length,
      activityLength: agent.activity.length,
      redirectMessage: agent.redirectMessage,
    };
    agent.taskHistory.push(message);
    recordActivity(
      agent,
      "redirect",
      `stop & redirect: ${message.replace(/\s+/gu, " ").slice(0, 160)}`,
    );
    const poller = this.pollers.get(id);
    const checkpoint = poller?.promptCheckpoint();
    await poller?.beginPrompt(message);
    poller?.start();
    const backend = this.backendFor(agent);
    try {
      if (agent.backend === "rpc") {
        agent.redirectMessage = message;
        await (backend.redirect?.(agent, message) ?? backend.interrupt(agent));
      } else if (backend.redirect) await backend.redirect(agent, message);
      else {
        agent.redirectMessage = message;
        await backend.interrupt(agent);
      }
    } catch (cause) {
      agent.taskHistory.splice(previous.taskHistoryLength);
      agent.activity.splice(previous.activityLength);
      agent.redirectMessage = previous.redirectMessage;
      if (checkpoint) poller?.restorePromptCheckpoint(checkpoint);
      else poller?.rollbackPromptBoundary();
      poller?.start();
      recordActivity(
        agent,
        "transport",
        `redirect failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
      this.publish();
      throw cause;
    }
    agent.task = message;
    if (agent.backend === "herdr") await this.herdr?.updateMetadata(agent);
    this.publish();
    return agent;
  }

  async interrupt(id: string): Promise<ManagedAgent> {
    return this.enqueue(id, () => this.interruptNow(id));
  }

  private async interruptNow(id: string): Promise<ManagedAgent> {
    const agent = this.store.get(id);
    if (agent?.status !== "running") throw new Error("No running subagent with that id.");
    await this.backendFor(agent).interrupt(agent);
    this.settle(agent, "interrupted");
    await this.releaseTransport(agent);
    return agent;
  }

  async wait(
    id: string | undefined,
    all: boolean | undefined,
    signal: AbortSignal | undefined,
  ): Promise<ManagedAgent[]> {
    const selected = id
      ? [this.store.get(id)].filter((agent): agent is ManagedAgent => Boolean(agent))
      : this.store.running();
    if (!selected.length) return [];
    const waits = selected.map(
      (agent) =>
        new Promise<ManagedAgent>((resolve) => {
          let settled = false;
          const finish = () => {
            if (settled) return;
            settled = true;
            clearInterval(timer);
            signal?.removeEventListener("abort", finish);
            resolve(agent);
          };
          const timer = setInterval(() => {
            if (agent.status !== "running") finish();
          }, 50);
          signal?.addEventListener("abort", finish, { once: true });
          if (signal?.aborted) finish();
        }),
    );
    return all ? Promise.all(waits) : [await Promise.race(waits)];
  }

  async close(id: string): Promise<ManagedAgent> {
    return this.enqueue(id, async () => {
      const agent = this.store.get(id);
      if (!agent) throw new Error("Unknown subagent.");
      if (agent.status === "closed" && this.released.has(agent.id)) return agent;
      if (agent.status !== "closed") {
        agent.status = "closed";
        agent.finishedAt ??= new Date().toISOString();
        recordActivity(agent, "close", "closed by parent");
      }
      if (agent.backend === "herdr") await this.herdr?.updateMetadata(agent);
      await this.releaseTransport(agent);
      this.reportCompletion(agent);
      this.publish();
      return agent;
    });
  }

  async focus(id: string): Promise<void> {
    const agent = this.store.get(id);
    if (!agent?.herdrPaneId || agent.backend !== "herdr")
      throw new Error("That subagent has no open Herdr pane.");
    await this.herdr?.focus(agent);
  }

  shutdown(): Promise<void> {
    this.unsubscribePlanMode();
    this.shutdownPromise ??= this.shutdownNow();
    return this.shutdownPromise;
  }

  private async shutdownNow(): Promise<void> {
    await Promise.all(
      this.store.all().map(async (agent) => {
        if (agent.status !== "closed") {
          agent.status = "closed";
          agent.finishedAt ??= new Date().toISOString();
          recordActivity(agent, "close", "parent session shutdown");
        }
        await this.releaseTransport(agent);
      }),
    );
    this.publish();
  }

  private releaseInBackground(agent: ManagedAgent): void {
    void this.releaseTransport(agent).catch((cause) => {
      recordActivity(
        agent,
        "transport",
        `cleanup failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
      this.publish();
    });
  }

  private releaseTransport(agent: ManagedAgent): Promise<void> {
    if (this.released.has(agent.id)) return Promise.resolve();
    const pending = this.releases.get(agent.id);
    if (pending) return pending;
    const release = this.releaseTransportNow(agent)
      .then(() => {
        this.released.add(agent.id);
      })
      .finally(() => {
        if (this.releases.get(agent.id) === release) this.releases.delete(agent.id);
      });
    this.releases.set(agent.id, release);
    return release;
  }

  private async releaseTransportNow(agent: ManagedAgent): Promise<void> {
    const reportTimer = this.reportTimers.get(agent.id);
    if (reportTimer) clearTimeout(reportTimer);
    this.reportTimers.delete(agent.id);
    const poller = this.pollers.get(agent.id);
    poller?.stop();
    const idle = (poller as unknown as { idle?: () => Promise<void> } | undefined)?.idle;
    if (idle) await idle.call(poller);
    this.pollers.delete(agent.id);
    let lastError: unknown;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await this.backendFor(agent).shutdown?.(agent);
        lastError = undefined;
        break;
      } catch (cause) {
        lastError = cause;
        recordActivity(
          agent,
          "transport",
          `cleanup attempt ${attempt} failed: ${cause instanceof Error ? cause.message : String(cause)}`,
        );
        if (attempt < 3) await new Promise<void>((resolve) => setTimeout(resolve, attempt * 100));
      }
    }
    if (lastError) {
      this.publish();
      throw lastError;
    }
    await this.cleanupContext(agent.id);
  }

  private async cleanupContext(agentId: string): Promise<void> {
    const directory = this.contextDirs.get(agentId);
    this.contextDirs.delete(agentId);
    if (directory) await fs.rm(directory, { recursive: true, force: true });
  }

  private childArgs(agent: ManagedAgent): string[] {
    return childPiArgs(agent);
  }

  private async spawnRpc(
    agent: ManagedAgent,
    task: string,
    ctx: ExtensionContext,
    contextDir: string,
  ): Promise<void> {
    const invocation = piInvocation();
    const args = [...invocation.args, "--mode", "rpc", ...this.childArgs(agent)];
    const child = spawn(invocation.command, args, {
      cwd: ctx.cwd,
      env: childEnvironment(contextDir),
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
    });
    agent.process = child;
    this.rpc.spawn(agent, task);
    child.once("close", () => {
      void fs.rm(contextDir, { recursive: true, force: true });
    });
  }

  private ensureHerdr(ctx: ExtensionContext, contextDir: string): void {
    if (!process.env.HERDR_PANE_ID)
      throw new Error("Herdr is detected but HERDR_PANE_ID is unavailable.");
    this.herdr ??= new HerdrBackend(
      this.verifiedHerdrClient ?? new HerdrClient(),
      process.env.HERDR_PANE_ID,
      ctx.cwd,
      // Never serialize parent credentials through Herdr's --env arguments.
      (child) => childIsolationOverrides(this.contextDirs.get(child.id) ?? contextDir),
      (child) => this.childArgs(child),
      (child) => this.onHerdrReady(child),
      (child, error) => this.settle(child, "failed", error.message),
      (child, error) => {
        recordActivity(child, "transport", `Herdr wait retry: ${error.message}`);
        this.publish();
      },
      (error) => {
        this.ui?.notify(error.message, "warning");
        for (const child of this.store.open())
          if (child.backend === "herdr") recordActivity(child, "transport", error.message);
        this.publish();
      },
      true,
    );
  }

  private async spawnHerdr(
    agent: ManagedAgent,
    task: string,
    ctx: ExtensionContext,
    contextDir: string,
  ): Promise<void> {
    this.ensureHerdr(ctx, contextDir);
    await this.herdr!.spawn(agent, task);
  }

  private async preflightModel(
    modelName: string | undefined,
    ctx: ExtensionContext,
  ): Promise<void> {
    if (!modelName) return;
    await ctx.modelRegistry.refresh();
    const separator = modelName.indexOf("/");
    const model =
      separator > 0
        ? ctx.modelRegistry.find(modelName.slice(0, separator), modelName.slice(separator + 1))
        : ctx.modelRegistry.getAll().find((candidate) => candidate.id === modelName);
    if (!model)
      throw new Error(
        `Configured Subagent model ${modelName} is unavailable. Check ~/.pi/agent/subagents/config.json or the agent frontmatter before spawning.`,
      );
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok)
      throw new Error(
        `Configured Subagent model ${modelName} is not authenticated: ${auth.error}. Authenticate its provider before spawning.`,
      );
  }

  private async selectBackend(): Promise<"rpc" | "herdr"> {
    const state = HerdrClient.environmentState();
    if (state === "absent") return "rpc";
    if (state === "incomplete")
      throw new Error(
        "Herdr is explicitly configured but incomplete. Set HERDR_ENV=1, HERDR_PANE_ID, and HERDR_SOCKET_PATH, or remove the Herdr environment to use RPC.",
      );
    const parentPaneId = process.env.HERDR_PANE_ID!;
    const client = new HerdrClient();
    try {
      await client.verify(parentPaneId);
      this.verifiedHerdrClient = client;
      return "herdr";
    } catch (cause) {
      throw new Error(
        `Herdr is explicitly configured but its control plane is unavailable: ${cause instanceof Error ? cause.message : String(cause)}. Fix Herdr or remove its environment to use RPC.`,
      );
    }
  }

  private backendFor(agent: ManagedAgent): SubagentBackend {
    if (agent.backend === "rpc") return this.rpc;
    if (!this.herdr) throw new Error("Herdr backend is unavailable.");
    return this.herdr;
  }
  private onHerdrReady(agent: ManagedAgent): void {
    // Herdr's idle/done state is only a transport signal. A final persisted text report decides completion.
    const deadline = Date.now() + 5_000;
    const awaitPersistedReport = () => {
      this.reportTimers.delete(agent.id);
      if (agent.status !== "running" || agent.redirectMessage) return;
      if (this.pollers.get(agent.id)?.hasAssistantSincePrompt()) {
        this.settle(agent, "completed");
        return;
      }
      if (Date.now() >= deadline) {
        recordActivity(
          agent,
          "transport",
          "Herdr settled before a final report; continuing to monitor the child.",
        );
        this.backendFor(agent).observe?.(agent);
        this.publish();
        return;
      }
      const timer = setTimeout(awaitPersistedReport, 200);
      this.reportTimers.set(agent.id, timer);
    };
    const timer = setTimeout(awaitPersistedReport, 200);
    this.reportTimers.set(agent.id, timer);
  }

  private onRpcEvent(agent: ManagedAgent, event: RpcEvent): void {
    consumeRpcTelemetry(agent, event);
    if (event.type === "agent_settled") {
      if (agent.redirectMessage) {
        const message = agent.redirectMessage;
        agent.redirectMessage = undefined;
        agent.task = message;
        this.rpc.send(agent, message);
        recordActivity(
          agent,
          "redirect",
          "interrupted turn settled; replacement instruction submitted",
        );
        this.publish();
      } else this.settle(agent, "completed");
    }
    if (event.type === "extension_ui_request")
      this.settle(
        agent,
        "failed",
        "Child requested interactive UI; subagents must return blockers to the parent.",
      );
    if (event.type === "error")
      this.settle(agent, "failed", event.error?.message ?? "Child RPC error");
  }

  private onClose(agent: ManagedAgent, code: number | null, signal: NodeJS.Signals | null): void {
    if (agent.status === "running" && code !== 0) {
      this.settle(agent, "failed", agent.stderr.trim() || `Child exited with ${signal ?? code}`);
      return;
    }
    if (agent.status === "running" || agent.status === "completed") {
      agent.status = "closed";
      agent.finishedAt ??= new Date().toISOString();
      recordActivity(agent, "close", "RPC child exited; transport released");
      this.pollers.get(agent.id)?.stop();
      this.reportCompletion(agent);
      this.releaseInBackground(agent);
      this.publish();
    }
  }
  private settle(agent: ManagedAgent, status: AgentStatus, error?: string): void {
    if (agent.status !== "running") return;
    agent.status = status;
    agent.error = error;
    agent.finishedAt = new Date().toISOString();
    this.pollers.get(agent.id)?.stop();
    if (agent.backend === "herdr") {
      this.herdr?.stopObserving(agent);
      void this.herdr?.updateMetadata(agent).catch((cause) => {
        recordActivity(
          agent,
          "transport",
          `metadata warning: ${cause instanceof Error ? cause.message : String(cause)}`,
        );
        this.publish();
      });
    }
    recordActivity(agent, error ? "error" : "status", error ?? status);
    this.reportCompletion(agent);
    // Failed and interrupted children release capacity and transport immediately.
    if (status === "failed" || status === "interrupted") this.releaseInBackground(agent);
    this.publish();
  }

  private reportCompletion(agent: ManagedAgent): void {
    if (agent.completionReported) return;
    agent.completionReported = true;
    this.pi.sendMessage({
      customType: "subagent-completion",
      content: [
        `Task: ${agent.task}`,
        agent.output || agent.error || "(no report)",
        `Usage: ${formatAgent(agent)}.`,
      ].join("\n\n"),
      display: true,
      details: { agent: agentSnapshot(agent) },
    });
  }
}
