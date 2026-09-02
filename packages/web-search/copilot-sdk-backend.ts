import { randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { BlockList, isIP } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CopilotClient,
  type PermissionHandler,
  type PermissionRequest,
  type PermissionRequestResult,
  RuntimeConnection,
  type SessionConfig,
} from "@github/copilot-sdk";
import { copilotSearchTimeoutMs } from "./copilot-backend.js";
import {
  type BackendSearchResult,
  boundedText,
  DEFAULT_COPILOT_SEARCH_MODEL,
  formatSources,
  maximumOutputCharacters,
  maximumSources,
  normalizeCodexSources,
  normalizeSearchParams,
  promptFor,
  type SearchParams,
  type SearchSource,
  sourcesFromText,
} from "./search.js";

export const COPILOT_SDK_SESSION_CLEANUP_GRACE_MS = 5_000;
export const COPILOT_SDK_SHUTDOWN_GRACE_MS = 5_000;
export const COPILOT_SDK_RUNTIME_LAUNCHER_PATH = fileURLToPath(
  new URL("./copilot-sdk-runtime-launcher.js", import.meta.url),
);
const MAXIMUM_SDK_WAIT_MS = 2_147_483_647;
const maximumCollectedText = maximumOutputCharacters * 4;
const webSearchNames = new Set([
  "web_search",
  "github-mcp-server-web_search",
  "github-mcp-server/web_search",
]);
const webFetchNames = new Set([
  "web_fetch",
  "github-mcp-server-web_fetch",
  "github-mcp-server/web_fetch",
]);

type JsonRecord = Record<string, unknown>;
type SdkEvent = { type?: unknown; data?: unknown } & JsonRecord;
type ToolMetadata = {
  name?: unknown;
  namespacedName?: unknown;
  mcpServerName?: unknown;
  mcpToolName?: unknown;
};
export type CopilotSdkSessionAdapter = {
  readonly sessionId: string;
  readonly rpc?: {
    readonly tools?: {
      initializeAndValidate?(): Promise<unknown>;
      getCurrentMetadata(): Promise<unknown>;
    };
  };
  on(handler: (event: SdkEvent) => void): () => void;
  sendAndWait(options: { prompt: string }, timeout?: number): Promise<unknown>;
  abort(): Promise<void>;
  disconnect(): Promise<void>;
};
export type CopilotSdkClientAdapter = {
  start(): Promise<void>;
  stop(): Promise<unknown>;
  forceStop(): Promise<void>;
  createSession(config: SessionConfig): Promise<CopilotSdkSessionAdapter>;
  deleteSession(sessionId: string): Promise<void>;
  getStatus?(): Promise<unknown>;
};
export type CopilotSdkClientFactory = (options: {
  baseDirectory: string;
  workingDirectory: string;
  environment: NodeJS.ProcessEnv;
}) => CopilotSdkClientAdapter;

export type CopilotRuntimeFileSystem = {
  createRuntimeDirectory(): Promise<string>;
  createSessionDirectory(baseDirectory: string): Promise<string>;
  createDirectory(path: string): Promise<void>;
  removeDirectory(path: string): Promise<void>;
};
export type CopilotSdkHostResolver = (hostname: string) => Promise<readonly string[]>;
export type CopilotSearchRuntimeOptions = {
  createClient?: CopilotSdkClientFactory;
  fileSystem?: CopilotRuntimeFileSystem;
  environment?: () => NodeJS.ProcessEnv;
  hostResolver?: CopilotSdkHostResolver;
  sessionCleanupGraceMs?: number;
  shutdownGraceMs?: number;
};
type InFlightSearch = {
  controller: AbortController;
  done: Promise<void>;
  finish(): void;
  removeCallerAbort(): void;
};
type ActiveSession = {
  client: CopilotSdkClientAdapter;
  session: CopilotSdkSessionAdapter;
  directory: string;
  cleanup?: Promise<Error[]>;
};
type SdkEventState = {
  answer: string;
  actualModel?: string;
  actualReasoningEffort?: string;
  activeTools: Map<string, string>;
  successfulSearchCalls: Set<string>;
  citableSources: unknown[];
  structuredOutputs: unknown[];
  toolResultText: string[];
  permissionCallIds: Set<string>;
};
type DeadlineResult<T> =
  | { status: "completed"; value: T }
  | { status: "failed"; error: unknown }
  | { status: "timed-out" };

class SafeSdkSearchError extends Error {}
class SdkConnectionError extends SafeSdkSearchError {}

function asRecord(value: unknown): JsonRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}

function firstString(values: unknown[]): string | undefined {
  return values.find(
    (value): value is string => typeof value === "string" && value.trim().length > 0,
  );
}

function boundedCollectedText(value: string): string {
  return value.slice(0, maximumCollectedText);
}

function abortError(signal?: AbortSignal): DOMException {
  const reason = signal?.reason;
  return reason instanceof DOMException && reason.name === "AbortError"
    ? reason
    : new DOMException("Aborted", "AbortError");
}

function isAbortError(error: unknown, signal?: AbortSignal): boolean {
  return (
    signal?.aborted === true ||
    (error instanceof Error && error.name === "AbortError") ||
    (error instanceof DOMException && error.name === "AbortError")
  );
}

function canonicalToolName(value: unknown): "web_search" | "web_fetch" | undefined {
  if (typeof value !== "string") return undefined;
  const name = value.trim().toLowerCase();
  if (webSearchNames.has(name)) return "web_search";
  if (webFetchNames.has(name)) return "web_fetch";
  return undefined;
}

export function isCopilotWebSearchTool(value: unknown): boolean {
  return canonicalToolName(value) === "web_search";
}

