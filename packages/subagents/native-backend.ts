import { promises as fs } from "node:fs";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai/compat";
import {
  type AgentSession,
  type AgentSessionEvent,
  createAgentSession,
  DefaultResourceLoader,
  type InlineExtension,
  type ModelRuntime,
  SessionManager,
  SettingsManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { matchesAnyToolPattern } from "./capabilities.js";

export type NativeRunSpec = {
  id: string;
  cwd: string;
  agentDir: string;
  sessionDir: string;
  resumeSessionFile?: string;
  parentSessionFile?: string;
  task: string;
  systemPrompt: string;
  model?: Model<any>;
  modelRuntime?: ModelRuntime;
  thinkingLevel?: ThinkingLevel;
  tools: string[];
  toolPatterns?: string[];
  extensionPaths?: string[];
  skillPaths?: string[];
  customTools?: ToolDefinition[];
  extensionFactories?: InlineExtension[];
  timeoutMs?: number;
  signal?: AbortSignal;
};

export type NativeRunEvent =
  | { type: "accepted"; sessionFile?: string }
  | { type: "session"; sessionFile: string }
  | { type: "text"; delta: string; text: string }
  | { type: "tool_start"; toolName: string }
  | { type: "tool_update"; toolName: string; update: unknown }
  | { type: "tool_end"; toolName: string; isError: boolean }
  | { type: "turn_end" }
  | {
      type: "usage";
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
      cost: number;
    }
  | { type: "model"; provider: string; id: string }
  | { type: "settled"; report: string }
  | { type: "error"; error: Error };

export type NativeRunListener = (event: NativeRunEvent) => void;

type LiveNativeRun = {
  session: AgentSession;
  unsubscribe: () => void;
  removeAbortListener: () => void;
  prompt: Promise<void>;
  report: string;
  accepted: boolean;
  stopping: boolean;
  rejectStartup?: (error: Error) => void;
  parking?: Promise<void>;
  timer?: ReturnType<typeof setTimeout>;
};

function assistantText(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const candidate = message as { role?: string; content?: unknown };
  if (candidate.role !== "assistant" || !Array.isArray(candidate.content)) return "";
  return candidate.content
    .filter((part): part is { type: "text"; text: string } =>
      Boolean(
        part &&
          typeof part === "object" &&
          (part as { type?: unknown }).type === "text" &&
          typeof (part as { text?: unknown }).text === "string",
      ),
    )
    .map((part) => part.text)
    .join("");
}

function usageFrom(message: unknown): NativeRunEvent | undefined {
  if (!message || typeof message !== "object") return undefined;
  const usage = (message as { usage?: Record<string, unknown> }).usage;
  if (!usage) return undefined;
  const number = (key: string): number =>
    typeof usage[key] === "number" && Number.isFinite(usage[key]) ? (usage[key] as number) : 0;
  return {
    type: "usage",
    input: number("input"),
    output: number("output"),
    cacheRead: number("cacheRead"),
    cacheWrite: number("cacheWrite"),
    cost: number("cost"),
  };
}

function abortError(signal: AbortSignal | undefined): Error {
  return signal?.reason instanceof Error
    ? signal.reason
    : new Error("Native subagent startup was aborted.");
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortError(signal);
}

async function waitAtMost(action: Promise<unknown>, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    action.catch(() => {}),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
    }),
  ]);
  if (timer) clearTimeout(timer);
}

/** In-process, shell-free AgentSession transport. */
export class NativeBackend {
  private readonly runs = new Map<string, LiveNativeRun>();

  has(id: string): boolean {
    return this.runs.has(id);
  }

  sessionFile(id: string): string | undefined {
    return this.runs.get(id)?.session.sessionFile;
  }

