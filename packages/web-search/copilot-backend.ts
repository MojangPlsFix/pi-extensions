import { spawn } from "node:child_process";
import {
  boundedCopilotOutput,
  cleanSingleLine,
  DEFAULT_COPILOT_SEARCH_EFFORT,
  DEFAULT_COPILOT_SEARCH_MODEL,
  maximumOutputCharacters,
  normalizeSearchParams,
  promptFor,
  type SearchMode,
  type SearchParams,
} from "./search.js";

export const DEFAULT_COPILOT_SEARCH_TIMEOUT_MS = 180_000;
const COPILOT_SEARCH_KILL_GRACE_MS = 5_000;
const MAX_NODE_TIMEOUT_MS = 2_147_483_647;

type JsonRecord = Record<string, unknown>;
type CopilotEventState = {
  latestAssistantContent: string;
  webSearchStarted: boolean;
  webSearchCompleted: boolean;
  webSearchFailed: boolean;
  activeToolNames: Map<string, string>;
};

/** Resolve the bounded per-search timeout without exposing environment contents in errors. */
export function copilotSearchTimeoutMs(environment: NodeJS.ProcessEnv = process.env): number {
  const configured = environment.PI_COPILOT_SEARCH_TIMEOUT_MS?.trim();
  if (!configured || !/^\d+$/.test(configured)) return DEFAULT_COPILOT_SEARCH_TIMEOUT_MS;
  const timeout = Number(configured);
  if (!Number.isSafeInteger(timeout) || timeout <= 0) return DEFAULT_COPILOT_SEARCH_TIMEOUT_MS;
  return Math.min(timeout, MAX_NODE_TIMEOUT_MS);
}

/** Builds shell-free retrieval arguments, including the intentionally cheap default backend. */
export function buildCopilotArguments(mode: SearchMode, params: SearchParams): string[] {
  const normalized = normalizeSearchParams({ ...params, kind: mode });
  const model = normalized.model ?? DEFAULT_COPILOT_SEARCH_MODEL;
  const effort = normalized.reasoningEffort ?? DEFAULT_COPILOT_SEARCH_EFFORT;
  return [
    "-p",
    promptFor(normalized),
    "--no-ask-user",
    "--no-custom-instructions",
    "--stream",
    "off",
    "--model",
    model,
    "--effort",
    effort,
    "--output-format",
    "json",
  ];
}

function asRecord(value: unknown): JsonRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}

function firstNonEmptyString(values: unknown[]): string | undefined {
  return values
    .find((value): value is string => typeof value === "string" && value.trim() !== "")
    ?.trim();
}

function parseJsonLine(line: string): JsonRecord | undefined {
  try {
    return asRecord(JSON.parse(line));
  } catch {
    return undefined;
  }
}

function assistantAnswer(output: string): string {
  const messages: string[] = [];
  for (const line of output.split("\n")) {
    const event = parseJsonLine(line);
    const data = asRecord(event?.data);
    if (event?.type === "assistant.message" && typeof data?.content === "string")
      messages.push(data.content);
  }
  return messages.at(-1)?.trim() || output.trim();
}

function toolNameFromEvent(event: JsonRecord): string | undefined {
  const data = asRecord(event.data);
  const tool = asRecord(data?.tool);
  const toolCall = asRecord(data?.toolCall) ?? asRecord(data?.tool_call);
  const result = asRecord(data?.result);
  return firstNonEmptyString([
    // These are the Copilot CLI's current MCP/tool event fields.
    data?.mcpToolName,
    data?.toolName,
    data?.name,
    tool?.name,
    toolCall?.name,
    // Keep completion events useful when the tool name is nested in a result.
    result?.mcpToolName,
    result?.toolName,
    result?.name,
    event.mcpToolName,
    event.toolName,
    event.name,
  ]);
}

function toolCallIdFromEvent(event: JsonRecord): string | undefined {
  const data = asRecord(event.data);
  const toolCall = asRecord(data?.toolCall) ?? asRecord(data?.tool_call);
  const tool = asRecord(data?.tool);
  return firstNonEmptyString([
    data?.toolCallId,
    data?.tool_call_id,
    data?.id,
    toolCall?.toolCallId,
    toolCall?.tool_call_id,
    toolCall?.id,
    tool?.toolCallId,
    tool?.tool_call_id,
    tool?.id,
    event.toolCallId,
    event.tool_call_id,
    event.id,
  ]);
}

function isWebSearchTool(name: string | undefined): boolean {
  return typeof name === "string" && /(?:^|[-_:/])web_search$/i.test(name.trim());
}

