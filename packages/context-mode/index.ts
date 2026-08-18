import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  BRIDGED_TOOLS,
  type BridgedToolName,
  bridgeText,
  ExternalContextBridge,
} from "./bridge.js";
import { registerContextLifecycle } from "./lifecycle.js";
import { createContextCallRenderer, createContextResultRenderer } from "./renderers.js";
import {
  CONTEXT_LANGUAGES,
  ContextAbortError,
  type ExecuteFileRequest,
  type ExecuteRequest,
  formatRunFailure,
  isContextLanguage,
  NativeContextRunner,
} from "./runner.js";
import { enforceExecutionPolicy } from "./security.js";
import type { ContextDetails, ContextToolParams, ContextUpdate } from "./types.js";

export { BRIDGED_TOOLS, bridgeText, ExternalContextBridge } from "./bridge.js";
export {
  createContextCallRenderer,
  createContextResultRenderer,
  renderContextCall,
  renderContextResult,
} from "./renderers.js";
export {
  CONTEXT_MODE_PACKAGE,
  CONTEXT_MODE_VERSION,
  contextModeAvailable,
  contextModeDiagnostic,
  contextModeRoot,
  contextModeServer,
  contextModeVersion,
} from "./resolver.js";
export {
  CONTEXT_LANGUAGES,
  ContextAbortError,
  formatRunFailure,
  isContextLanguage,
  NativeContextRunner,
  nativeRunnerLimits,
  resolveNodeRuntime,
  sanitizeExecutionEnv,
  shellRuntime,
  shellScriptExtension,
} from "./runner.js";
export type { ContextDetails, ContextToolParams, ContextUpdate } from "./types.js";

export const BRIDGE_TOOL_DESCRIPTIONS: Record<string, string> = {
  ctx_index: "Index project text or files into the external Context Mode knowledge base.",
  ctx_search: "Search indexed Context Mode material and return bounded matching sections.",
  ctx_fetch_and_index: "Fetch external sources and index the bounded results for later search.",
  ctx_stats: "Show Context Mode indexing, search, and sandbox statistics.",
  ctx_doctor: "Run read-only Context Mode runtime, storage, hook, and registration diagnostics.",
};

/** Keep upstream validation structure while removing verbose engine-authored prose. */
export function compactBridgeSchema(schema: object): object {
  const sanitize = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(sanitize);
    if (!value || typeof value !== "object") return value;
    const output: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      if (key === "description" || key === "title" || key === "$comment") continue;
      output[key] = sanitize(nested);
    }
    return output;
  };
  return sanitize(schema) as object;
}

const executionSchema = {
  type: "object",
  properties: {
    language: { type: "string", enum: CONTEXT_LANGUAGES, description: "Runtime language" },
    code: { type: "string", description: "Source code to execute" },
    timeout: { type: "number", description: "Maximum execution time in milliseconds" },
    cwd: { type: "string", description: "Project-relative or absolute working directory" },
    intent: {
      type: "string",
      description:
        "For output over 5 KB, index it and return matching sections instead of raw output",
    },
  },
  required: ["language", "code"],
  additionalProperties: false,
} as const;
const fileSchema = {
  ...executionSchema,
  properties: {
    ...executionSchema.properties,
    path: { type: "string", description: "File inside the project directory" },
  },
  required: ["path", "language", "code"],
} as const;
const batchSchema = {
  type: "object",
  properties: {
    commands: {
      type: "array",
      minItems: 1,
      maxItems: 32,
      items: {
        type: "object",
        properties: {
          label: { type: "string", minLength: 1 },
          command: { type: "string", minLength: 1 },
        },
        required: ["label", "command"],
        additionalProperties: false,
      },
    },
    queries: { type: "array", minItems: 1, maxItems: 20, items: { type: "string" } },
    timeout: { type: "number" },
    concurrency: { type: "integer", minimum: 1, maximum: 8, default: 1 },
    cwd: { type: "string" },
    query_scope: { type: "string", enum: ["batch", "global"], default: "batch" },
  },
  required: ["commands", "queries"],
  additionalProperties: false,
} as const;