  async start(spec: NativeRunSpec, listener: NativeRunListener): Promise<void> {
    if (this.runs.has(spec.id)) throw new Error(`Native subagent ${spec.id} is already active.`);
    throwIfAborted(spec.signal);
    await fs.mkdir(spec.sessionDir, { recursive: true });
    throwIfAborted(spec.signal);
    let startupSession: AgentSession | undefined;
    let registered = false;
    try {
      const settingsManager = SettingsManager.inMemory(undefined, { projectTrusted: false });
      const loader = new DefaultResourceLoader({
        cwd: spec.cwd,
        agentDir: spec.agentDir,
        settingsManager,
        additionalExtensionPaths: spec.extensionPaths ?? [],
        additionalSkillPaths: spec.skillPaths ?? [],
        extensionFactories: spec.extensionFactories,
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
        systemPrompt: spec.systemPrompt,
        appendSystemPrompt: [],
      });
      await loader.reload();
      throwIfAborted(spec.signal);
      const extensionErrors = loader.getExtensions().errors;
      if (extensionErrors.length)
        throw new Error(
          extensionErrors
            .map((entry) => `Failed to load child extension ${entry.path}: ${entry.error}`)
            .join("\n"),
        );
      const sessionManager = spec.resumeSessionFile
        ? SessionManager.open(spec.resumeSessionFile, spec.sessionDir, spec.cwd)
        : SessionManager.create(spec.cwd, spec.sessionDir, {
            id: spec.id,
            parentSession: spec.parentSessionFile,
          });
      const { session } = await createAgentSession({
        cwd: spec.cwd,
        agentDir: spec.agentDir,
        settingsManager,
        sessionManager,
        resourceLoader: loader,
        modelRuntime: spec.modelRuntime,
        model: spec.model,
        thinkingLevel: spec.thinkingLevel,
        // Keep every tool in the registry so exact and wildcard capability selection can be
        // resolved after extensions bind. No built-in starts active; the audited list below does.
        noTools: "builtin",
        customTools: spec.customTools,
      });
      startupSession = session;
      throwIfAborted(spec.signal);
      session.setSessionName?.(spec.id);
      await session.bindExtensions({
        mode: "print",
        abortHandler: () => void session.abort(),
        onError: (error) =>
          listener({
            type: "error",
            error: new Error(`Child extension ${error.extensionPath} failed: ${error.error}`),
          }),
      });
      throwIfAborted(spec.signal);
      const patterns = spec.toolPatterns ?? [];
      const customToolNames = new Set((spec.customTools ?? []).map((tool) => tool.name));
      const activeTools = session
        .getAllTools()
        .map((tool) => tool.name)
        .filter(
          (name) =>
            spec.tools.includes(name) ||
            customToolNames.has(name) ||
            matchesAnyToolPattern(name, patterns),
        );
      session.setActiveToolsByName(activeTools);

      const live: LiveNativeRun = {
        session,
        unsubscribe: () => {},
        removeAbortListener: () => {},
        prompt: Promise.resolve(),
        report: "",
        accepted: false,
        stopping: false,
      };
      live.unsubscribe = session.subscribe((event) => this.forward(live, event, listener));
      this.runs.set(spec.id, live);
      registered = true;
      if (spec.timeoutMs) {
        live.timer = setTimeout(() => {
          if (live.stopping) return;
          listener({
            type: "error",
            error: new Error(`Native subagent timed out after ${spec.timeoutMs} ms.`),
          });
          live.stopping = true;
          void live.session.abort().catch(() => {});
        }, spec.timeoutMs);
        live.timer.unref?.();
      }

      let accept: (() => void) | undefined;
      let reject: ((error: Error) => void) | undefined;
      const accepted = new Promise<void>((resolve, rejectPromise) => {
        accept = resolve;
        reject = rejectPromise;
      });
      live.rejectStartup = reject;
      live.prompt = session
        .prompt(spec.task, {
          source: "rpc",
          preflightResult: (success) => {
            if (!success) {
              reject?.(new Error(`Native subagent ${spec.id} rejected its initial prompt.`));
              return;
            }
            live.accepted = true;
            live.rejectStartup = undefined;
            listener({ type: "accepted", sessionFile: session.sessionFile });
            accept?.();
          },
        })
        .then(async () => {
          if (!live.accepted) {
            reject?.(
              new Error(
                `Native subagent ${spec.id} completed without accepting its initial prompt.`,
              ),
            );
            return;
          }
          await session.waitForIdle();
          if (live.timer) clearTimeout(live.timer);
          if (!live.stopping) listener({ type: "settled", report: live.report.trim() });
        })
        .catch((cause: unknown) => {
          const error = cause instanceof Error ? cause : new Error(String(cause));
          if (!live.accepted) reject?.(error);
          if (!live.stopping) listener({ type: "error", error });
        });
      if (spec.signal) {
        const onAbort = () => {
          reject?.(abortError(spec.signal));
          void this.park(spec.id).catch(() => {});
        };
        spec.signal.addEventListener("abort", onAbort, { once: true });
        live.removeAbortListener = () => spec.signal?.removeEventListener("abort", onAbort);
        if (spec.signal.aborted) onAbort();
      }
      await accepted;
    } catch (cause) {
      if (registered) await this.park(spec.id).catch(() => {});
      else if (startupSession) {
        await waitAtMost(startupSession.abort(), 2_000);
        startupSession.dispose();
      }
      throw cause;
    }
  }