function toolNameFrom(value: unknown): string | undefined {
  const record = asRecord(value);
  const data = asRecord(record?.data) ?? record;
  const result = asRecord(data?.result);
  const tool = asRecord(data?.tool);
  const toolCall = asRecord(data?.toolCall) ?? asRecord(data?.tool_call);
  return firstString([
    data?.mcpToolName,
    data?.toolName,
    data?.name,
    tool?.name,
    toolCall?.name,
    result?.mcpToolName,
    result?.toolName,
    record?.mcpToolName,
    record?.toolName,
  ]);
}

function toolCallIdFrom(value: unknown): string | undefined {
  const record = asRecord(value);
  const data = asRecord(record?.data) ?? record;
  const toolCall = asRecord(data?.toolCall) ?? asRecord(data?.tool_call);
  return firstString([
    data?.toolCallId,
    data?.tool_call_id,
    toolCall?.toolCallId,
    toolCall?.tool_call_id,
    toolCall?.id,
    record?.toolCallId,
    record?.tool_call_id,
  ]);
}

function safeObservedOption(values: unknown[]): string | undefined {
  const value = firstString(values)?.trim();
  return value && /^[A-Za-z0-9._:-]{1,120}$/.test(value) ? value : undefined;
}

function eventModel(data: JsonRecord | undefined): string | undefined {
  return safeObservedOption([data?.selectedModel, data?.newModel, data?.model]);
}

function eventReasoningEffort(data: JsonRecord | undefined): string | undefined {
  return safeObservedOption([data?.reasoningEffort]);
}

function appendToolResult(state: SdkEventState, result: JsonRecord | undefined): void {
  if (!result) return;
  if (result.citableSources !== undefined && state.citableSources.length < 100)
    state.citableSources.push(result.citableSources);
  if (result.structuredContent !== undefined && state.structuredOutputs.length < 100)
    state.structuredOutputs.push(result.structuredContent);
  const content = firstString([result.content, result.detailedContent]);
  if (content && state.toolResultText.length < 100)
    state.toolResultText.push(boundedCollectedText(content));
  if (!Array.isArray(result.contents)) return;
  for (const item of result.contents.slice(0, 100)) {
    const record = asRecord(item);
    if (!record) continue;
    if (state.structuredOutputs.length < 100) state.structuredOutputs.push(record);
    const text = firstString([record.text, asRecord(record.resource)?.text]);
    if (text && state.toolResultText.length < 100)
      state.toolResultText.push(boundedCollectedText(text));
  }
}

function handleSdkEvent(
  event: SdkEvent,
  state: SdkEventState,
  onStatus?: (value: string) => void,
): boolean {
  const type = typeof event.type === "string" ? event.type.toLowerCase() : "";
  const data = asRecord(event.data);
  const model = eventModel(data);
  const effort = eventReasoningEffort(data);
  if (model) state.actualModel = model;
  if (effort) state.actualReasoningEffort = effort;

  if (type === "session.start" || type === "session.resume" || type === "session.model_change") {
    if (model) onStatus?.(`Copilot SDK started · ${model}`);
    return true;
  }

  if (type === "assistant.turn_start") {
    onStatus?.(
      `Copilot SDK started · ${model ?? state.actualModel ?? DEFAULT_COPILOT_SEARCH_MODEL}`,
    );
    return true;
  }

  if (type === "assistant.message") {
    const content = firstString([data?.content]);
    if (content) state.answer = boundedCollectedText(content.trim());
    const citations = asRecord(data?.citations);
    if (citations?.sources !== undefined && state.citableSources.length < 100)
      state.citableSources.push(citations.sources);
    return true;
  }

  if (
    type === "assistant.message_delta" ||
    type === "assistant.streaming_delta" ||
    type === "assistant.server_tool_progress"
  )
    return true;
  if (!type.startsWith("tool.execution_")) return type === "permission.requested";

  const directName = toolNameFrom(event);
  const callId = toolCallIdFrom(event);
  const correlatedName = directName ?? (callId ? state.activeTools.get(callId) : undefined);
  const canonical = canonicalToolName(correlatedName);

  if (type === "tool.execution_start") {
    if (callId && directName) state.activeTools.set(callId, directName);
    if (callId && canonical) state.permissionCallIds.add(callId);
    onStatus?.(`Copilot SDK is using ${canonical ?? "a retrieval tool"}…`);
    return true;
  }

  if (type === "tool.execution_complete") {
    const success = data?.success === true;
    if (canonical && callId && success) appendToolResult(state, asRecord(data?.result));
    if (canonical === "web_search" && callId && success) state.successfulSearchCalls.add(callId);
    if (callId) {
      state.activeTools.delete(callId);
      state.permissionCallIds.delete(callId);
    }
    onStatus?.(
      success
        ? `Copilot SDK finished ${canonical ?? "a retrieval tool"}`
        : `Copilot SDK failed ${canonical ?? "a retrieval tool"}`,
    );
    return true;
  }

  return true;
}

function metadataList(value: unknown): ToolMetadata[] {
  if (Array.isArray(value))
    return value.filter((item): item is ToolMetadata => Boolean(asRecord(item)));
  const record = asRecord(value);
  for (const key of ["tools", "metadata", "items"]) {
    const items = record?.[key];
    if (Array.isArray(items))
      return items.filter((item): item is ToolMetadata => Boolean(asRecord(item)));
  }
  return [];
}

function metadataCanonicalName(metadata: ToolMetadata): "web_search" | "web_fetch" | undefined {
  return (
    canonicalToolName(metadata.mcpToolName) ??
    canonicalToolName(metadata.name) ??
    canonicalToolName(metadata.namespacedName)
  );
}

