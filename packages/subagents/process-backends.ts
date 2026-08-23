import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { existsSync, promises as fs } from "node:fs";
import { basename, join } from "node:path";
import type { ExternalRunnerDefinition } from "./config.js";
import type { NativeRunEvent, NativeRunListener, PreTurnGate } from "./native-backend.js";
import { RpcClient, type RpcEvent } from "./rpc-client.js";

export type RpcRunSpec = {
  id: string;
  cwd: string;
  sessionDir: string;
  resumeSessionFile?: string;
  task: string;
  systemPrompt: string;
  model?: string;
  thinking?: string;
  tools: string[];
  extensionPaths: string[];
  skillPaths: string[];
  /** Retained for caller compatibility; the manager is the sole RPC deadline authority. */
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Awaited by the parent before the first RPC prompt frame. */
  preTurnGate?: PreTurnGate;
  /** Context-free manager gate used at the parent prompt boundary. */
  beforeModelRequest?: () => boolean | Promise<boolean>;
  /** A generated child extension enforces this cumulative cap before internal provider turns. */
  initialCompletedTurns?: number;
  maxTurns?: number;
  /** Absolute manager lease deadline enforced before every child-internal provider request. */
  deadlineAtMs?: number;
};

export type ExternalRunSpec = {
  id: string;
  cwd: string;
  sessionDir: string;
  task: string;
  runner: ExternalRunnerDefinition;
  signal?: AbortSignal;
};

type LiveProcess = {
  child: ChildProcessWithoutNullStreams;
  stopping: boolean;
  isClosed: () => boolean;
  termination?: Promise<void>;
  timer?: ReturnType<typeof setTimeout>;
  removeAbortListener?: () => void;
  rejectStartup?: (error: Error) => void;
  abortRequested?: boolean;
};

type LiveRpc = LiveProcess & {
  client: RpcClient;
  report: string;
  stderr: string;
  accepted: boolean;
  settled: boolean;
  limitReported: boolean;
};

type LiveExternal = LiveProcess & {
  stdout: Buffer;
  stderr: Buffer;
  maxOutputBytes: number;
};

function abortError(signal: AbortSignal | undefined, label: string): Error {
  return signal?.reason instanceof Error
    ? signal.reason
    : new Error(`${label} startup was aborted.`);
}

function throwIfAborted(signal: AbortSignal | undefined, label: string): void {
  if (signal?.aborted) throw abortError(signal, label);
}

function piInvocation(): { command: string; args: string[] } {
  const script = process.argv[1];
  if (script && !script.startsWith("/$bunfs/root/") && existsSync(script))
    return { command: process.execPath, args: [script] };
  if (!/^(node|bun)(\.exe)?$/u.test(basename(process.execPath).toLowerCase()))
    return { command: process.execPath, args: [] };
  return { command: "pi", args: [] };
}

function isolatedProcessEnvironment(allowlist?: readonly string[]): NodeJS.ProcessEnv {
  if (allowlist) {
    const result: NodeJS.ProcessEnv = {};
    for (const name of new Set(["PATH", "LANG", "LC_ALL", "TMPDIR", ...allowlist])) {
      const value = process.env[name];
      if (value !== undefined) result[name] = value;
    }
    return result;
  }
  const result = { ...process.env };
  for (const name of Object.keys(result))
    if (name.startsWith("HERDR_") || name.startsWith("PI_SESSION_")) delete result[name];
  return result;
}

function observeChild(child: ChildProcessWithoutNullStreams): {
  isClosed: () => boolean;
} {
  let didClose = false;
  child.once("close", () => {
    didClose = true;
  });
  return { isClosed: () => didClose };
}