function toolExecutionFailed(data: unknown): boolean {
  const record = asRecord(data);
  if (!record) return false;
  if (record.success === false) return true;
  if (
    typeof record.status === "string" &&
    ["failed", "error", "failure"].includes(record.status.toLowerCase())
  )
    return true;
  if (record.error) return true;
  const result = asRecord(record.result);
  return Boolean(
    result &&
      (result.isError === true ||
        result.error ||
        (typeof result.status === "string" &&
          ["failed", "error", "failure"].includes(result.status.toLowerCase()))),
  );
}

function displayToolName(name: string | undefined): string {
  const safeName = name ? cleanSingleLine(name, 120) : "";
  return safeName || "a web tool";
}

function handleCopilotEvent(
  event: JsonRecord,
  state: CopilotEventState,
  model: string,
  onStatus?: (value: string) => void,
): void {
  const type = typeof event.type === "string" ? event.type.toLowerCase() : "";
  const data = asRecord(event.data);
  const toolName = toolNameFromEvent(event);
  const toolCallId = toolCallIdFromEvent(event);
  const correlatedToolName =
    toolName ?? (toolCallId ? state.activeToolNames.get(toolCallId) : undefined);

  if (type === "assistant.turn_start") {
    onStatus?.(`Copilot started · ${model}`);
    return;
  }

  if (type === "assistant.message") {
    if (typeof data?.content === "string" && data.content.trim())
      state.latestAssistantContent = data.content.slice(0, maximumOutputCharacters * 2).trim();
    return;
  }

  if (!type.includes("tool")) return;

  const isStart =
    type === "tool.execution_start" || /tool.*(?:start|started|begin|began)/.test(type);
  const isComplete =
    type === "tool.execution_complete" ||
    /tool.*(?:complete|completed|finish|finished|end|result|error|failed|failure)/.test(type);

  if (isStart) {
    if (toolCallId && toolName) state.activeToolNames.set(toolCallId, toolName);
    if (isWebSearchTool(toolName)) {
      state.webSearchStarted = true;
      state.webSearchFailed ||= toolExecutionFailed(data);
    }
    onStatus?.(`Copilot is using ${displayToolName(toolName)}…`);
    return;
  }

  if (isComplete) {
    if (isWebSearchTool(correlatedToolName)) {
      // A completion event with a name is still a usable invocation when a
      // provider omits its separate execution_start event.
      state.webSearchStarted = true;
      state.webSearchCompleted = true;
      state.webSearchFailed ||= toolExecutionFailed(data);
    }
    if (toolCallId) state.activeToolNames.delete(toolCallId);
    onStatus?.(`Copilot finished ${displayToolName(correlatedToolName)}`);
    return;
  }

  // Some CLI versions emit a generic tool event rather than the explicit
  // execution_start/complete pair. Remember its name and count it as started;
  // a later completion can recover the name by toolCallId.
  if (toolCallId && toolName) state.activeToolNames.set(toolCallId, toolName);
  if (isWebSearchTool(toolName)) {
    state.webSearchStarted = true;
    state.webSearchFailed ||= toolExecutionFailed(data);
  }
}

function safeSpawnError(error: unknown): Error {
  const code = asRecord(error)?.code;
  if (code === "ENOENT")
    return new Error(
      "Copilot CLI search is unavailable because the `copilot` executable was not found. Install and authenticate the Copilot CLI, then run `copilot login`.",
    );
  if (code === "EACCES")
    return new Error(
      "Copilot CLI search could not start because the `copilot` executable is not runnable. Install and authenticate the Copilot CLI, then run `copilot login`.",
    );
  return new Error(
    "Copilot CLI search could not start. Install and authenticate the Copilot CLI, then run `copilot login`.",
  );
}

function abortError(): DOMException {
  return new DOMException("Aborted", "AbortError");
}

export function copilotSpawnOptions(
  signal?: AbortSignal,
  cwd = process.cwd(),
): {
  cwd: string;
  stdio: ["ignore", "pipe", "pipe"];
  shell: false;
  signal: AbortSignal | undefined;
  windowsHide: boolean;
} {
  return {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
    signal,
    windowsHide: true,
  };
}