function metadataFilter(metadata: ToolMetadata): string | undefined {
  const name = firstString([metadata.name, metadata.namespacedName, metadata.mcpToolName]);
  if (!name) return undefined;
  return metadata.mcpToolName || metadata.mcpServerName ? `mcp:${name}` : `builtin:${name}`;
}

export function verifyCopilotSdkToolMetadata(
  value: unknown,
  includeContent: boolean,
): Map<"web_search" | "web_fetch", string> {
  const expected = new Set<"web_search" | "web_fetch">([
    "web_search",
    ...(includeContent ? (["web_fetch"] as const) : []),
  ]);
  const verified = new Map<"web_search" | "web_fetch", string>();
  const metadata = metadataList(value);
  for (const item of metadata) {
    const canonical = metadataCanonicalName(item);
    if (
      (item.mcpServerName || item.mcpToolName) &&
      (item.mcpServerName !== "github-mcp-server" || typeof item.mcpToolName !== "string")
    )
      throw new SafeSdkSearchError(
        "The bundled Copilot runtime reported an untrusted web tool server. Set PI_COPILOT_SEARCH_TRANSPORT=cli to use the legacy fallback.",
      );
    if (!canonical || !expected.has(canonical))
      throw new SafeSdkSearchError(
        "The bundled Copilot runtime did not isolate the requested web tools. Set PI_COPILOT_SEARCH_TRANSPORT=cli to use the legacy fallback.",
      );
    const filter = metadataFilter(item);
    if (!filter)
      throw new SafeSdkSearchError(
        "The bundled Copilot runtime did not report a usable web tool identity. Set PI_COPILOT_SEARCH_TRANSPORT=cli to use the legacy fallback.",
      );
    verified.set(canonical, filter);
  }
  for (const name of expected) {
    if (!verified.has(name))
      throw new SafeSdkSearchError(
        `The bundled Copilot runtime does not expose canonical ${name}. Set PI_COPILOT_SEARCH_TRANSPORT=cli to use the legacy fallback.`,
      );
  }
  if (verified.size !== metadata.length)
    throw new SafeSdkSearchError(
      "The bundled Copilot runtime reported duplicate web tool identities. Set PI_COPILOT_SEARCH_TRANSPORT=cli to use the legacy fallback.",
    );
  return verified;
}

const COPILOT_SDK_DNS_PERMISSION_TIMEOUT_MS = 2_000;
const blockedIpv4Addresses = new BlockList();
const blockedIpv6Addresses = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const)
  blockedIpv4Addresses.addSubnet(network, prefix, "ipv4");
for (const [network, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["::ffff:0.0.0.0", 96],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["fc00::", 7],
  ["fe80::", 10],
  ["fec0::", 10],
  ["ff00::", 8],
] as const)
  blockedIpv6Addresses.addSubnet(network, prefix, "ipv6");

function addressIsPrivate(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized.endsWith(".local")
  )
    return true;
  const version = isIP(normalized);
  if (version === 4) return blockedIpv4Addresses.check(normalized, "ipv4");
  if (version === 6) return blockedIpv6Addresses.check(normalized, "ipv6");
  return !normalized.includes(".");
}

async function defaultHostResolver(hostname: string): Promise<readonly string[]> {
  const addresses = await lookup(hostname, { all: true, verbatim: true });
  return addresses.map(({ address }) => address);
}

async function permissionUrlIsSafe(
  value: string,
  resolveHost: CopilotSdkHostResolver,
): Promise<boolean> {
  try {
    const url = new URL(value);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username ||
      url.password ||
      addressIsPrivate(url.hostname)
    )
      return false;
    const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (isIP(hostname)) return true;
    const resolution = await withinDeadline(
      Promise.resolve().then(() => resolveHost(hostname)),
      COPILOT_SDK_DNS_PERMISSION_TIMEOUT_MS,
    );
    return (
      resolution.status === "completed" &&
      resolution.value.length > 0 &&
      resolution.value.every((address) => isIP(address) !== 0 && !addressIsPrivate(address))
    );
  } catch {
    return false;
  }
}

export function copilotSdkPermissionHandler(
  includeContent: boolean,
  allowedUrlToolCallIds: ReadonlySet<string> = new Set(),
  isCapabilityVerified: () => boolean = () => true,
  resolveHost: CopilotSdkHostResolver = defaultHostResolver,
): PermissionHandler {
  const allowed = new Set(["web_search", ...(includeContent ? ["web_fetch"] : [])]);
  return async (request: PermissionRequest): Promise<PermissionRequestResult> => {
    if (!isCapabilityVerified())
      return { kind: "reject", feedback: "Search has not verified its retrieval tools." };
    if (request.managedApprovalRequired)
      return { kind: "reject", feedback: "Search cannot approve managed permission requests." };
    if (request.kind === "mcp") {
      const name = canonicalToolName(request.toolName);
      if (
        request.serverName === "github-mcp-server" &&
        request.readOnly &&
        name &&
        allowed.has(name)
      )
        return { kind: "approve-once" };
    }
    // Approval never bypasses the runtime sandbox. Its connection-time network policy remains
    // the final defense against a hostname that changes after this DNS preflight.
    if (
      request.kind === "url" &&
      request.toolCallId &&
      allowedUrlToolCallIds.has(request.toolCallId) &&
      !request.requestSandboxBypass &&
      (await permissionUrlIsSafe(request.url, resolveHost)) &&
      (!request.redirectedFrom || (await permissionUrlIsSafe(request.redirectedFrom, resolveHost)))
    )
      return { kind: "approve-once" };
    return { kind: "reject", feedback: "Search permits only read-only web retrieval." };
  };
}