function ownedProcessAlive(live: LiveProcess): boolean {
  if (process.platform === "win32" || !live.child.pid) return !live.isClosed();
  try {
    process.kill(-live.child.pid, 0);
    return true;
  } catch (cause) {
    return (cause as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function killOwned(live: LiveProcess, signal: NodeJS.Signals): void {
  if (process.platform !== "win32" && live.child.pid) {
    try {
      process.kill(-live.child.pid, signal);
      return;
    } catch {
      // Fall through when the process group has already exited or cannot be signalled.
    }
  }
  if (live.child.exitCode === null && live.child.signalCode === null) live.child.kill(signal);
}

async function waitForTermination(live: LiveProcess, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (live.isClosed() && !ownedProcessAlive(live)) return true;
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  return live.isClosed() && !ownedProcessAlive(live);
}

async function terminate(live: LiveProcess): Promise<void> {
  if (live.isClosed() && !ownedProcessAlive(live)) return;
  for (const [signal, timeoutMs] of [
    ["SIGINT", 1_000],
    ["SIGTERM", 2_000],
    ["SIGKILL", 1_000],
  ] as const) {
    killOwned(live, signal);
    if (await waitForTermination(live, timeoutMs)) return;
  }
  throw new Error(`Child process group ${live.child.pid ?? "unknown"} did not terminate.`);
}

function boundedBuffer(current: Buffer, chunk: Buffer, limit: number): Buffer {
  const combined = Buffer.concat([current, chunk]);
  return combined.length <= limit ? combined : combined.subarray(combined.length - limit);
}

function textFromContent(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
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

function rpcErrorMessage(event: RpcEvent, fallback: string): string {
  if (typeof event.error === "string") return event.error;
  return event.error?.message ?? fallback;
}

function usageEvent(message: RpcEvent["message"]): NativeRunEvent | undefined {
  if (!message?.usage || typeof message.usage !== "object") return undefined;
  const usage = message.usage as Record<string, unknown>;
  const count = (key: string) =>
    typeof usage[key] === "number" && Number.isFinite(usage[key]) ? (usage[key] as number) : 0;
  const cost = usage.cost;
  return {
    type: "usage",
    input: count("input"),
    output: count("output"),
    cacheRead: count("cacheRead"),
    cacheWrite: count("cacheWrite"),
    cost:
      cost && typeof cost === "object" && typeof (cost as { total?: unknown }).total === "number"
        ? ((cost as { total: number }).total ?? 0)
        : count("cost"),
  };
}

/** Optional shell-free Pi RPC runner. Native AgentSession remains the default. */
export class RpcProcessBackend {
  private readonly runs = new Map<string, LiveRpc>();

  has(id: string): boolean {
    return this.runs.has(id);
  }

  async start(spec: RpcRunSpec, listener: NativeRunListener): Promise<void> {
    if (this.runs.has(spec.id)) throw new Error(`RPC Hackler ${spec.id} is already active.`);
    throwIfAborted(spec.signal, "RPC Hackler");
    const preTurnGate: PreTurnGate | undefined =
      spec.preTurnGate ??
      (spec.beforeModelRequest
        ? async () => (await spec.beforeModelRequest?.()) === true
        : undefined);
    if (preTurnGate) {
      const allowed =
        (await preTurnGate({
          id: spec.id,
          model: spec.model
            ? {
                provider: spec.model.includes("/")
                  ? spec.model.slice(0, spec.model.indexOf("/"))
                  : "",
                id: spec.model.includes("/")
                  ? spec.model.slice(spec.model.indexOf("/") + 1)
                  : spec.model,
              }
            : undefined,
          boundary: "rpc_parent_prompt",
          signal: spec.signal,
        })) === true;
      throwIfAborted(spec.signal, "RPC Hackler");
      if (!allowed) throw new Error(`RPC Hackler ${spec.id} pre-turn gate denied.`);
    }
    await fs.mkdir(spec.sessionDir, { recursive: true });
    throwIfAborted(spec.signal, "RPC Hackler");
    const systemPromptPath = join(spec.sessionDir, "system-prompt.md");
    await fs.writeFile(systemPromptPath, spec.systemPrompt, { mode: 0o600 });
    const turnLimitMarker = join(spec.sessionDir, "turn-limit.reached");
    const wallLimitMarker = join(spec.sessionDir, "wall-limit.reached");
    const turnGatePath =
      spec.maxTurns === undefined && spec.deadlineAtMs === undefined
        ? undefined
        : join(spec.sessionDir, "runtime-gate.ts");
    if (turnGatePath) {
      const maximumTurns = spec.maxTurns ?? Number.MAX_SAFE_INTEGER;
      const deadlineAtMs = spec.deadlineAtMs ?? Number.MAX_SAFE_INTEGER;
      const source = `import { writeFileSync } from "node:fs";\nexport default function (pi) {\n  let completed = ${Math.max(0, spec.initialCompletedTurns ?? 0)};\n  const enforceWall = (ctx) => {\n    if (Date.now() < ${deadlineAtMs}) return false;\n    writeFileSync(${JSON.stringify(wallLimitMarker)}, "wall_limit", { mode: 0o600 });\n    ctx.abort();\n    return true;\n  };\n  pi.on("before_provider_request", (_event, ctx) => { enforceWall(ctx); });\n  pi.on("turn_start", (_event, ctx) => {\n    if (enforceWall(ctx) || completed < ${maximumTurns}) return;\n    writeFileSync(${JSON.stringify(turnLimitMarker)}, "turn_limit", { mode: 0o600 });\n    ctx.abort();\n  });\n  pi.on("turn_end", () => { completed += 1; });\n}\n`;
      await fs.writeFile(turnGatePath, source, { mode: 0o600 });
    }
    throwIfAborted(spec.signal, "RPC Hackler");
    const invocation = piInvocation();
    const args = [
      ...invocation.args,
      "--mode",
      "rpc",
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--no-context-files",
      "--session-dir",
      spec.sessionDir,
      "--name",
      spec.id,
      "--append-system-prompt",
      systemPromptPath,
      "--tools",
      [...new Set(spec.tools)].join(","),
    ];
    if (spec.resumeSessionFile) args.push("--session", spec.resumeSessionFile);
    if (turnGatePath) args.push("--extension", turnGatePath);
    for (const path of spec.extensionPaths) args.push("--extension", path);
    for (const path of spec.skillPaths) args.push("--skill", path);
    if (spec.model) args.push("--model", spec.model);
    if (spec.thinking) args.push("--thinking", spec.thinking);
    const child = spawn(invocation.command, args, {
      cwd: spec.cwd,
      env: isolatedProcessEnvironment(),
      detached: process.platform !== "win32",
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let accept: (() => void) | undefined;
    let reject: ((error: Error) => void) | undefined;
    const accepted = new Promise<void>((resolve, rejectPromise) => {
      accept = resolve;
      reject = rejectPromise;
    });
    const live: LiveRpc = {
      child,
      stopping: false,
      ...observeChild(child),
      report: "",
      stderr: "",
      accepted: false,
      settled: false,
      limitReported: false,
      client: undefined as unknown as RpcClient,
      rejectStartup: reject,
    };
    const runtimeLimitEvent = (): NativeRunEvent | undefined => {
      if (existsSync(wallLimitMarker)) return { type: "deadline_reached" };
      if (existsSync(turnLimitMarker)) return { type: "turn_limit" };
      return undefined;
    };
    const reportRuntimeLimit = (): boolean => {
      const event = runtimeLimitEvent();
      if (!event) return false;
      if (!live.limitReported) {
        live.limitReported = true;
        listener(event);
      }
      return true;
    };
    live.client = new RpcClient(
      child,
      (event) => {
        if (event.type === "response" && event.id === "initial") {
          if (event.success === false) {
            const error = new Error(
              rpcErrorMessage(event, "RPC child rejected its initial prompt."),
            );
            reject?.(error);
            listener({ type: "error", error });
            return;
          }
          // Do not resolve startup yet: manager cleanup must observe the session path first.
          live.client.getState("state");
          return;
        }
        if (event.type === "response" && event.id === "state") {
          if (event.success === false) {
            reject?.(new Error(rpcErrorMessage(event, "RPC child rejected its state request.")));
            return;
          }
          const sessionFile = event.data?.sessionFile;
          if (typeof sessionFile === "string") listener({ type: "session", sessionFile });
          live.accepted = true;
          live.rejectStartup = undefined;
          listener({ type: "accepted" });
          accept?.();
          return;
        }
        if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
          const delta = event.assistantMessageEvent.delta ?? "";
          live.report += delta;
          listener({ type: "text", delta, text: live.report });
        } else if (event.type === "message_end" && event.message?.role === "assistant") {
          const report = textFromContent(event.message.content);
          if (report) live.report = report;
          const usage = usageEvent(event.message);
          if (usage) listener(usage);
        } else if (event.type === "tool_execution_start" && event.toolName) {
          listener({ type: "tool_start", toolName: event.toolName });
        } else if (event.type === "tool_execution_update" && event.toolName) {
          listener({ type: "tool_update", toolName: event.toolName, update: event.partialResult });
        } else if (event.type === "tool_execution_end" && event.toolName) {
          listener({ type: "tool_end", toolName: event.toolName, isError: event.isError === true });
        } else if (event.type === "turn_end") {
          listener({ type: "turn_end" });
        } else if (event.type === "agent_settled") {
          live.settled = true;
          if (!live.stopping && !reportRuntimeLimit())
            listener({ type: "settled", report: live.report.trim() });
        } else if (event.type === "extension_ui_request") {
          listener({
            type: "error",
            error: new Error(
              "RPC child requested interactive UI; use contact_supervisor in native mode.",
            ),
          });
        } else if (event.type === "error" && !live.stopping && !reportRuntimeLimit()) {
          listener({
            type: "error",
            error: new Error(rpcErrorMessage(event, "RPC child failed.")),
          });
        }
      },
      (error) => {
        if (!live.accepted) reject?.(error);
        if (!live.stopping && !reportRuntimeLimit()) listener({ type: "error", error });
      },
    );
    this.runs.set(spec.id, live);
    child.stderr.on("data", (chunk: Buffer) => {
      live.stderr = `${live.stderr}${chunk.toString("utf8")}`.slice(-64_000);
    });
    child.stdin.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "EPIPE" && !live.stopping) listener({ type: "error", error });
    });
    child.once("error", (error) => {
      if (!live.accepted) reject?.(error);
      if (!live.stopping) listener({ type: "error", error });
    });
    child.once("close", (code, signal) => {
      if (live.timer) clearTimeout(live.timer);
      if (!live.accepted)
        reject?.(
          new Error(
            live.stderr.trim() || `RPC child exited before prompt acceptance (${signal ?? code}).`,
          ),
        );
      else if (!live.stopping && (code !== 0 || !live.settled)) {
        if (!reportRuntimeLimit())
          listener({
            type: "error",
            error: new Error(
              live.stderr.trim() ||
                (code !== 0
                  ? `RPC child exited with ${signal ?? code}.`
                  : "RPC child exited before its terminal lifecycle event."),
            ),
          });
      }
    });
    if (spec.signal) {
      const onAbort = () => {
        if (!live.accepted) reject?.(abortError(spec.signal, "RPC Hackler"));
        void this.park(spec.id).catch(() => {});
      };
      spec.signal.addEventListener("abort", onAbort, { once: true });
      live.removeAbortListener = () => spec.signal?.removeEventListener("abort", onAbort);
      if (spec.signal.aborted) onAbort();
    }
    if (!spec.signal?.aborted) live.client.prompt("initial", spec.task);
    await accepted;
  }

  async steer(id: string, message: string): Promise<void> {
    const live = this.runs.get(id);
    if (!live) throw new Error(`RPC Hackler ${id} is not active.`);
    live.client.steer(`steer-${Date.now()}`, message);
  }

  async followUp(id: string, message: string): Promise<void> {
    const live = this.runs.get(id);
    if (!live) throw new Error(`RPC Hackler ${id} is not active.`);
    live.client.followUp(`followup-${Date.now()}`, message);
  }

  async abort(id: string): Promise<void> {
    const live = this.runs.get(id);
    if (!live) return;
    live.stopping = true;
    if (live.abortRequested) return;
    live.abortRequested = true;
    try {
      live.client.abort();
    } catch {
      // The process can close before the abort frame is written.
    }
  }

  async park(id: string): Promise<void> {
    const live = this.runs.get(id);
    if (!live) return;
    live.stopping = true;
    live.rejectStartup?.(new Error(`RPC Hackler ${id} was parked during startup.`));
    live.rejectStartup = undefined;
    if (live.timer) clearTimeout(live.timer);
    live.removeAbortListener?.();
    live.termination ??= terminate(live)
      .then(() => {
        if (this.runs.get(id) === live) this.runs.delete(id);
      })
      .catch((cause: unknown) => {
        live.termination = undefined;
        throw cause;
      });
    await live.termination;
  }

  async shutdown(): Promise<void> {
    await Promise.all([...this.runs.keys()].map((id) => this.park(id)));
  }
}

/** One-shot external runner: direct spawn, task over stdin, and explicit EOF. */
export class ExternalProcessBackend {
  private readonly runs = new Map<string, LiveExternal>();

  has(id: string): boolean {
    return this.runs.has(id);
  }

  async start(spec: ExternalRunSpec, listener: NativeRunListener): Promise<void> {
    if (this.runs.has(spec.id)) throw new Error(`External Hackler ${spec.id} is already active.`);
    throwIfAborted(spec.signal, "External Hackler");
    await fs.mkdir(spec.sessionDir, { recursive: true });
    throwIfAborted(spec.signal, "External Hackler");
    const child = spawn(spec.runner.command, spec.runner.args, {
      cwd: spec.cwd,
      env: isolatedProcessEnvironment(spec.runner.envAllowlist),
      detached: process.platform !== "win32",
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const live: LiveExternal = {
      child,
      stopping: false,
      ...observeChild(child),
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
      maxOutputBytes: spec.runner.maxOutputBytes,
    };
    this.runs.set(spec.id, live);
    child.stdout.on("data", (chunk: Buffer) => {
      live.stdout = boundedBuffer(live.stdout, chunk, live.maxOutputBytes);
      listener({
        type: "text",
        delta: chunk.toString("utf8"),
        text: live.stdout.toString("utf8"),
      });
    });
    child.stderr.on("data", (chunk: Buffer) => {
      live.stderr = boundedBuffer(live.stderr, chunk, live.maxOutputBytes);
    });
    child.stdin.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "EPIPE" && !live.stopping) listener({ type: "error", error });
    });
    let accept: (() => void) | undefined;
    let reject: ((error: Error) => void) | undefined;
    const accepted = new Promise<void>((resolve, rejectPromise) => {
      accept = resolve;
      reject = rejectPromise;
    });
    live.rejectStartup = reject;
    child.once("spawn", () => {
      if (live.stopping) return;
      live.rejectStartup = undefined;
      listener({ type: "accepted" });
      accept?.();
      child.stdin.end(spec.task);
    });
    child.once("error", (error) => {
      reject?.(error);
      if (!live.stopping) listener({ type: "error", error });
    });
    child.once("close", (code, signal) => {
      if (live.timer) clearTimeout(live.timer);
      if (live.stopping) return;
      if (code === 0) listener({ type: "settled", report: live.stdout.toString("utf8").trim() });
      else
        listener({
          type: "error",
          error: new Error(
            live.stderr.toString("utf8").trim() || `External runner exited with ${signal ?? code}.`,
          ),
        });
    });
    // External runners retain a wall stop because they have no conversational manager
    // lifecycle, but the transport does not invent a semantic wall-limit error reason.
    live.timer = setTimeout(() => {
      void this.park(spec.id).catch(() => {});
    }, spec.runner.timeoutMs);
    live.timer.unref?.();
    if (spec.signal) {
      const onAbort = () => {
        reject?.(abortError(spec.signal, "External Hackler"));
        void this.park(spec.id).catch(() => {});
      };
      spec.signal.addEventListener("abort", onAbort, { once: true });
      live.removeAbortListener = () => spec.signal?.removeEventListener("abort", onAbort);
      if (spec.signal.aborted) onAbort();
    }
    await accepted;
  }

  async abort(id: string): Promise<void> {
    const live = this.runs.get(id);
    if (live) live.stopping = true;
  }

  async park(id: string): Promise<void> {
    const live = this.runs.get(id);
    if (!live) return;
    live.stopping = true;
    live.rejectStartup?.(new Error(`External Hackler ${id} was parked during startup.`));
    live.rejectStartup = undefined;
    if (live.timer) clearTimeout(live.timer);
    live.removeAbortListener?.();
    live.termination ??= terminate(live)
      .then(() => {
        if (this.runs.get(id) === live) this.runs.delete(id);
      })
      .catch((cause: unknown) => {
        live.termination = undefined;
        throw cause;
      });
    await live.termination;
  }

  async shutdown(): Promise<void> {
    await Promise.all([...this.runs.keys()].map((id) => this.park(id)));
  }
}