  private forward(
    live: LiveNativeRun,
    event: AgentSessionEvent,
    listener: NativeRunListener,
  ): void {
    if (event.type === "message_start" && event.message.role === "assistant") live.report = "";
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      live.report += event.assistantMessageEvent.delta;
      listener({ type: "text", delta: event.assistantMessageEvent.delta, text: live.report });
    }
    if (event.type === "message_end" && event.message.role === "assistant") {
      const finalText = assistantText(event.message);
      if (finalText) live.report = finalText;
      const usage = usageFrom(event.message);
      if (usage) listener(usage);
    }
    if (event.type === "tool_execution_start")
      listener({ type: "tool_start", toolName: event.toolName });
    if (event.type === "tool_execution_update")
      listener({ type: "tool_update", toolName: event.toolName, update: event.partialResult });
    if (event.type === "tool_execution_end")
      listener({ type: "tool_end", toolName: event.toolName, isError: event.isError });
    if (event.type === "turn_end") listener({ type: "turn_end" });
  }

  async steer(id: string, message: string): Promise<void> {
    const run = this.runs.get(id);
    if (!run) throw new Error(`Native subagent ${id} is not active.`);
    if (run.session.isStreaming) await run.session.steer(message);
    else await run.session.prompt(message, { source: "rpc" });
  }

  async followUp(id: string, message: string): Promise<void> {
    const run = this.runs.get(id);
    if (!run) throw new Error(`Native subagent ${id} is not active.`);
    if (run.session.isStreaming) await run.session.followUp(message);
    else await run.session.prompt(message, { source: "rpc" });
  }

  async abort(id: string): Promise<void> {
    const run = this.runs.get(id);
    if (!run) return;
    if (run.parking) {
      await run.parking;
      return;
    }
    run.stopping = true;
    await waitAtMost(run.session.abort(), 2_000);
    await waitAtMost(run.session.waitForIdle(), 1_000);
  }

  async park(id: string): Promise<void> {
    const run = this.runs.get(id);
    if (!run) return;
    run.parking ??= (async () => {
      try {
        run.stopping = true;
        if (!run.accepted)
          run.rejectStartup?.(new Error(`Native subagent ${id} was parked during startup.`));
        run.rejectStartup = undefined;
        if (run.timer) clearTimeout(run.timer);
        run.removeAbortListener();
        run.unsubscribe();
        if (!run.session.isIdle) await waitAtMost(run.session.abort(), 2_000);
        await waitAtMost(run.session.waitForIdle(), 1_000);
        run.session.dispose();
      } finally {
        if (this.runs.get(id) === run) this.runs.delete(id);
      }
    })();
    await run.parking;
  }

  async shutdown(): Promise<void> {
    await Promise.all([...this.runs.keys()].map((id) => this.park(id)));
  }
}