export function buildCopilotSdkSessionConfig(
  params: SearchParams,
  sessionDirectory: string,
  availableTools: string[],
  permissionCallIds: ReadonlySet<string> = new Set(),
  onEvent?: NonNullable<SessionConfig["onEvent"]>,
  isCapabilityVerified: () => boolean = () => true,
  resolveHost: CopilotSdkHostResolver = defaultHostResolver,
): SessionConfig {
  const normalized = normalizeSearchParams(params);
  return {
    sessionId: randomUUID(),
    model: DEFAULT_COPILOT_SEARCH_MODEL,
    workingDirectory: sessionDirectory,
    configDirectory: join(sessionDirectory, "config"),
    enableConfigDiscovery: false,
    skipCustomInstructions: true,
    instructionDirectories: [],
    enableOnDemandInstructionDiscovery: false,
    enableSkills: false,
    skillDirectories: [],
    disabledSkills: [],
    memory: { enabled: false },
    enableSessionStore: false,
    skipEmbeddingRetrieval: true,
    embeddingCacheStorage: "in-memory",
    infiniteSessions: { enabled: false },
    enableFileHooks: false,
    enableHostGitOperations: false,
    mcpOAuthTokenStorage: "in-memory",
    toolSearch: { enabled: false },
    enableCitations: true,
    systemMessage: {
      mode: "customize",
      content:
        "Retrieve external evidence only. Use canonical web_search before factual output. Use web_fetch only when it is available. Return safe source URLs.",
      sections: {
        environment_context: { action: "remove" },
        custom_instructions: { action: "remove" },
      },
    },
    availableTools,
    onPermissionRequest: copilotSdkPermissionHandler(
      Boolean(normalized.includeContent),
      permissionCallIds,
      isCapabilityVerified,
      resolveHost,
    ),
    ...(onEvent ? { onEvent } : {}),
  };
}

function defaultFileSystem(): CopilotRuntimeFileSystem {
  return {
    createRuntimeDirectory: () => mkdtemp(join(tmpdir(), "pi-copilot-search-")),
    createSessionDirectory: (baseDirectory) => mkdtemp(join(baseDirectory, "query-")),
    createDirectory: async (path) => {
      await mkdir(path, { recursive: true, mode: 0o700 });
    },
    removeDirectory: async (path) => {
      await rm(path, { recursive: true, force: true });
    },
  };
}

const blockedRuntimeEnvironmentVariables = [
  "COPILOT_CLI_PATH",
  "COPILOT_CLI_URL",
  "COPILOT_SDK_CONNECTION",
  "NODE_OPTIONS",
  "NODE_PATH",
  "NODE_REPL_EXTERNAL_MODULE",
  "NODE_DEBUG",
  "NODE_DEBUG_NATIVE",
  "NODE_INSPECT_RESUME_ON_START",
  "NODE_V8_COVERAGE",
  "NODE_REDIRECT_WARNINGS",
  "NODE_CHANNEL_FD",
  "NODE_UNIQUE_ID",
  "LD_PRELOAD",
  "LD_AUDIT",
  "DYLD_INSERT_LIBRARIES",
  "DYLD_LIBRARY_PATH",
] as const;

export function copilotSdkRuntimeEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const isolated = { ...environment };
  for (const name of blockedRuntimeEnvironmentVariables) delete isolated[name];
  return isolated;
}

function defaultClientFactory(options: {
  baseDirectory: string;
  workingDirectory: string;
  environment: NodeJS.ProcessEnv;
}): CopilotSdkClientAdapter {
  return new CopilotClient({
    mode: "empty",
    connection: RuntimeConnection.forStdio({ path: COPILOT_SDK_RUNTIME_LAUNCHER_PATH }),
    workingDirectory: options.workingDirectory,
    baseDirectory: options.baseDirectory,
    env: copilotSdkRuntimeEnvironment(options.environment),
    useLoggedInUser: true,
    logLevel: "none",
  }) as unknown as CopilotSdkClientAdapter;
}

async function withinDeadline<T>(
  promise: Promise<T>,
  milliseconds: number,
): Promise<DeadlineResult<T>> {
  let timeout: NodeJS.Timeout | undefined;
  const timer = new Promise<DeadlineResult<T>>((resolve) => {
    timeout = setTimeout(() => resolve({ status: "timed-out" }), milliseconds);
    timeout.unref?.();
  });
  const operation: Promise<DeadlineResult<T>> = promise.then(
    (value) => ({ status: "completed", value }),
    (error) => ({ status: "failed", error }),
  );
  try {
    return await Promise.race([operation, timer]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function waitForStage<T>(
  promise: Promise<T>,
  signal: AbortSignal,
  timeoutMs: number,
  onTimeout: () => void,
): Promise<T> {
  if (signal.aborted) throw abortError(signal);
  let timeout: NodeJS.Timeout | undefined;
  let rejectAbort: ((error: DOMException) => void) | undefined;
  const abortFailure = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const timeoutFailure = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      onTimeout();
      reject(
        new SafeSdkSearchError(
          `Copilot SDK search timed out after ${timeoutMs}ms without activity before the prompt was sent.`,
        ),
      );
    }, timeoutMs);
    timeout.unref?.();
  });
  const onAbort = () => rejectAbort?.(abortError(signal));
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    return await Promise.race([promise, abortFailure, timeoutFailure]);
  } finally {
    if (timeout) clearTimeout(timeout);
    signal.removeEventListener("abort", onAbort);
  }
}