export async function runCopilotSearch(
  mode: SearchMode,
  params: SearchParams,
  signal?: AbortSignal,
  executable = "copilot",
  onStatus?: (value: string) => void,
  cwd = process.cwd(),
): Promise<string> {
  const normalized = normalizeSearchParams({ ...params, kind: mode });
  const args = buildCopilotArguments(mode, normalized);
  const model = normalized.model ?? DEFAULT_COPILOT_SEARCH_MODEL;
  if (signal?.aborted) throw abortError();
  onStatus?.("Searching with Copilot CLI…");

  let child: ReturnType<typeof spawn>;
  try {
    // Do not probe with `copilot --version`: the real search spawn is both
    // cheaper and the only reliable way to report an executable failure.
    child = spawn(executable, args, { ...copilotSpawnOptions(signal, cwd) });
  } catch (error) {
    throw safeSpawnError(error);
  }

  let stdout = "";
  let stdoutRemainder = "";
  const state: CopilotEventState = {
    latestAssistantContent: "",
    webSearchStarted: false,
    webSearchCompleted: false,
    webSearchFailed: false,
    activeToolNames: new Map(),
  };
  const handleLine = (line: string) => {
    const event = parseJsonLine(line);
    if (event) handleCopilotEvent(event, state, model, onStatus);
  };

  const stdoutStream = child.stdout;
  const stderrStream = child.stderr;
  if (!stdoutStream || !stderrStream) {
    child.kill("SIGTERM");
    throw new Error("Copilot CLI search could not start with piped output.");
  }
  stdoutStream.setEncoding("utf8");
  stderrStream.setEncoding("utf8");
  stdoutStream.on("data", (chunk: string) => {
    stdout = (stdout + chunk).slice(-maximumOutputCharacters * 2);
    stdoutRemainder = (stdoutRemainder + chunk).slice(-maximumOutputCharacters * 2);
    let newlineIndex = stdoutRemainder.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = stdoutRemainder.slice(0, newlineIndex).trim();
      stdoutRemainder = stdoutRemainder.slice(newlineIndex + 1);
      if (line) handleLine(line);
      newlineIndex = stdoutRemainder.indexOf("\n");
    }
  });
  // Consume stderr to avoid filling the pipe, but never expose backend stderr.
  stderrStream.on("data", () => undefined);

  let timedOut = false;
  let childClosed = false;
  let timeoutHandle: NodeJS.Timeout | undefined;
  let killHandle: NodeJS.Timeout | undefined;
  const timeoutMs = copilotSearchTimeoutMs();

  try {
    let exitCode: number | null;
    try {
      exitCode = await new Promise<number | null>((resolve, reject) => {
        let settled = false;
        child.once("error", (error) => {
          if (!timedOut && !settled) {
            settled = true;
            reject(error);
          }
        });
        child.once("close", (code) => {
          childClosed = true;
          if (!settled) {
            settled = true;
            resolve(code);
          }
        });
        timeoutHandle = setTimeout(() => {
          if (childClosed) return;
          timedOut = true;
          onStatus?.(`Copilot search timed out after ${timeoutMs}ms; stopping…`);
          child.kill("SIGTERM");
          killHandle = setTimeout(() => {
            if (!childClosed) child.kill("SIGKILL");
          }, COPILOT_SEARCH_KILL_GRACE_MS);
          killHandle.unref?.();
        }, timeoutMs);
        timeoutHandle.unref?.();
      });
    } catch (error) {
      if (signal?.aborted) throw abortError();
      throw safeSpawnError(error);
    }

    // A final JSONL record may not have a trailing newline.
    const finalLine = stdoutRemainder.trim();
    if (finalLine) handleLine(finalLine);

    if (timedOut) {
      throw new Error(
        `Copilot CLI search timed out after ${timeoutMs}ms. Increase PI_COPILOT_SEARCH_TIMEOUT_MS or retry later.`,
      );
    }
    if (exitCode !== 0)
      throw new Error(
        `Copilot CLI search failed (exit code ${exitCode ?? "unknown"}). Confirm the configured model and run \`copilot login\`.`,
      );

    if (mode === "web") {
      if (!state.webSearchStarted)
        throw new Error(
          "Copilot completed without invoking github-mcp-server/web_search; refusing to return an unverified answer.",
        );
      if (!state.webSearchCompleted || state.webSearchFailed)
        throw new Error(
          "github-mcp-server/web_search failed; refusing to return an unverified answer.",
        );
    }

    const answer = state.latestAssistantContent || assistantAnswer(stdout);
    if (!answer) throw new Error("Copilot CLI search completed without an answer.");
    return boundedCopilotOutput(answer);
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    if (killHandle) clearTimeout(killHandle);
    if (!childClosed) {
      try {
        child.kill("SIGTERM");
      } catch {
        /* The child may already have disappeared after an error. */
      }
    }
  }
}
