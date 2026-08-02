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
import { MAX_ACTIVE, MAX_WORKERS, SESSION_ROOT } from "./config.js";
import { HerdrBackend } from "./herdr-backend.js";
import { HerdrClient } from "./herdr-client.js";
import { activityWidgetLines, formatAgent } from "./renderers.js";
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
  private pendingActive = 0;
  private pendingWorkers = 0;
  private ui?: ExtensionContext["ui"]; 

  private enqueue<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.operationTails.get(id) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(operation);
    this.operationTails.set(id, next);
    void next.finally(() => { if (this.operationTails.get(id) === next) this.operationTails.delete(id); }).catch(() => {});
    return next;
  }

  constructor(private readonly pi: ExtensionAPI) {
    this.rpc = new RpcBackend(
      (agent, event) => this.onRpcEvent(agent, event),
      (agent, code, signal) => this.onClose(agent, code, signal),
    );
    pi.events.on(events.planMode, (data: unknown) => {
      this.planMode = (data as { enabled?: boolean }).enabled === true;
    });
  }

  attachUi(ctx: ExtensionContext): void {
    this.ui = ctx.ui;
    this.publish();
  }
  snapshots(): AgentSnapshot[] {
    return this.store.all().map((agent) => agentSnapshot(agent));
  }

  publish(): void {
    this.pi.events.emit(events.subagentsStatus, this.store.summary());
    this.ui?.setWidget("subagents", activityWidgetLines(this.store.all()));
  }

  async spawn(
    agentName: string | undefined,
    task: string,
    ctx: ExtensionContext,
  ): Promise<ManagedAgent> {
    this.attachUi(ctx);
    const definitions = await discoverAgents();
    const requestedName = agentName ? safeName(agentName) : "explorer";
    const definition = definitions.find((agent) => agent.name === requestedName);
    if (!definition)
      throw new Error(
        `Unknown subagent ${agentName}. Available: ${definitions.map((agent) => agent.name).join(", ")}.`,
      );
    const active = this.store.running();
    const workerCount = active.filter((agent) => agent.definition.mode === "worker").length;
    if (active.length + this.pendingActive >= MAX_ACTIVE)
      throw new Error(`At most ${MAX_ACTIVE} subagents may run at once.`);
    if (definition.mode === "worker" && this.pendingWorkers + workerCount >= MAX_WORKERS)
      throw new Error(`Only ${MAX_WORKERS} worker may run at once.`);
    if (definition.mode === "worker" && this.planMode)
      throw new Error("Workers cannot start while Plan Mode is active.");
    if (definition.mode === "worker" && active.some((agent) => agent.definition.mode === "worker"))
      throw new Error(`Only ${MAX_WORKERS} worker may run at once.`);

    this.pendingActive++;
    if (definition.mode === "worker") this.pendingWorkers++;
    let reserved = true;
    const releaseReservation = () => {
      if (!reserved) return;
      reserved = false;
      this.pendingActive--;
      if (definition.mode === "worker") this.pendingWorkers--;
    };
    try {
      // Verify an explicitly configured Herdr control plane before creating any child resources.
      const backend = await this.selectBackend();
    const id = `${safeName(definition.name)}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    const sessionDir = join(SESSION_ROOT, parentSessionId(ctx), id);
    const contextDir = await fs.mkdtemp(join(tmpdir(), "pi-subagent-context-"));
    await fs.mkdir(sessionDir, { recursive: true });
    // These paths are intentionally separate from parent project and configuration state.
    await Promise.all([
      fs.mkdir(join(contextDir, "context-mode"), { recursive: true }),
      fs.mkdir(join(contextDir, "todos"), { recursive: true }),
    ]);
    // Herdr safely encodes only shell-safe arguments. Keep the multiline child policy in a file.
    await fs.writeFile(childSystemPromptPath({ sessionDir }), childPrompt(definition));
    const requestedModel = definition.model ?? modelName(ctx);
    const requestedThinking = definition.thinking ?? ctx.thinkingLevel;
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
      requestedModel,
      requestedThinking,
      activity: [],
    };
    recordActivity(agent, "spawn", `starting ${definition.mode} via ${backend}`);
    this.store.add(agent);
    releaseReservation();
    this.contextDirs.set(id, contextDir);
    // RPC events own RPC usage; Herdr has no event stream, so JSONL owns its usage.
    const poller = new SessionPoller(agent, () => this.publish(), backend === "herdr");
    this.pollers.set(id, poller);
    poller.start();
    if ("beginPrompt" in poller) await poller.beginPrompt(task);
    try {
      if (backend === "rpc") await this.spawnRpc(agent, task, ctx, contextDir);
      else await this.spawnHerdr(agent, task, ctx, contextDir);
      this.publish();
      return agent;
    } catch (cause) {
      releaseReservation();
      this.settle(agent, "failed", cause instanceof Error ? cause.message : String(cause));
      throw cause;
    }
    } catch (cause) {
      releaseReservation();
      throw cause;
    }
  }

  async send(id: string, message: string): Promise<ManagedAgent> {
    return this.enqueue(id, () => this.sendNow(id, message));
  }

  private async sendNow(id: string, message: string): Promise<ManagedAgent> {
    const agent = this.store.get(id);
    if (!agent || agent.status === "failed" || agent.status === "interrupted")
      throw new Error("No resumable subagent with that id.");
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
    if (poller && "beginPrompt" in poller) await poller.beginPrompt(message);
    else poller?.resetPromptBoundary();
    poller?.start();
    recordActivity(
      agent,
      "guidance",
      `queued guidance: ${message.replace(/\s+/gu, " ").slice(0, 160)}`,
    );
    try {
      await this.backendFor(agent).send(agent, message);
    } catch (cause) {
      // Do not leave a poller running for a follow-up that the backend rejected.
      poller?.stop();
      if (poller && "rollbackPromptBoundary" in poller) poller.rollbackPromptBoundary();
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
    this.publish();
    return agent;
  }

  async redirect(id: string, message: string): Promise<ManagedAgent> {
    return this.enqueue(id, () => this.redirectNow(id, message));
  }

  private async redirectNow(id: string, message: string): Promise<ManagedAgent> {
    const agent = this.store.get(id);
    if (agent?.status !== "running")
      throw new Error("Only a running subagent can be stopped and redirected.");
    if (this.planMode && agent.definition.mode === "worker")
      throw new Error("Workers cannot be redirected while Plan Mode is active.");
    agent.taskHistory.push(message);
    recordActivity(
      agent,
      "redirect",
      `stop & redirect: ${message.replace(/\s+/gu, " ").slice(0, 160)}`,
    );
    const poller = this.pollers.get(id);
    await poller?.beginPrompt(message);
    poller?.start();
    const backend = this.backendFor(agent);
    if (agent.backend === "rpc") {
      agent.redirectMessage = message;
      await (backend.redirect?.(agent, message) ?? backend.interrupt(agent));
    } else if (backend.redirect) await backend.redirect(agent, message);
    else {
      agent.redirectMessage = message;
      await backend.interrupt(agent);
    }
    agent.task = message;
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

  shutdown(): void {
    this.ui?.setWidget("subagents", undefined);
    // Completed children remain alive for follow-ups, so shutdown owns all child cleanup.
    for (const agent of this.store.all()) {
      void this.backendFor(agent).shutdown?.(agent);
      this.pollers.get(agent.id)?.stop();
      this.cleanupContext(agent.id);
    }
  }

  private cleanupContext(agentId: string): void {
    const directory = this.contextDirs.get(agentId);
    this.contextDirs.delete(agentId);
    if (directory) void fs.rm(directory, { recursive: true, force: true });
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

  private async spawnHerdr(
    agent: ManagedAgent,
    task: string,
    ctx: ExtensionContext,
    contextDir: string,
  ): Promise<void> {
    if (!process.env.HERDR_PANE_ID)
      throw new Error("Herdr is detected but HERDR_PANE_ID is unavailable.");
    if (!this.herdr)
      this.herdr = new HerdrBackend(
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
      );
    await this.herdr.spawn(agent, task);
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
      setTimeout(awaitPersistedReport, 200);
    };
    setTimeout(awaitPersistedReport, 200);
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
    if (agent.status === "running")
      this.settle(
        agent,
        code === 0 ? "completed" : "failed",
        code === 0 ? undefined : agent.stderr.trim() || `Child exited with ${signal ?? code}`,
      );
  }
  private settle(agent: ManagedAgent, status: AgentStatus, error?: string): void {
    if (agent.status !== "running") return;
    agent.status = status;
    agent.error = error;
    agent.finishedAt = new Date().toISOString();
    this.pollers.get(agent.id)?.stop();
    if (agent.backend === "herdr") this.herdr?.stopObserving(agent);
    // A completed child is deliberately persistent. Keep its isolated state for follow-ups.
    if (status !== "completed") this.cleanupContext(agent.id);
    recordActivity(agent, error ? "error" : "status", error ?? status);
    if (!agent.completionReported) {
      agent.completionReported = true;
      this.pi.sendMessage({
        customType: "subagent-completion",
        content: [
          `Subagent **${agent.name}** ${status === "completed" ? "completed" : status}.`,
          agent.output || agent.error || "(no report)",
          `Usage: ${formatAgent(agent)}.`,
        ].join("\n\n"),
        display: true,
        details: { agent: agentSnapshot(agent) },
      });
    }
    this.publish();
  }
}