function connectionFailed(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /(?:client not connected|connection (?:closed|lost|failed)|broken pipe|econnreset|econnrefused|json-?rpc|transport.*(?:closed|failed))/i.test(
    error.message,
  );
}

function freshEventState(permissionCallIds: Set<string>): SdkEventState {
  return {
    answer: "",
    activeTools: new Map(),
    successfulSearchCalls: new Set(),
    citableSources: [],
    structuredOutputs: [],
    toolResultText: [],
    permissionCallIds,
  };
}

function combineSourceGroups(groups: Array<{ sources: SearchSource[]; truncated: boolean }>): {
  sources: SearchSource[];
  truncated: boolean;
} {
  const sources: SearchSource[] = [];
  const seen = new Set<string>();
  let truncated = groups.some((group) => group.truncated);
  for (const group of groups) {
    for (const source of group.sources) {
      if (seen.has(source.url)) continue;
      seen.add(source.url);
      if (sources.length < maximumSources) sources.push(source);
      else truncated = true;
    }
  }
  return { sources, truncated };
}

function resultFromState(state: SdkEventState): BackendSearchResult {
  if (state.successfulSearchCalls.size === 0)
    throw new SafeSdkSearchError(
      "Copilot SDK completed without a successful web_search call. No answer was returned.",
    );
  const answer = boundedText(state.answer, 8_000, 280);
  if (!answer.text) throw new SafeSdkSearchError("Copilot SDK search completed without an answer.");
  const sources = combineSourceGroups([
    normalizeCodexSources(state.citableSources),
    normalizeCodexSources(state.structuredOutputs),
    sourcesFromText(state.toolResultText.join("\n")),
    sourcesFromText(answer.text),
  ]);
  if (sources.sources.length === 0)
    throw new SafeSdkSearchError(
      "Copilot SDK search returned factual output without a safe source URL. No answer was returned.",
    );
  const sourceSection = formatSources(sources.sources, sources.truncated);
  const output = boundedText([answer.text, sourceSection.text].filter(Boolean).join("\n\n"));
  return {
    output: output.text,
    sources: sources.sources,
    resultCount: state.successfulSearchCalls.size,
    outputTruncated: answer.truncated || output.truncated,
    sourcesTruncated: sourceSection.truncated,
    ...(state.actualModel ? { model: state.actualModel } : {}),
    ...(state.actualReasoningEffort ? { reasoningEffort: state.actualReasoningEffort } : {}),
  };
}

export class CopilotSearchRuntime {
  private readonly createClient: CopilotSdkClientFactory;
  private readonly fileSystem: CopilotRuntimeFileSystem;
  private readonly environment: () => NodeJS.ProcessEnv;
  private readonly hostResolver: CopilotSdkHostResolver;
  private readonly sessionCleanupGraceMs: number;
  private readonly shutdownGraceMs: number;
  private readonly clients = new Map<CopilotSdkClientAdapter, string>();
  private readonly retiredClients = new Set<CopilotSdkClientAdapter>();
  private readonly stoppingClients = new Map<CopilotSdkClientAdapter, Promise<void>>();
  private readonly activeSessions = new Set<ActiveSession>();
  private readonly inFlightSearches = new Set<InFlightSearch>();
  private readonly pendingAdmissions = new Set<Promise<unknown>>();
  private readonly verifiedFilters = new Map<"web_search" | "web_fetch", string>();
  private client?: CopilotSdkClientAdapter;
  private startPromise?: Promise<CopilotSdkClientAdapter>;
  private shuttingDown = false;
  private shutdownPromise?: Promise<void>;

  constructor(options: CopilotSearchRuntimeOptions = {}) {
    this.createClient = options.createClient ?? defaultClientFactory;
    this.fileSystem = options.fileSystem ?? defaultFileSystem();
    this.environment = options.environment ?? (() => process.env);
    this.hostResolver = options.hostResolver ?? defaultHostResolver;
    this.sessionCleanupGraceMs =
      options.sessionCleanupGraceMs ?? COPILOT_SDK_SESSION_CLEANUP_GRACE_MS;
    this.shutdownGraceMs = options.shutdownGraceMs ?? COPILOT_SDK_SHUTDOWN_GRACE_MS;
  }

  private admitSearch(callerSignal?: AbortSignal): InFlightSearch {
    if (this.shuttingDown) throw new SafeSdkSearchError("Copilot SDK search is shutting down.");
    const controller = new AbortController();
    let finish: (() => void) | undefined;
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const onCallerAbort = () => controller.abort(callerSignal?.reason);
    callerSignal?.addEventListener("abort", onCallerAbort, { once: true });
    if (callerSignal?.aborted) onCallerAbort();
    const operation: InFlightSearch = {
      controller,
      done,
      finish: () => finish?.(),
      removeCallerAbort: () => callerSignal?.removeEventListener("abort", onCallerAbort),
    };
    this.inFlightSearches.add(operation);
    return operation;
  }

  private trackPending<T>(promise: Promise<T>): Promise<T> {
    this.pendingAdmissions.add(promise);
    void promise.then(
      () => this.pendingAdmissions.delete(promise),
      () => this.pendingAdmissions.delete(promise),
    );
    return promise;
  }

  private async removeDirectoryWithin(path: string, milliseconds: number): Promise<boolean> {
    const result = await withinDeadline(
      Promise.resolve().then(() => this.fileSystem.removeDirectory(path)),
      milliseconds,
    );
    return result.status === "completed";
  }

  private scheduleDirectoryCleanup(creation: Promise<string>, milliseconds: number): void {
    const cleanup = creation.then(
      (directory) => this.removeDirectoryWithin(directory, milliseconds),
      () => false,
    );
    this.trackPending(cleanup);
    void cleanup.catch(() => undefined);
  }