function textResult(text: string, details: ContextDetails) {
  return { content: [{ type: "text" as const, text }], details };
}

function normalizeExecution(params: ContextToolParams): ExecuteRequest {
  if (!isContextLanguage(params.language))
    throw new Error(`language must be one of: ${CONTEXT_LANGUAGES.join(", ")}.`);
  if (typeof params.code !== "string") throw new Error("code must be a string.");
  if (params.timeout !== undefined && typeof params.timeout !== "number")
    throw new Error("timeout must be a number of milliseconds.");
  if (params.cwd !== undefined && typeof params.cwd !== "string")
    throw new Error("cwd must be a string.");
  if (params.intent !== undefined && typeof params.intent !== "string")
    throw new Error("intent must be a string.");
  return {
    language: params.language,
    code: params.code,
    ...(params.timeout === undefined ? {} : { timeout: params.timeout }),
    ...(params.cwd === undefined ? {} : { cwd: params.cwd }),
    ...(params.intent === undefined ? {} : { intent: params.intent }),
  };
}

type BatchCommand = { label: string; command: string };
type BatchCommandResult = { label: string; command: string; output: string };

const MAX_BATCH_INDEX_BYTES = 1024 * 1024;

function normalizeBatch(params: ContextToolParams): {
  commands: BatchCommand[];
  queries: string[];
  timeout?: number;
  concurrency: number;
  cwd?: string;
  queryScope: "batch" | "global";
} {
  if (!Array.isArray(params.commands) || params.commands.length < 1 || params.commands.length > 32)
    throw new Error("commands must contain between 1 and 32 entries.");
  const commands = params.commands.map((entry, index) => {
    if (!entry || typeof entry.label !== "string" || !entry.label.trim())
      throw new Error(`commands[${index}].label must be a non-empty string.`);
    if (typeof entry.command !== "string" || !entry.command.trim())
      throw new Error(`commands[${index}].command must be a non-empty string.`);
    return { label: entry.label.trim(), command: entry.command };
  });
  if (!Array.isArray(params.queries) || params.queries.length < 1 || params.queries.length > 20)
    throw new Error("queries must contain between 1 and 20 entries.");
  const queries = params.queries.map((query, index) => {
    if (typeof query !== "string" || !query.trim())
      throw new Error(`queries[${index}] must be a non-empty string.`);
    return query.trim();
  });
  if (params.timeout !== undefined && typeof params.timeout !== "number")
    throw new Error("timeout must be a number of milliseconds.");
  const concurrency = params.concurrency ?? 1;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8)
    throw new Error("concurrency must be an integer from 1 to 8.");
  if (params.cwd !== undefined && typeof params.cwd !== "string")
    throw new Error("cwd must be a string.");
  const queryScope = params.query_scope ?? "batch";
  if (queryScope !== "batch" && queryScope !== "global")
    throw new Error('query_scope must be "batch" or "global".');
  return {
    commands,
    queries,
    ...(params.timeout === undefined ? {} : { timeout: params.timeout }),
    concurrency,
    ...(params.cwd === undefined ? {} : { cwd: params.cwd }),
    queryScope,
  };
}

function isAbort(error: unknown): boolean {
  return (
    error instanceof ContextAbortError || (error instanceof Error && error.name === "AbortError")
  );
}

function boundedBatchContent(content: string): { content: string; truncated: boolean } {
  const bytes = Buffer.from(content);
  if (bytes.byteLength <= MAX_BATCH_INDEX_BYTES) return { content, truncated: false };
  return {
    content: `${bytes.subarray(0, MAX_BATCH_INDEX_BYTES).toString("utf8")}\n\n[batch output truncated at ${MAX_BATCH_INDEX_BYTES} bytes]`,
    truncated: true,
  };
}