  private async initializeClient(): Promise<CopilotSdkClientAdapter> {
    const timeoutMs = copilotSearchTimeoutMs(this.environment());
    const directoryCreation = this.trackPending(
      Promise.resolve().then(() => this.fileSystem.createRuntimeDirectory()),
    );
    const created = await withinDeadline(directoryCreation, timeoutMs);
    if (created.status !== "completed") {
      if (created.status === "timed-out")
        this.scheduleDirectoryCleanup(directoryCreation, this.shutdownGraceMs);
      throw new SafeSdkSearchError(
        "Copilot SDK search could not create isolated runtime state before its startup deadline.",
      );
    }
    const directory = created.value;
    if (this.shuttingDown) {
      await this.removeDirectoryWithin(directory, this.shutdownGraceMs);
      throw new SafeSdkSearchError("Copilot SDK search is shutting down.");
    }
    let client: CopilotSdkClientAdapter | undefined;
    try {
      client = this.createClient({
        baseDirectory: directory,
        workingDirectory: directory,
        environment: this.environment(),
      });
      this.clients.set(client, directory);
      await client.start();
      if (client.getStatus) await client.getStatus();
      if (this.shuttingDown) throw new SafeSdkSearchError("Copilot SDK search is shutting down.");
      this.client = client;
      return client;
    } catch (error) {
      if (client) {
        await withinDeadline(
          Promise.resolve().then(() => client?.forceStop()),
          this.shutdownGraceMs,
        );
        this.clients.delete(client);
      }
      await this.removeDirectoryWithin(directory, this.shutdownGraceMs);
      if (error instanceof SafeSdkSearchError) throw error;
      throw new SafeSdkSearchError(
        "Copilot SDK search could not start its bundled runtime. Authenticate Copilot and try again, or set PI_COPILOT_SEARCH_TRANSPORT=cli for the legacy fallback.",
      );
    }
  }

  private ensureClient(): Promise<CopilotSdkClientAdapter> {
    if (this.shuttingDown)
      return Promise.reject(new SafeSdkSearchError("Copilot SDK search is shutting down."));
    if (this.client) return Promise.resolve(this.client);
    if (this.startPromise) return this.startPromise;
    const pending = this.initializeClient();
    this.startPromise = pending;
    void pending.then(
      () => {
        if (this.startPromise === pending) this.startPromise = undefined;
      },
      () => {
        if (this.startPromise === pending) this.startPromise = undefined;
      },
    );
    return pending;
  }

  private availableTools(includeContent: boolean): string[] {
    const search = this.verifiedFilters.get("web_search") ?? "web_search";
    if (!includeContent) return [search];
    return [search, this.verifiedFilters.get("web_fetch") ?? "web_fetch"];
  }

  private async verifySessionTools(
    session: CopilotSdkSessionAdapter,
    includeContent: boolean,
  ): Promise<void> {
    const tools = session.rpc?.tools;
    const getMetadata = tools?.getCurrentMetadata;
    if (!tools || !getMetadata)
      throw new SafeSdkSearchError(
        "The bundled Copilot runtime cannot report its web tool isolation. Set PI_COPILOT_SEARCH_TRANSPORT=cli to use the legacy fallback.",
      );
    let raw: unknown;
    try {
      if (tools.initializeAndValidate) await tools.initializeAndValidate();
      raw = await getMetadata.call(tools);
    } catch (error) {
      if (connectionFailed(error))
        throw new SdkConnectionError(
          "The bundled Copilot runtime connection closed during web tool verification. The prompt was not retried.",
        );
      throw new SafeSdkSearchError(
        "The bundled Copilot runtime could not verify its web tool isolation. Set PI_COPILOT_SEARCH_TRANSPORT=cli to use the legacy fallback.",
      );
    }
    const verified = verifyCopilotSdkToolMetadata(raw, includeContent);
    for (const [name, filter] of verified) this.verifiedFilters.set(name, filter);
  }

  private async cleanupActive(entry: ActiveSession, abort: boolean): Promise<Error[]> {
    if (entry.cleanup) return entry.cleanup;
    entry.cleanup = (async () => {
      const errors: Error[] = [];
      if (abort) {
        const result = await withinDeadline(
          Promise.resolve().then(() => entry.session.abort()),
          this.sessionCleanupGraceMs,
        );
        if (result.status !== "completed") errors.push(new Error("session abort failed"));
      }
      const disconnect = await withinDeadline(
        Promise.resolve().then(() => entry.session.disconnect()),
        this.sessionCleanupGraceMs,
      );
      if (disconnect.status !== "completed") errors.push(new Error("session disconnect failed"));
      const deletion = await withinDeadline(
        Promise.resolve().then(() => entry.client.deleteSession(entry.session.sessionId)),
        this.sessionCleanupGraceMs,
      );
      if (deletion.status !== "completed") errors.push(new Error("session deletion failed"));
      if (!(await this.removeDirectoryWithin(entry.directory, this.sessionCleanupGraceMs)))
        errors.push(new Error("session state cleanup failed"));
      this.activeSessions.delete(entry);
      if (this.retiredClients.has(entry.client)) await this.stopRetiredClient(entry.client);
      return errors;
    })();
    return entry.cleanup;
  }

  private stopClient(client: CopilotSdkClientAdapter): Promise<void> {
    const existing = this.stoppingClients.get(client);
    if (existing) return existing;
    const stopping = (async () => {
      const directory = this.clients.get(client);
      const stop = await withinDeadline(
        Promise.resolve().then(() => client.stop()),
        this.shutdownGraceMs,
      );
      const stopErrors =
        stop.status === "completed" && Array.isArray(stop.value) ? stop.value.length : 0;
      if (stop.status !== "completed" || stopErrors > 0)
        await withinDeadline(
          Promise.resolve().then(() => client.forceStop()),
          this.shutdownGraceMs,
        );
      this.clients.delete(client);
      this.retiredClients.delete(client);
      if (this.client === client) this.client = undefined;
      if (directory) await this.removeDirectoryWithin(directory, this.shutdownGraceMs);
    })();
    this.stoppingClients.set(client, stopping);
    void stopping.then(
      () => this.stoppingClients.delete(client),
      () => this.stoppingClients.delete(client),
    );
    return stopping;
  }

  private async stopRetiredClient(client: CopilotSdkClientAdapter): Promise<void> {
    if ([...this.activeSessions].some((entry) => entry.client === client)) return;
    await this.stopClient(client);
  }

  private retireClient(client: CopilotSdkClientAdapter): void {
    if (this.client === client) this.client = undefined;
    this.retiredClients.add(client);
  }

  private async createSessionState(
    client: CopilotSdkClientAdapter,
    signal: AbortSignal,
    timeoutMs: number,
    onStatus?: (value: string) => void,
  ): Promise<string> {
    const directoryCreation = this.trackPending(
      Promise.resolve().then(() =>
        this.fileSystem.createSessionDirectory(this.clients.get(client) ?? tmpdir()),
      ),
    );
    let directory: string;
    try {
      directory = await waitForStage(directoryCreation, signal, timeoutMs, () => {
        onStatus?.(`Copilot SDK session state creation timed out after ${timeoutMs}ms.`);
      });
    } catch (error) {
      this.scheduleDirectoryCleanup(directoryCreation, this.sessionCleanupGraceMs);
      if (isAbortError(error, signal)) throw abortError(signal);
      if (error instanceof SafeSdkSearchError) throw error;
      throw new SafeSdkSearchError(
        "Copilot SDK search could not create isolated temporary state. No prompt was sent.",
      );
    }

    const configCreation = this.trackPending(
      Promise.resolve().then(() => this.fileSystem.createDirectory(join(directory, "config"))),
    );
    try {
      await waitForStage(configCreation, signal, timeoutMs, () => {
        onStatus?.(`Copilot SDK session configuration timed out after ${timeoutMs}ms.`);
      });
    } catch (error) {
      await this.removeDirectoryWithin(directory, this.sessionCleanupGraceMs);
      const lateCleanup = configCreation.then(
        () => this.removeDirectoryWithin(directory, this.sessionCleanupGraceMs),
        () => false,
      );
      this.trackPending(lateCleanup);
      void lateCleanup.catch(() => undefined);
      if (isAbortError(error, signal)) throw abortError(signal);
      if (error instanceof SafeSdkSearchError) throw error;
      throw new SafeSdkSearchError(
        "Copilot SDK search could not create isolated temporary state. No prompt was sent.",
      );
    }
    return directory;
  }