function formatBatchResult(result: BatchCommandResult): string {
  const command = result.command.replace(/\s+/gu, " ").trim().slice(0, 500);
  return `# ${result.label}\n\n$ ${command}\n\n${result.output || "(no output)"}\n`;
}

function formatElapsed(elapsedMs: number): string {
  const seconds = Math.floor(elapsedMs / 1000);
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

function publish(
  onUpdate: ((update: ContextUpdate) => void) | undefined,
  text: string,
  details: ContextDetails,
): void {
  onUpdate?.({ content: [{ type: "text", text }], details });
}

function startProgressTicker(
  onUpdate: ((update: ContextUpdate) => void) | undefined,
  startedAt: number,
  text: (elapsedMs: number) => string,
  details: ContextDetails,
): ReturnType<typeof setInterval> {
  const timer = setInterval(() => {
    const elapsedMs = Date.now() - startedAt;
    publish(onUpdate, text(elapsedMs), { ...details, elapsedMs });
  }, 500);
  timer.unref?.();
  return timer;
}

const INTENT_INDEX_THRESHOLD = 5000;
const CODE_ECHO_MAX = 2000;

function executionEcho(request: ExecuteRequest | ExecuteFileRequest, file: boolean): string {
  const path = file ? `path=${(request as ExecuteFileRequest).path}\n` : "";
  const code =
    request.code.length <= CODE_ECHO_MAX
      ? request.code
      : `${request.code.slice(0, CODE_ECHO_MAX)}\n… (truncated)`;
  return `${path}\`\`\`${request.language}\n${code}\n\`\`\`\n\n`;
}

export async function indexIntentOutput(input: {
  bridge: ExternalContextBridge;
  output: string;
  intent: string;
  source: string;
  signal: AbortSignal | undefined;
  onUpdate: ((update: ContextUpdate) => void) | undefined;
  details: ContextDetails;
}): Promise<string> {
  const indexing: ContextDetails = {
    ...input.details,
    status: "running",
    backend: "external-bridge",
    cancellation: "best-effort-external",
    phase: "index",
  };
  publish(input.onUpdate, `Indexing output for intent: ${input.intent}`, indexing);
  const indexed = await input.bridge.call(
    "ctx_index",
    { content: input.output, source: input.source },
    input.signal,
    (text) => publish(input.onUpdate, text, indexing),
  );
  if (indexed.isError)
    throw new Error(bridgeText(indexed) || "ctx_index failed for intent output.");
  const searching: ContextDetails = { ...indexing, phase: "search" };
  publish(input.onUpdate, `Searching indexed output for: ${input.intent}`, searching);
  const searched = await input.bridge.call(
    "ctx_search",
    { queries: [input.intent], source: input.source },
    input.signal,
    (text) => publish(input.onUpdate, text, searching),
  );
  const text = bridgeText(searched);
  if (searched.isError) throw new Error(text || "ctx_search failed for intent output.");
  return text;
}

export async function nativeExecution(
  runner: NativeContextRunner,
  request: ExecuteRequest | ExecuteFileRequest,
  signal: AbortSignal | undefined,
  onUpdate: ((update: ContextUpdate) => void) | undefined,
  cwd: string,
  bridge: ExternalContextBridge | undefined,
  file = false,
) {
  const toolName = file ? "ctx_execute_file" : "ctx_execute";
  const startedAt = Date.now();
  const running: ContextDetails = {
    status: "running",
    backend: "native",
    cancellation: "hard",
    phase: "execute",
    toolName,
    elapsedMs: 0,
    outputBytes: 0,
  };
  publish(onUpdate, `Running ${toolName} · 00:00 · 0 bytes`, running);
  const updateProgress = (progress: { elapsedMs: number; outputBytes: number }): void =>
    publish(
      onUpdate,
      `Running ${toolName} · ${formatElapsed(progress.elapsedMs)} · ${progress.outputBytes} bytes`,
      { ...running, ...progress },
    );
  try {
    const result = file
      ? await runner.executeFile(request as ExecuteFileRequest, signal, cwd, updateProgress)
      : await runner.execute(request, signal, cwd, updateProgress);
    const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
    const echo = executionEcho(request, file);
    const intent = request.intent?.trim();
    const failed =
      result.timedOut ||
      result.truncated ||
      result.signal !== null ||
      (result.exitCode !== 0 && result.exitCode !== null);
    const details: ContextDetails = {
      status: failed ? "error" : "success",
      backend: "native",
      outputBytes: Buffer.byteLength(output),
      truncated: result.truncated,
      cancellation: "hard",
      phase: "execute",
      toolName,
      elapsedMs: Date.now() - startedAt,
    };
    if (intent && Buffer.byteLength(output) > INTENT_INDEX_THRESHOLD) {
      if (!bridge)
        throw new Error(`${toolName} intent indexing requires the external Context Mode runtime.`);
      const indexedContent = `${echo}${failed ? formatRunFailure(result) : output || "(no output)"}`;
      const searched = await indexIntentOutput({
        bridge,
        output: indexedContent,
        intent,
        source: `${file ? `file:${(request as ExecuteFileRequest).path}` : `execute:${request.language}`}:${Date.now()}`,
        signal,
        onUpdate,
        details,
      });
      const indexedDetails: ContextDetails = {
        ...details,
        backend: "external-bridge",
        cancellation: "best-effort-external",
        phase: "search",
      };
      publish(onUpdate, `${toolName} indexed and searched output.`, indexedDetails);
      if (failed) throw new Error(`${echo}${searched}`);
      return textResult(`${echo}${searched}`, indexedDetails);
    }
    if (failed) {
      const message = `${echo}${formatRunFailure(result)}`;
      publish(onUpdate, message, details);
      throw new Error(message);
    }
    const content = `${echo}${output || "(no output)"}`;
    publish(onUpdate, `${toolName} finished · ${details.outputBytes ?? 0} bytes`, details);
    return textResult(content, details);
  } catch (error) {
    if (
      error instanceof ContextAbortError ||
      (error instanceof Error && error.name === "AbortError")
    ) {
      publish(onUpdate, "Context Mode execution cancelled; process tree stopped.", {
        status: "cancelled",
        backend: "native",
        cancellation: "hard",
        phase: "execute",
        toolName,
      });
    }
    throw error;
  }
}

export async function nativeBatchExecution(
  runner: NativeContextRunner,
  bridge: ExternalContextBridge,
  params: ContextToolParams,
  signal: AbortSignal | undefined,
  onUpdate: ((update: ContextUpdate) => void) | undefined,
  projectRoot: string,
) {
  const batch = normalizeBatch(params);
  await Promise.all(
    batch.commands.map((command) =>
      enforceExecutionPolicy({
        projectRoot,
        language: "shell",
        code: command.command,
      }),
    ),
  );
  const startedAt = Date.now();
  const results: BatchCommandResult[] = new Array(batch.commands.length);
  let nextIndex = 0;
  let completed = 0;
  const commandBytes = new Array<number>(batch.commands.length).fill(0);

  const publishExecution = (label: string): void =>
    publish(onUpdate, label, {
      status: "running",
      backend: "native",
      cancellation: "hard",
      phase: "execute",
      toolName: "ctx_batch_execute",
      elapsedMs: Date.now() - startedAt,
      outputBytes: commandBytes.reduce((sum, bytes) => sum + bytes, 0),
      completedCommands: completed,
      totalCommands: batch.commands.length,
    });

  publishExecution(`Running 0/${batch.commands.length} batch commands…`);

  const runCommand = async (index: number): Promise<void> => {
    const command = batch.commands[index];
    if (!command) return;
    let timeout = batch.timeout;
    if (batch.concurrency === 1 && timeout !== undefined) {
      const remaining = timeout - (Date.now() - startedAt);
      if (remaining <= 0) {
        results[index] = {
          ...command,
          output: "(skipped — shared batch timeout exceeded)",
        };
        completed++;
        publishExecution(`Completed ${completed}/${batch.commands.length} · ${command.label}`);
        return;
      }
      timeout = remaining;
    }
    try {
      const result = await runner.execute(
        {
          language: "shell",
          code: command.command,
          ...(timeout === undefined ? {} : { timeout }),
          ...(batch.cwd === undefined ? {} : { cwd: batch.cwd }),
        },
        signal,
        projectRoot,
        (progress) => {
          commandBytes[index] = progress.outputBytes;
          publishExecution(
            `Running ctx_batch_execute · ${completed}/${batch.commands.length} · ${formatElapsed(Date.now() - startedAt)} · ${commandBytes.reduce((sum, bytes) => sum + bytes, 0)} bytes`,
          );
        },
      );
      const raw = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
      const failed =
        result.timedOut ||
        result.truncated ||
        result.signal !== null ||
        (result.exitCode !== 0 && result.exitCode !== null);
      results[index] = {
        ...command,
        output: failed ? formatRunFailure(result) : raw || "(no output)",
      };
    } catch (error) {
      if (isAbort(error)) throw error;
      results[index] = {
        ...command,
        output: `(executor error: ${error instanceof Error ? error.message : String(error)})`,
      };
    }
    completed++;
    publishExecution(`Completed ${completed}/${batch.commands.length} · ${command.label}`);
  };

  const worker = async (): Promise<void> => {
    while (true) {
      const index = nextIndex++;
      if (index >= batch.commands.length) return;
      await runCommand(index);
    }
  };

  try {
    await Promise.all(
      Array.from({ length: Math.min(batch.concurrency, batch.commands.length) }, () => worker()),
    );
  } catch (error) {
    if (isAbort(error)) {
      publish(onUpdate, "Context Mode batch cancelled; active process trees stopped.", {
        status: "cancelled",
        backend: "native",
        cancellation: "hard",
        phase: "execute",
        toolName: "ctx_batch_execute",
        elapsedMs: Date.now() - startedAt,
        completedCommands: completed,
        totalCommands: batch.commands.length,
      });
    }
    throw error;
  }

  const combined = results.map(formatBatchResult).join("\n");
  const bounded = boundedBatchContent(combined);
  const source = `batch:${batch.commands
    .map((command) => command.label)
    .join(",")
    .slice(0, 80)}:${Date.now()}`;

  const externalDetails: ContextDetails = {
    status: "running",
    backend: "external-bridge",
    cancellation: "best-effort-external",
    phase: "index",
    toolName: "ctx_batch_execute",
    elapsedMs: Date.now() - startedAt,
    completedCommands: completed,
    totalCommands: batch.commands.length,
    outputBytes: Buffer.byteLength(bounded.content),
    truncated: bounded.truncated,
  };
  publish(onUpdate, `Indexing output from ${completed} commands…`, externalDetails);
  const indexTicker = startProgressTicker(
    onUpdate,
    startedAt,
    (elapsedMs) => `ctx_batch_execute · indexing · ${formatElapsed(elapsedMs)}`,
    externalDetails,
  );
  let indexed: Awaited<ReturnType<ExternalContextBridge["call"]>>;
  try {
    indexed = await bridge.call("ctx_index", { content: bounded.content, source }, signal, (text) =>
      publish(onUpdate, text, externalDetails),
    );
  } finally {
    clearInterval(indexTicker);
  }
  if (indexed.isError) throw new Error(bridgeText(indexed) || "ctx_index failed for batch output.");

  const searchDetails: ContextDetails = { ...externalDetails, phase: "search" };
  publish(onUpdate, `Searching ${batch.queries.length} batch queries…`, searchDetails);
  const searchTicker = startProgressTicker(
    onUpdate,
    startedAt,
    (elapsedMs) => `ctx_batch_execute · searching · ${formatElapsed(elapsedMs)}`,
    searchDetails,
  );
  let searched: Awaited<ReturnType<ExternalContextBridge["call"]>>;
  try {
    searched = await bridge.call(
      "ctx_search",
      {
        queries: batch.queries,
        ...(batch.queryScope === "batch" ? { source } : {}),
      },
      signal,
      (text) => publish(onUpdate, text, searchDetails),
    );
  } finally {
    clearInterval(searchTicker);
  }
  const searchText = bridgeText(searched);
  if (searched.isError) throw new Error(searchText || "ctx_search failed for batch output.");

  const details: ContextDetails = {
    ...searchDetails,
    status: "success",
    elapsedMs: Date.now() - startedAt,
  };
  publish(
    onUpdate,
    `Completed ${completed}/${batch.commands.length} commands and searched ${batch.queries.length} queries.`,
    details,
  );
  const commandInventory = batch.commands
    .map(
      (command) =>
        `- ${command.label}: $ ${command.command.replace(/\s+/gu, " ").trim().slice(0, 500)}`,
    )
    .join("\n");
  return textResult(
    [
      `Executed ${completed} commands. Indexed ${Buffer.byteLength(bounded.content)} bytes as ${source}.`,
      "",
      "## Commands",
      commandInventory,
      bounded.truncated
        ? `Batch output was capped at ${MAX_BATCH_INDEX_BYTES} bytes before indexing.`
        : "",
      "",
      searchText,
    ]
      .filter(Boolean)
      .join("\n"),
    details,
  );
}

function existingContextToolNames(pi: ExtensionAPI): string[] {
  try {
    return pi
      .getAllTools()
      .map((tool) => tool.name)
      .filter((name) => name.startsWith("ctx_"));
  } catch {
    return [];
  }
}

export default function contextModeExtension(pi: ExtensionAPI): void {
  const existing = existingContextToolNames(pi);
  if (existing.length > 0) {
    const logger = (pi as unknown as { logger?: { warn?: (message: string) => void } }).logger;
    logger?.warn?.(
      `Context Mode replacement is inactive because another extension already registered: ${existing.join(", ")}. Disable the upstream Context Mode Pi extension and reload.`,
    );
    return;
  }

  registerContextLifecycle(pi);

  const runner = new NativeContextRunner();
  let bridge: ExternalContextBridge | undefined;
  const register = (tool: {
    name: string;
    label: string;
    description: string;
    parameters: object;
    file?: boolean;
  }): void => {
    const { file: _file, ...registration } = tool;
    pi.registerTool({
      ...registration,
      renderCall: createContextCallRenderer(tool.name) as never,
      renderResult: createContextResultRenderer(tool.name),
      async execute(_id, params: ContextToolParams, signal, onUpdate, ctx) {
        if (tool.name === "ctx_batch_execute") {
          if (!bridge)
            throw new Error(
              "ctx_batch_execute requires the pinned external Context Mode runtime for indexing and search.",
            );
          return nativeBatchExecution(runner, bridge, params, signal, onUpdate as never, ctx.cwd);
        }
        const request = normalizeExecution(params);
        if (tool.file) {
          if (typeof params.path !== "string" || !params.path.trim())
            throw new Error("path must be a non-empty string.");
          await enforceExecutionPolicy({
            projectRoot: ctx.cwd,
            language: request.language,
            code: request.code,
            path: params.path,
          });
          return nativeExecution(
            runner,
            { ...request, path: params.path },
            signal,
            onUpdate as never,
            ctx.cwd,
            bridge,
            true,
          );
        }
        await enforceExecutionPolicy({
          projectRoot: ctx.cwd,
          language: request.language,
          code: request.code,
        });
        return nativeExecution(runner, request, signal, onUpdate as never, ctx.cwd, bridge);
      },
    });
  };

  if (process.env.PI_SUBAGENT_CONTEXT_EXECUTION !== "0") {
    register({
      name: "ctx_execute",
      label: "Context Execute",
      description:
        "Run code in a Pi-owned, abort-aware subprocess with bounded output, project-bound cwd, process-tree cleanup, and temporary-file cleanup.",
      parameters: executionSchema,
    });
    register({
      name: "ctx_execute_file",
      label: "Context Execute File",
      description:
        "Read a project-contained file into FILE_CONTENT and run code over it in a Pi-owned, abort-aware subprocess.",
      parameters: fileSchema,
      file: true,
    });
    register({
      name: "ctx_batch_execute",
      label: "Context Batch Execute",
      description:
        "Run multiple shell commands with bounded concurrency and hard cancellation, index their combined output, then return matching indexed sections.",
      parameters: batchSchema,
    });
  }

  pi.on("session_start", async (_event, ctx) => {
    // Child explorers keep the read-only allowlist. Workers explicitly opt into native execution.
    if (process.env.PI_SUBAGENT_CONTEXT_EXECUTION === "0") {
      // Pi's --tools allowlist remains the authoritative visibility gate for child processes.
    }
    bridge = new ExternalContextBridge(ctx.cwd, ctx);
    try {
      const tools = await bridge.start();
      const allowed = new Set<string>(BRIDGED_TOOLS);
      for (const tool of tools) {
        if (!allowed.has(tool.name) || tool.name === "ctx_execute") continue;
        pi.registerTool({
          name: tool.name,
          label: tool.name,
          description:
            BRIDGE_TOOL_DESCRIPTIONS[tool.name] ?? "Run a bounded indexed Context Mode operation.",
          parameters: compactBridgeSchema(tool.inputSchema ?? { type: "object", properties: {} }),
          renderCall: createContextCallRenderer(tool.name) as never,
          renderResult: createContextResultRenderer(tool.name),
          async execute(_id, params, signal, onUpdate) {
            const startedAt = Date.now();
            const details: ContextDetails = {
              status: "running",
              backend: "external-bridge",
              cancellation: "best-effort-external",
              toolName: tool.name,
              phase:
                tool.name === "ctx_index" || tool.name === "ctx_fetch_and_index"
                  ? "index"
                  : "search",
              elapsedMs: 0,
            };
            publish(onUpdate as never, `Starting ${tool.name}…`, details);
            const ticker = startProgressTicker(
              onUpdate as never,
              startedAt,
              (elapsedMs) =>
                `${tool.name} · ${details.phase ?? "running"} · ${formatElapsed(elapsedMs)}`,
              details,
            );
            try {
              const result = await bridge!.call(
                tool.name as BridgedToolName,
                (params ?? {}) as object,
                signal,
                (text, nextDetails) =>
                  publish(onUpdate as never, text, {
                    ...details,
                    ...nextDetails,
                    status: "running",
                  }),
              );
              const text = bridgeText(result);
              if (result.isError) throw new Error(text || `${tool.name} failed`);
              const completed: ContextDetails = {
                ...details,
                status: "success",
                outputBytes: Buffer.byteLength(text),
                elapsedMs: Date.now() - startedAt,
              };
              publish(onUpdate as never, `${tool.name} finished.`, completed);
              return textResult(text, completed);
            } catch (error) {
              if (error instanceof Error && error.name === "AbortError")
                publish(
                  onUpdate as never,
                  "Cancellation requested; external work may still finish.",
                  {
                    ...details,
                    status: "cancelled",
                  },
                );
              throw error;
            } finally {
              clearInterval(ticker);
            }
          },
        });
      }
    } catch (error) {
      // Keep diagnostics in Pi's rotating log; unavailable optional tools must not create chat
      // messages, footer state, or a separate progress surface.
      const logger = (
        pi as unknown as {
          logger?: { warn?: (message: string, context?: Record<string, unknown>) => void };
        }
      ).logger;
      logger?.warn?.(
        `Context Mode external bridge unavailable: ${error instanceof Error ? error.message : String(error)}`,
        { cwd: ctx.cwd },
      );
      // Availability is represented by absent indexed tools. Native execution remains usable.
      bridge.shutdown();
      bridge = undefined;
    }
  });
  pi.on("session_shutdown", () => {
    runner.cleanup();
    bridge?.shutdown();
    bridge = undefined;
  });
}