  private async sendWithInactivityTimeout(
    session: CopilotSdkSessionAdapter,
    prompt: string,
    state: SdkEventState,
    signal: AbortSignal | undefined,
    onStatus?: (value: string) => void,
  ): Promise<void> {
    if (signal?.aborted) throw abortError(signal);
    const timeoutMs = copilotSearchTimeoutMs(this.environment());
    let timeout: NodeJS.Timeout | undefined;
    let rejectTimeout: ((error: Error) => void) | undefined;
    let rejectAbort: ((error: DOMException) => void) | undefined;
    let timedOut = false;
    const resetTimeout = () => {
      if (timeout) clearTimeout(timeout);
      timeout = setTimeout(() => {
        timedOut = true;
        onStatus?.(`Copilot SDK search timed out after ${timeoutMs}ms without activity; stopping…`);
        void Promise.resolve()
          .then(() => session.abort())
          .catch(() => undefined);
        rejectTimeout?.(
          new SafeSdkSearchError(
            `Copilot SDK search timed out after ${timeoutMs}ms without activity. Retry with a narrower request, omit page inspection, or increase PI_COPILOT_SEARCH_TIMEOUT_MS.`,
          ),
        );
      }, timeoutMs);
      timeout.unref?.();
    };
    const unsubscribe = session.on((event) => {
      if (handleSdkEvent(event, state, onStatus) && !timedOut) resetTimeout();
    });
    const timeoutFailure = new Promise<never>((_resolve, reject) => {
      rejectTimeout = reject;
    });
    const abortFailure = new Promise<never>((_resolve, reject) => {
      rejectAbort = reject;
    });
    const onAbort = () => {
      void Promise.resolve()
        .then(() => session.abort())
        .catch(() => undefined);
      rejectAbort?.(abortError(signal));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    resetTimeout();
    try {
      const response = await Promise.race([
        session.sendAndWait({ prompt }, MAXIMUM_SDK_WAIT_MS),
        timeoutFailure,
        abortFailure,
      ]);
      const event = asRecord(response) as SdkEvent | undefined;
      if (event) handleSdkEvent(event, state, onStatus);
    } finally {
      if (timeout) clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      unsubscribe();
    }
  }

  async search(
    params: SearchParams,
    signal?: AbortSignal,
    onStatus?: (value: string) => void,
  ): Promise<BackendSearchResult> {
    const operation = this.admitSearch(signal);
    try {
      return await this.performSearch(params, operation.controller.signal, onStatus);
    } finally {
      operation.removeCallerAbort();
      this.inFlightSearches.delete(operation);
      operation.finish();
    }
  }

  private async performSearch(
    params: SearchParams,
    signal: AbortSignal,
    onStatus?: (value: string) => void,
  ): Promise<BackendSearchResult> {
    if (signal.aborted) throw abortError(signal);
    const normalized = normalizeSearchParams(params);
    const timeoutMs = copilotSearchTimeoutMs(this.environment());
    onStatus?.("Searching with Copilot SDK…");
    const client = await waitForStage(this.ensureClient(), signal, timeoutMs, () => {
      onStatus?.(`Copilot SDK startup timed out after ${timeoutMs}ms without activity.`);
    });
    if (signal.aborted) throw abortError(signal);
    const directory = await this.createSessionState(client, signal, timeoutMs, onStatus);
    if (signal.aborted) {
      await this.removeDirectoryWithin(directory, this.sessionCleanupGraceMs);
      throw abortError(signal);
    }

    let entry: ActiveSession | undefined;
    let primaryError: unknown;
    let result: BackendSearchResult | undefined;
    const permissionCallIds = new Set<string>();
    const state = freshEventState(permissionCallIds);
    let captureEarlyEvents = true;
    let capabilityVerified = false;
    const sessionConfig = buildCopilotSdkSessionConfig(
      normalized,
      directory,
      this.availableTools(Boolean(normalized.includeContent)),
      permissionCallIds,
      (event) => {
        if (captureEarlyEvents) handleSdkEvent(event as unknown as SdkEvent, state, onStatus);
      },
      () => capabilityVerified,
      this.hostResolver,
    );
    const requestedSessionId = sessionConfig.sessionId as string;
    try {
      const createPromise = this.trackPending(
        Promise.resolve().then(() => client.createSession(sessionConfig)),
      );
      let session: CopilotSdkSessionAdapter;
      try {
        session = await waitForStage(createPromise, signal, timeoutMs, () => {
          onStatus?.(`Copilot SDK session creation timed out after ${timeoutMs}ms.`);
        });
      } catch (error) {
        await withinDeadline(
          Promise.resolve().then(() => client.deleteSession(requestedSessionId)),
          this.sessionCleanupGraceMs,
        );
        const lateCleanup = createPromise.then(
          async (lateSession) => {
            const lateEntry = { client, session: lateSession, directory };
            this.activeSessions.add(lateEntry);
            await this.cleanupActive(lateEntry, true);
          },
          async () => {
            await withinDeadline(
              Promise.resolve().then(() => client.deleteSession(requestedSessionId)),
              this.sessionCleanupGraceMs,
            );
          },
        );
        this.trackPending(lateCleanup);
        void lateCleanup.catch(() => undefined);
        throw error;
      }

      entry = { client, session, directory };
      this.activeSessions.add(entry);
      if (signal.aborted) throw abortError(signal);
      const verification = this.trackPending(
        this.verifySessionTools(session, Boolean(normalized.includeContent)),
      );
      await waitForStage(verification, signal, timeoutMs, () => {
        onStatus?.(`Copilot SDK tool verification timed out after ${timeoutMs}ms.`);
        void Promise.resolve()
          .then(() => session.abort())
          .catch(() => undefined);
      });
      capabilityVerified = true;
      if (signal.aborted) throw abortError(signal);
      captureEarlyEvents = false;
      await this.sendWithInactivityTimeout(session, promptFor(normalized), state, signal, onStatus);
      result = resultFromState(state);
    } catch (error) {
      captureEarlyEvents = false;
      primaryError = error;
      if (error instanceof SdkConnectionError || connectionFailed(error)) this.retireClient(client);
    }

    const cleanupErrors = entry
      ? await this.cleanupActive(entry, Boolean(primaryError) || signal.aborted)
      : [];
    if (!entry) {
      await this.removeDirectoryWithin(directory, this.sessionCleanupGraceMs);
      if (this.retiredClients.has(client)) await this.stopRetiredClient(client);
    }

    if (primaryError) {
      if (isAbortError(primaryError, signal)) throw abortError(signal);
      if (primaryError instanceof SafeSdkSearchError) throw primaryError;
      throw new SafeSdkSearchError(
        "Copilot SDK search failed. Confirm bundled-runtime authentication and model access, then try again. The prompt was not retried with another transport.",
      );
    }
    if (cleanupErrors.length > 0)
      throw new SafeSdkSearchError(
        "Copilot SDK search could not remove its temporary session. The answer was not returned.",
      );
    if (!result) throw new SafeSdkSearchError("Copilot SDK search completed without results.");
    return result;
  }

  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.shuttingDown = true;
    for (const operation of this.inFlightSearches) operation.controller.abort();
    this.shutdownPromise = (async () => {
      await withinDeadline(
        Promise.all([...this.inFlightSearches].map((operation) => operation.done)),
        this.shutdownGraceMs,
      );
      const pendingStart = this.startPromise;
      if (pendingStart) await withinDeadline(pendingStart, this.shutdownGraceMs);
      await withinDeadline(Promise.allSettled([...this.pendingAdmissions]), this.shutdownGraceMs);
      await Promise.all([...this.activeSessions].map((entry) => this.cleanupActive(entry, true)));
      await Promise.all([...this.clients.keys()].map((client) => this.stopClient(client)));
    })();
    return this.shutdownPromise;
  }
}

export async function runCopilotSdkSearch(
  runtime: CopilotSearchRuntime,
  params: SearchParams,
  signal?: AbortSignal,
  onStatus?: (value: string) => void,
): Promise<BackendSearchResult> {
  return runtime.search(params, signal, onStatus);
}
