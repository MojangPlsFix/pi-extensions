/**
 * Give sessions a useful one-line title in /resume.
 *
 * Pi's session picker displays session_info names instead of the first user
 * message. This extension uses the active provider to generate one automatic
 * title after the first meaningful completed turn.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AssistantMessage, Message, ProviderHeaders, Usage } from "@earendil-works/pi-ai";
import { uuidv7 } from "@earendil-works/pi-ai";
import {
  CONFIG_DIR_NAME,
  convertToLlm,
  type ExtensionAPI,
  type ExtensionContext,
  type SessionEntry,
  SessionManager,
  serializeConversation,
} from "@earendil-works/pi-coding-agent";
import { agentDirectory } from "../../shared/copilot-snapshots.js";

const CUSTOM_TYPE = "session-summary";
const AUTO_ATTEMPT_CUSTOM_TYPE = "session-summary-auto-attempt";
const CONFIG_FILE = "pi-session-summary.json";
const MAX_TRANSCRIPT_CHARS = 80_000;
const MAX_AUTOMATIC_TRANSCRIPT_CHARS = 8_000;
const MAX_TITLE_CHARS = 140;
const MAX_OUTPUT_TOKENS = 800;
const SUMMARY_TIMEOUT_MS = 20_000;
const RESUMMARIZE_TOKEN_THRESHOLD = 20_000;
const USAGE_CHANGED_EVENT = "pi-tools:session-summary-usage";
const TRANSCRIPT_TOKEN_RATIO = 4;
const REQUEST_OVERHEAD_CHARS = 256;
const MAX_DIAGNOSTIC_CHARS = 600;
const MAX_DIAGNOSTIC_ATTEMPTS = 4;
const LEGACY_MODEL_LABEL = "github-copilot/gpt-5.6-luna";
const TERMINAL_ESCAPE = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\)?)/gu;
const LOW_SIGNAL_INPUTS = new Set([
  "hi",
  "hello",
  "hey",
  "thanks",
  "thank you",
  "ok",
  "okay",
  "yes",
  "no",
  "test",
  "ping",
]);

const BUILTIN_PROFILES: ReadonlyMap<string, readonly string[]> = new Map([
  ["github-copilot", ["gpt-5.6-luna"]],
  ["openai-codex", ["gpt-5.3-codex-spark", "gpt-5.6-luna"]],
]);

const SUMMARY_SYSTEM_PROMPT = [
  "You create concise titles for coding-agent sessions.",
  "Return only one plain-text line, with no markdown, quotes, or prefix.",
  `Keep it under ${MAX_TITLE_CHARS} characters. Mention the main task and, when useful, its current state or next step.`,
].join(" ");

type SummaryAttemptOutcome =
  | "success"
  | "model-unavailable"
  | "provider-mismatch"
  | "authentication-unavailable"
  | "request-failed"
  | "empty-output"
  | "deadline-exceeded";

type SummaryAttempt = {
  provider: string;
  model: string;
  outcome: SummaryAttemptOutcome;
  usage?: Usage;
  diagnostic?: string;
};

type UsageAttachment = {
  messageTimestamp: number;
  provider: string;
  model: string;
};

type SummaryRunSource = "automatic" | "manual" | "backfill";

type AutoSummaryData = {
  name?: string;
  messageCount: number;
  provider?: string;
  model?: string;
  source?: SummaryRunSource;
  attempts?: SummaryAttempt[];
  usage?: Usage;
  usageAttached?: boolean;
  usageAttachment?: UsageAttachment;
};

type SummaryUpdate = {
  status: "skipped" | "busy" | "success" | "failure";
  title?: string;
  usage?: Usage;
  usageAttached: boolean;
  diagnostic?: string;
};

type TitleResult = {
  title?: string;
  provider?: string;
  model?: string;
  attempts: SummaryAttempt[];
  usage?: Usage;
  diagnostic?: string;
};

type Auth = {
  apiKey?: string;
  headers?: ProviderHeaders;
  baseUrl?: string;
  env?: Record<string, string>;
};

type UsageTotals = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: number;
};

type UsageLedger = {
  totals: UsageTotals;
  models: Map<string, UsageTotals>;
};

export type SessionSummaryProfiles = ReadonlyMap<string, readonly string[]>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function createUsageTotals(): UsageTotals {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 };
}

function createUsageLedger(): UsageLedger {
  return { totals: createUsageTotals(), models: new Map() };
}

function emptyUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function addUsage(totals: UsageTotals, usage: Usage): void {
  totals.input += usage.input;
  totals.output += usage.output;
  totals.cacheRead += usage.cacheRead;
  totals.cacheWrite += usage.cacheWrite;
  totals.totalTokens += usage.totalTokens;
  totals.cost += usage.cost.total;
}

function mergeUsage(base: Usage | undefined, extra: Usage): Usage {
  const current = base ?? emptyUsage();
  const cacheWrite1h = (current.cacheWrite1h ?? 0) + (extra.cacheWrite1h ?? 0);
  return {
    ...current,
    input: current.input + extra.input,
    output: current.output + extra.output,
    cacheRead: current.cacheRead + extra.cacheRead,
    cacheWrite: current.cacheWrite + extra.cacheWrite,
    ...(cacheWrite1h > 0 ? { cacheWrite1h } : {}),
    totalTokens: current.totalTokens + extra.totalTokens,
    reasoning: (current.reasoning ?? 0) + (extra.reasoning ?? 0),
    cost: {
      input: current.cost.input + extra.cost.input,
      output: current.cost.output + extra.cost.output,
      cacheRead: current.cost.cacheRead + extra.cost.cacheRead,
      cacheWrite: current.cost.cacheWrite + extra.cost.cacheWrite,
      total: current.cost.total + extra.cost.total,
    },
  };
}

function combinedAttemptUsage(attempts: SummaryAttempt[]): Usage | undefined {
  let combined: Usage | undefined;
  for (const attempt of attempts) {
    if (attempt.usage) combined = mergeUsage(combined, attempt.usage);
  }
  return combined;
}

function addAttemptUsage(ledger: UsageLedger, attempts: SummaryAttempt[]): void {
  for (const attempt of attempts) {
    if (!attempt.usage) continue;
    addUsage(ledger.totals, attempt.usage);
    const label = `${attempt.provider}/${attempt.model}`;
    const totals = ledger.models.get(label) ?? createUsageTotals();
    addUsage(totals, attempt.usage);
    ledger.models.set(label, totals);
  }
}

function formatCost(cost: number): string {
  return `$${cost.toFixed(4)}`;
}

function boundedText(text: string, max = 120): string {
  const normalized = text
    .replace(TERMINAL_ESCAPE, "")
    .replace(/[\p{Cc}\p{Cf}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return normalized.length <= max ? normalized : `${normalized.slice(0, max - 1)}…`;
}

function truncateTranscript(text: string, maxChars: number): string {
  const limit = Math.max(0, Math.floor(maxChars));
  if (text.length <= limit) return text;
  if (limit === 0) return "";

  const marker = "\n\n[...middle of conversation omitted...]\n\n";
  if (limit <= marker.length + 2) return text.slice(0, limit);
  const available = limit - marker.length;
  const firstChars = Math.floor(available * 0.4);
  const lastChars = available - firstChars;
  return `${text.slice(0, firstChars)}${marker}${text.slice(-lastChars)}`;
}

function extractTitle(text: string): string | undefined {
  const title = text
    .replace(/```/g, "")
    .replace(/[\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^\s*(?:title|summary)\s*:\s*/i, "")
    .trim()
    .replace(/^['"]|['"]$/g, "")
    .trim();

  if (!title) return undefined;
  return title.length > MAX_TITLE_CHARS
    ? `${title.slice(0, MAX_TITLE_CHARS - 1).trimEnd()}…`
    : title;
}

function getMessageEntries(entries: SessionEntry[]): Extract<SessionEntry, { type: "message" }>[] {
  return entries.filter(
    (entry): entry is Extract<SessionEntry, { type: "message" }> => entry.type === "message",
  );
}

function serializeConversationText(entries: SessionEntry[], fromMessage = 0): string {
  const messages = getMessageEntries(entries)
    .slice(fromMessage)
    .map((entry) => entry.message);

  if (messages.length === 0) return "";
  return serializeConversation(convertToLlm(messages)).trim();
}

function latestUserMessage(
  entries: SessionEntry[],
): Extract<SessionEntry, { type: "message" }> | undefined {
  return [...getMessageEntries(entries)].reverse().find((entry) => entry.message.role === "user");
}

function meaningfulUserInput(entries: SessionEntry[]): boolean {
  const entry = latestUserMessage(entries);
  if (entry?.message.role !== "user") return false;
  const content = entry.message.content;
  if (typeof content === "string") {
    const normalized = content
      .toLocaleLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .trim();
    return Boolean(normalized && !LOW_SIGNAL_INPUTS.has(normalized));
  }

  const text: string[] = [];
  for (const block of content) {
    if (block.type === "image") return true;
    if (block.type === "text") text.push(block.text);
  }
  const normalized = text
    .join(" ")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
  return Boolean(normalized && !LOW_SIGNAL_INPUTS.has(normalized));
}

function automaticConversation(entries: SessionEntry[], currentMessage: AssistantMessage): string {
  const user = latestUserMessage(entries);
  if (user?.message.role !== "user") return "";
  const conversation = serializeConversation(convertToLlm([user.message, currentMessage])).trim();
  return truncateTranscript(conversation, MAX_AUTOMATIC_TRANSCRIPT_CHARS);
}

function getLatestSessionInfo(
  entries: SessionEntry[],
): Extract<SessionEntry, { type: "session_info" }> | undefined {
  return [...entries]
    .reverse()
    .find((entry): entry is Extract<SessionEntry, { type: "session_info" }> => {
      return entry.type === "session_info";
    });
}

function getLatestSuccessfulSummary(entries: SessionEntry[]): AutoSummaryData | undefined {
  for (const entry of [...entries].reverse()) {
    if (entry.type !== "custom" || entry.customType !== CUSTOM_TYPE) continue;
    const data = entry.data;
    if (!isRecord(data)) continue;
    if (typeof data.name !== "string" || typeof data.messageCount !== "number") continue;
    return {
      name: data.name,
      messageCount: data.messageCount,
      ...(typeof data.provider === "string" ? { provider: data.provider } : {}),
      ...(typeof data.model === "string" ? { model: data.model } : {}),
      ...(Array.isArray(data.attempts) ? { attempts: data.attempts as SummaryAttempt[] } : {}),
      ...(isRecord(data.usage) ? { usage: data.usage as unknown as Usage } : {}),
      ...(typeof data.usageAttached === "boolean" ? { usageAttached: data.usageAttached } : {}),
      ...(isRecord(data.usageAttachment)
        ? { usageAttachment: data.usageAttachment as UsageAttachment }
        : {}),
    };
  }
  return undefined;
}

function hasAutomaticAttempt(entries: SessionEntry[]): boolean {
  return entries.some(
    (entry) =>
      entry.type === "custom" &&
      (entry.customType === AUTO_ATTEMPT_CUSTOM_TYPE || entry.customType === CUSTOM_TYPE),
  );
}

function usageFromUnknown(value: unknown): Usage | undefined {
  if (!isRecord(value)) return undefined;
  const finite = (candidate: unknown): number | undefined =>
    typeof candidate === "number" && Number.isFinite(candidate) ? candidate : undefined;
  const input = finite(value.input);
  const output = finite(value.output);
  const cacheRead = finite(value.cacheRead);
  const cacheWrite = finite(value.cacheWrite);
  const totalTokens = finite(value.totalTokens);
  if (
    input === undefined ||
    output === undefined ||
    cacheRead === undefined ||
    cacheWrite === undefined ||
    totalTokens === undefined ||
    !isRecord(value.cost)
  )
    return undefined;
  const costInput = finite(value.cost.input);
  const costOutput = finite(value.cost.output);
  const costCacheRead = finite(value.cost.cacheRead);
  const costCacheWrite = finite(value.cost.cacheWrite);
  const costTotal = finite(value.cost.total);
  if (
    costInput === undefined ||
    costOutput === undefined ||
    costCacheRead === undefined ||
    costCacheWrite === undefined ||
    costTotal === undefined
  )
    return undefined;
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    ...(finite(value.cacheWrite1h) !== undefined
      ? { cacheWrite1h: finite(value.cacheWrite1h) }
      : {}),
    ...(finite(value.reasoning) !== undefined ? { reasoning: finite(value.reasoning) } : {}),
    totalTokens,
    cost: {
      input: costInput,
      output: costOutput,
      cacheRead: costCacheRead,
      cacheWrite: costCacheWrite,
      total: costTotal,
    },
  };
}

function getSummaryUsage(entries: SessionEntry[]): UsageLedger {
  const ledger = createUsageLedger();
  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== CUSTOM_TYPE || !isRecord(entry.data))
      continue;
    const data = entry.data;
    let recordedAttempts = false;
    if (Array.isArray(data.attempts)) {
      for (const value of data.attempts) {
        if (!isRecord(value)) continue;
        const provider = typeof value.provider === "string" ? value.provider : undefined;
        const model = typeof value.model === "string" ? value.model : undefined;
        const attemptUsage = usageFromUnknown(value.usage);
        if (!provider || !model || !attemptUsage) continue;
        addAttemptUsage(ledger, [{ provider, model, outcome: "success", usage: attemptUsage }]);
        recordedAttempts = true;
      }
    }
    if (recordedAttempts) continue;

    const legacyUsage = usageFromUnknown(data.usage);
    if (!legacyUsage) continue;
    const label =
      typeof data.provider === "string" && typeof data.model === "string"
        ? `${data.provider}/${data.model}`
        : LEGACY_MODEL_LABEL;
    addUsage(ledger.totals, legacyUsage);
    const totals = ledger.models.get(label) ?? createUsageTotals();
    addUsage(totals, legacyUsage);
    ledger.models.set(label, totals);
  }
  return ledger;
}

function hasExplicitName(entries: SessionEntry[], currentName: string | undefined): boolean {
  const latestInfo = getLatestSessionInfo(entries);
  if (!latestInfo) return currentName !== undefined;

  const auto = getLatestSuccessfulSummary(entries);
  if (auto && currentName === auto.name) return false;

  // A latest session_info entry without a name represents an intentional clear
  // via /name, so do not immediately recreate it.
  if (!latestInfo.name?.trim()) return true;
  return latestInfo.name.trim() !== currentName || currentName !== undefined;
}

function validProfiles(value: unknown): Map<string, string[]> {
  const result = new Map<string, string[]>();
  if (!isRecord(value) || !isRecord(value.profiles)) return result;
  for (const [rawProvider, rawModels] of Object.entries(value.profiles)) {
    const provider = rawProvider.trim();
    if (!provider || !Array.isArray(rawModels)) continue;
    const models: string[] = [];
    let valid = true;
    for (const rawModel of rawModels) {
      if (typeof rawModel !== "string" || !rawModel.trim()) {
        valid = false;
        break;
      }
      const model = rawModel.trim();
      if (!models.includes(model)) models.push(model);
    }
    if (valid) result.set(provider, models);
  }
  return result;
}

async function readProfileFile(path: string): Promise<Map<string, string[]>> {
  try {
    return validProfiles(JSON.parse(await readFile(path, "utf8")) as unknown);
  } catch {
    return new Map();
  }
}

export function resolveSessionSummaryPaths(
  cwd: string,
  trusted: boolean,
  env: NodeJS.ProcessEnv = process.env,
): { globalPath: string; projectPath?: string } {
  return {
    globalPath: join(agentDirectory(env), CONFIG_FILE),
    ...(trusted ? { projectPath: join(cwd, CONFIG_DIR_NAME, CONFIG_FILE) } : {}),
  };
}

export async function loadSessionSummaryProfiles(options: {
  cwd: string;
  trusted: boolean;
  env?: NodeJS.ProcessEnv;
}): Promise<SessionSummaryProfiles> {
  const profiles = new Map<string, readonly string[]>(
    [...BUILTIN_PROFILES].map(([provider, models]) => [provider, [...models]]),
  );
  const paths = resolveSessionSummaryPaths(options.cwd, options.trusted, options.env);
  for (const path of [paths.globalPath, paths.projectPath]) {
    if (!path) continue;
    for (const [provider, models] of await readProfileFile(path)) profiles.set(provider, models);
  }
  return profiles;
}

export function buildSessionSummaryRequest(
  model: NonNullable<ExtensionContext["model"]>,
  auth: Auth,
): { model: NonNullable<ExtensionContext["model"]>; auth: Auth } {
  const baseUrl = auth.baseUrl;
  const requestModel = baseUrl && baseUrl !== model.baseUrl ? { ...model, baseUrl } : model;
  return { model: requestModel, auth };
}

function summarizeContent(content: AssistantMessage["content"]): string {
  if (!Array.isArray(content) || content.length === 0) return "none";

  return content
    .map((block) => {
      switch (block.type) {
        case "text":
          return `text(${block.text.length})`;
        case "thinking":
          return `thinking(${block.thinking.length})`;
        case "toolCall":
          return "toolCall";
        default:
          return "unknown";
      }
    })
    .join(", ");
}

function promptText(
  conversation: string,
  previousSummary: string,
  shouldResummarize: boolean,
): string {
  return shouldResummarize
    ? [
        "Create a concise session title from this conversation.",
        "Focus on the actual coding task rather than generic statements like 'Coding help'.",
        "Return only the title on one line.",
        "",
        "<conversation>",
        conversation,
        "</conversation>",
      ].join("\n")
    : [
        "Here is the previous one-line title for this coding session:",
        `<summary>${previousSummary}</summary>`,
        "",
        "Here is the conversation since that title was generated:",
        "<conversation>",
        conversation,
        "</conversation>",
        "",
        "Return the previous title exactly if nothing material changed.",
        "Otherwise update it to reflect the whole session, not just the latest exchange.",
        "Return only one concise title on one line.",
      ].join("\n");
}

function outputTokenLimit(model: NonNullable<ExtensionContext["model"]>): number {
  const modelLimit = Number.isFinite(model.maxTokens)
    ? Math.max(1, Math.floor(model.maxTokens))
    : 1;
  const contextLimit = Number.isFinite(model.contextWindow)
    ? Math.max(1, Math.floor(model.contextWindow / 4))
    : MAX_OUTPUT_TOKENS;
  return Math.min(MAX_OUTPUT_TOKENS, modelLimit, contextLimit);
}

function buildPromptForModel(
  conversation: string,
  previousSummary: string,
  shouldResummarize: boolean,
  model: NonNullable<ExtensionContext["model"]>,
): { prompt: string; maxTokens: number } {
  const maxTokens = outputTokenLimit(model);
  const skeleton = promptText("", previousSummary, shouldResummarize);
  const contextChars = Number.isFinite(model.contextWindow)
    ? Math.max(0, Math.floor(model.contextWindow - maxTokens) * TRANSCRIPT_TOKEN_RATIO)
    : MAX_TRANSCRIPT_CHARS;
  const transcriptChars = Math.max(
    0,
    Math.min(
      MAX_TRANSCRIPT_CHARS,
      contextChars - SUMMARY_SYSTEM_PROMPT.length - skeleton.length - REQUEST_OVERHEAD_CHARS,
    ),
  );
  return {
    prompt: promptText(
      truncateTranscript(conversation, transcriptChars),
      previousSummary,
      shouldResummarize,
    ),
    maxTokens,
  };
}

function orderedCandidates(
  provider: string,
  profiles: SessionSummaryProfiles,
  activeModel: NonNullable<ExtensionContext["model"]>,
  pinnedModels: ReadonlyMap<string, string>,
): string[] {
  const configured = profiles.get(provider);
  const candidates = configured ? [...configured] : [activeModel.id];
  const pinned = pinnedModels.get(provider);
  if (!pinned || !candidates.includes(pinned)) return candidates;
  return [pinned, ...candidates.filter((candidate) => candidate !== pinned)];
}

const DEADLINE_EXCEEDED = Symbol("session-summary-deadline");

async function withinDeadline<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw DEADLINE_EXCEEDED;
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(DEADLINE_EXCEEDED);
    };
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
}

function failureDiagnostic(provider: string, attempts: SummaryAttempt[]): string {
  const shown = attempts.slice(0, MAX_DIAGNOSTIC_ATTEMPTS).map((attempt) => {
    const detail = attempt.diagnostic ?? attempt.outcome.replaceAll("-", " ");
    return `${boundedText(attempt.model, 80)}: ${boundedText(detail, 140)}`;
  });
  if (attempts.length > shown.length) shown.push(`and ${attempts.length - shown.length} more`);
  const message = `No ${provider} session-summary model succeeded${shown.length ? ` (${shown.join(", ")})` : ""}`;
  return boundedText(message, MAX_DIAGNOSTIC_CHARS);
}

async function generateTitle(
  ctx: ExtensionContext,
  entries: SessionEntry[],
  previousSummary: string,
  lastSummaryMessageCount: number,
  profiles: SessionSummaryProfiles,
  pinnedModels: ReadonlyMap<string, string>,
  options?: { conversation?: string; forceFull?: boolean; signal?: AbortSignal },
): Promise<TitleResult> {
  const tokenEstimate = (text: string) => Math.ceil(text.length / TRANSCRIPT_TOKEN_RATIO);
  const suppliedConversation = options?.conversation?.trim();
  const previousConversation = options?.forceFull
    ? serializeConversationText(entries)
    : serializeConversationText(entries, lastSummaryMessageCount);
  if (!suppliedConversation && !previousConversation)
    return { attempts: [], diagnostic: "No conversation is available to summarize" };

  const activeModel = ctx.model;
  if (!activeModel) return { attempts: [], diagnostic: "No active model is available" };
  const provider = activeModel.provider;
  const candidates = orderedCandidates(provider, profiles, activeModel, pinnedModels);
  if (candidates.length === 0) {
    return { attempts: [], diagnostic: `Session summaries are disabled for ${provider}` };
  }

  const fullConversation = serializeConversationText(entries);
  const shouldResummarize =
    Boolean(suppliedConversation) ||
    options?.forceFull === true ||
    !previousSummary ||
    tokenEstimate(previousConversation) >= RESUMMARIZE_TOKEN_THRESHOLD;
  const conversation =
    suppliedConversation ?? (shouldResummarize ? fullConversation : previousConversation);
  const attempts: SummaryAttempt[] = [];
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (options?.signal?.aborted) controller.abort();
  else options?.signal?.addEventListener("abort", abort, { once: true });
  const deadline = Date.now() + SUMMARY_TIMEOUT_MS;
  const timeout = setTimeout(() => controller.abort(), SUMMARY_TIMEOUT_MS);

  try {
    for (const candidate of candidates) {
      if (controller.signal.aborted || Date.now() >= deadline) break;
      const label = `${provider}/${candidate}`;
      let model: NonNullable<ExtensionContext["model"]> | undefined;
      try {
        model = ctx.modelRegistry.find(provider, candidate);
      } catch {
        attempts.push({
          provider,
          model: candidate,
          outcome: "model-unavailable",
          diagnostic: `${label} model lookup failed`,
        });
        continue;
      }
      if (!model) {
        attempts.push({
          provider,
          model: candidate,
          outcome: "model-unavailable",
          diagnostic: `${label} is unavailable`,
        });
        continue;
      }
      if (model.provider !== provider) {
        attempts.push({
          provider,
          model: candidate,
          outcome: "provider-mismatch",
          diagnostic: `${label} resolved to another provider`,
        });
        continue;
      }

      let auth: Awaited<ReturnType<typeof ctx.modelRegistry.getApiKeyAndHeaders>>;
      try {
        auth = await withinDeadline(
          ctx.modelRegistry.getApiKeyAndHeaders(model),
          controller.signal,
        );
      } catch (error) {
        if (error === DEADLINE_EXCEEDED || controller.signal.aborted) {
          attempts.push({
            provider,
            model: candidate,
            outcome: "deadline-exceeded",
            diagnostic: `${label} exceeded the shared deadline`,
          });
          break;
        }
        attempts.push({
          provider,
          model: candidate,
          outcome: "authentication-unavailable",
          diagnostic: `${label} authentication is unavailable`,
        });
        continue;
      }
      if (!auth.ok) {
        attempts.push({
          provider,
          model: candidate,
          outcome: "authentication-unavailable",
          diagnostic: `${label} authentication is unavailable`,
        });
        continue;
      }

      const request = buildSessionSummaryRequest(model, auth);
      const { prompt, maxTokens } = buildPromptForModel(
        conversation,
        previousSummary,
        shouldResummarize,
        request.model,
      );
      const messages: Message[] = [
        {
          role: "user",
          content: [{ type: "text", text: prompt }],
          timestamp: Date.now(),
        },
      ];
      let response: AssistantMessage;
      try {
        response = await withinDeadline(
          ctx.modelRegistry.complete(
            request.model,
            { systemPrompt: SUMMARY_SYSTEM_PROMPT, messages },
            {
              apiKey: request.auth.apiKey,
              headers: request.auth.headers,
              env: request.auth.env,
              cacheRetention: "none",
              sessionId: uuidv7(),
              maxTokens,
              timeoutMs: Math.max(1, deadline - Date.now()),
              signal: controller.signal,
            },
          ),
          controller.signal,
        );
      } catch (error) {
        if (error === DEADLINE_EXCEEDED || controller.signal.aborted) {
          attempts.push({
            provider,
            model: candidate,
            outcome: "deadline-exceeded",
            diagnostic: `${label} exceeded the shared deadline`,
          });
          break;
        }
        attempts.push({
          provider,
          model: candidate,
          outcome: "request-failed",
          diagnostic: `${label} provider request failed`,
        });
        continue;
      }

      const title = extractTitle(
        response.content
          .filter((content): content is { type: "text"; text: string } => content.type === "text")
          .map((content) => content.text)
          .join("\n"),
      );
      if (!title) {
        attempts.push({
          provider,
          model: candidate,
          outcome: "empty-output",
          usage: response.usage,
          diagnostic: `${label} returned no final text (stop: ${response.stopReason}; content: ${summarizeContent(response.content)})`,
        });
        continue;
      }

      attempts.push({ provider, model: candidate, outcome: "success", usage: response.usage });
      return {
        title,
        provider,
        model: candidate,
        attempts,
        usage: combinedAttemptUsage(attempts),
      };
    }
  } finally {
    clearTimeout(timeout);
    options?.signal?.removeEventListener("abort", abort);
  }

  return {
    attempts,
    usage: combinedAttemptUsage(attempts),
    diagnostic: failureDiagnostic(provider, attempts),
  };
}

function persistedSummaryData(
  result: TitleResult,
  messageCount: number,
  source: SummaryRunSource,
  usageAttached: boolean,
  usageAttachment?: UsageAttachment,
): AutoSummaryData {
  return {
    ...(result.title ? { name: result.title } : {}),
    messageCount,
    source,
    ...(result.provider ? { provider: result.provider } : {}),
    ...(result.model ? { model: result.model } : {}),
    attempts: result.attempts,
    ...(result.usage ? { usage: result.usage } : {}),
    usageAttached,
    ...(usageAttachment ? { usageAttachment } : {}),
  };
}

function persistCurrentSummary(
  pi: ExtensionAPI,
  result: TitleResult,
  messageCount: number,
  source: SummaryRunSource,
  usageAttached: boolean,
  usageAttachment?: UsageAttachment,
): void {
  if (result.title) pi.setSessionName(result.title);
  if (result.title || result.attempts.length > 0) {
    pi.appendEntry(
      CUSTOM_TYPE,
      persistedSummaryData(result, messageCount, source, usageAttached, usageAttachment),
    );
  }
}

function notifyUsageChanged(pi: ExtensionAPI): void {
  pi.events.emit(USAGE_CHANGED_EVENT, undefined);
}

function backfillFailureMessage(failures: string[], total: number): string {
  const shown = failures
    .slice(0, MAX_DIAGNOSTIC_ATTEMPTS)
    .map((failure) => boundedText(failure, 140));
  if (failures.length > shown.length) shown.push(`and ${failures.length - shown.length} more`);
  return boundedText(
    `Could not complete title backfill for ${failures.length} of ${total} sessions${shown.length ? ` (${shown.join("; ")})` : ""}`,
    MAX_DIAGNOSTIC_CHARS,
  );
}

function costReport(ledger: UsageLedger): string {
  const total = ledger.totals;
  const lines = [
    `Session Summary total | ${total.totalTokens.toLocaleString()} tokens | cost: ${formatCost(total.cost)} | ${total.input.toLocaleString()} input, ${total.output.toLocaleString()} output`,
  ];
  for (const [label, usage] of [...ledger.models].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    lines.push(
      `${label} | ${usage.totalTokens.toLocaleString()} tokens | cost: ${formatCost(usage.cost)} | ${usage.input.toLocaleString()} input, ${usage.output.toLocaleString()} output`,
    );
  }
  return lines.join("\n");
}

export default function (pi: ExtensionAPI) {
  let runtimeActive = false;
  let sessionId: string | undefined;
  let sessionGeneration = 0;
  let automaticAttempted = false;
  let lastSummary = "";
  let lastSummaryMessageCount = 0;
  let summaryUsage = createUsageLedger();
  let profiles: SessionSummaryProfiles = BUILTIN_PROFILES;
  let pinnedModels = new Map<string, string>();
  let activeRun:
    | {
        token: symbol;
        sessionId: string;
        generation: number;
        source: SummaryRunSource;
        controller: AbortController;
      }
    | undefined;

  const isCurrentSession = (capturedSessionId: string, generation: number): boolean =>
    runtimeActive && sessionId === capturedSessionId && sessionGeneration === generation;

  function releaseRun(token: symbol): void {
    if (activeRun?.token === token) activeRun = undefined;
  }

  async function updateCurrentSession(
    ctx: ExtensionContext,
    source: "automatic" | "manual",
    currentMessage?: AssistantMessage,
  ): Promise<SummaryUpdate> {
    if (process.env.PI_SESSION_SUMMARY === "off") {
      return { status: "skipped", usageAttached: false };
    }

    const capturedSessionId = sessionId;
    const capturedGeneration = sessionGeneration;
    if (!capturedSessionId || !isCurrentSession(capturedSessionId, capturedGeneration)) {
      return { status: "skipped", usageAttached: false };
    }

    const entries = ctx.sessionManager.getBranch();
    const messageCount = getMessageEntries(entries).length;

    if (source === "automatic") {
      if (
        automaticAttempted ||
        hasAutomaticAttempt(ctx.sessionManager.getEntries()) ||
        hasExplicitName(entries, pi.getSessionName()) ||
        !currentMessage ||
        !meaningfulUserInput(entries)
      ) {
        return { status: "skipped", usageAttached: false };
      }
    }

    if (activeRun) {
      return source === "automatic"
        ? { status: "skipped", usageAttached: false }
        : {
            status: "busy",
            usageAttached: false,
            diagnostic: "Session Summary is already running",
          };
    }

    const token = Symbol("session-summary-run");
    const controller = new AbortController();
    activeRun = {
      token,
      sessionId: capturedSessionId,
      generation: capturedGeneration,
      source,
      controller,
    };

    try {
      if (source === "automatic") {
        automaticAttempted = true;
        try {
          pi.appendEntry(AUTO_ATTEMPT_CUSTOM_TYPE, { version: 1, messageCount });
        } catch {
          return {
            status: "failure",
            usageAttached: false,
            diagnostic: "The automatic title attempt could not be recorded",
          };
        }
      }

      const result = await generateTitle(
        ctx,
        entries,
        source === "manual" ? "" : lastSummary,
        source === "manual" ? 0 : lastSummaryMessageCount,
        profiles,
        pinnedModels,
        source === "automatic" && currentMessage
          ? {
              conversation: automaticConversation(entries, currentMessage),
              signal: controller.signal,
            }
          : { forceFull: true, signal: controller.signal },
      );

      if (!isCurrentSession(capturedSessionId, capturedGeneration)) {
        return { status: "skipped", usageAttached: false };
      }

      if (result.provider && result.model && result.title) {
        pinnedModels.set(result.provider, result.model);
      }

      const usageAttached = false;
      const usageAttachment = undefined;
      const manualNameWon =
        source === "automatic" &&
        Boolean(result.title) &&
        hasExplicitName(ctx.sessionManager.getBranch(), pi.getSessionName());
      const persistedResult = manualNameWon ? { ...result, title: undefined } : result;
      let persistenceDiagnostic: string | undefined;
      try {
        persistCurrentSummary(
          pi,
          persistedResult,
          messageCount,
          source,
          usageAttached,
          usageAttachment,
        );
      } catch {
        persistenceDiagnostic = "The session title result could not be saved";
      }

      addAttemptUsage(summaryUsage, result.attempts);
      if (result.usage) notifyUsageChanged(pi);

      if (persistenceDiagnostic) {
        return {
          status: "failure",
          diagnostic: persistenceDiagnostic,
          usage: result.usage,
          usageAttached,
        };
      }
      if (manualNameWon) {
        return { status: "skipped", usage: result.usage, usageAttached };
      }
      if (!result.title) {
        return {
          status: "failure",
          diagnostic: result.diagnostic ?? "The active provider returned no title",
          usage: result.usage,
          usageAttached,
        };
      }

      lastSummary = result.title;
      lastSummaryMessageCount = messageCount;
      return { status: "success", title: result.title, usage: result.usage, usageAttached };
    } finally {
      releaseRun(token);
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    activeRun?.controller.abort();
    runtimeActive = true;
    sessionGeneration += 1;
    const capturedGeneration = sessionGeneration;
    const nextSessionId = ctx.sessionManager.getSessionId();
    sessionId = nextSessionId;
    activeRun = undefined;
    pinnedModels = new Map();

    const branch = ctx.sessionManager.getBranch();
    const latest = getLatestSuccessfulSummary(branch);
    lastSummary = latest?.name ?? "";
    lastSummaryMessageCount = latest?.messageCount ?? 0;
    const allEntries = ctx.sessionManager.getEntries();
    automaticAttempted = hasAutomaticAttempt(allEntries);
    summaryUsage = getSummaryUsage(allEntries);

    const loadedProfiles = await loadSessionSummaryProfiles({
      cwd: ctx.cwd,
      trusted: typeof ctx.isProjectTrusted === "function" && ctx.isProjectTrusted(),
    });
    if (!isCurrentSession(nextSessionId, capturedGeneration)) return;
    profiles = loadedProfiles;
    notifyUsageChanged(pi);
  });

  pi.on("session_shutdown", () => {
    activeRun?.controller.abort();
    runtimeActive = false;
    sessionGeneration += 1;
    activeRun = undefined;
  });

  pi.on("agent_end", async (event, ctx) => {
    if (ctx.mode !== "tui" || sessionId !== ctx.sessionManager.getSessionId()) return;
    const message = [...event.messages]
      .reverse()
      .find((candidate): candidate is AssistantMessage => candidate.role === "assistant");
    if (message?.stopReason !== "stop") return;
    if (message.content.some((content) => content.type === "toolCall")) return;

    const result = await updateCurrentSession(ctx, "automatic", message);
    if (result.status === "failure" && ctx.hasUI) {
      ctx.ui.notify(`Session title unavailable: ${result.diagnostic}`, "warning");
    }
  });

  pi.registerCommand("session-summary", {
    description: "Generate or refresh the current session title shown by /resume",
    handler: async (_args, ctx) => {
      const result = await updateCurrentSession(ctx, "manual");
      if ((result.status === "busy" || result.status === "failure") && ctx.hasUI) {
        ctx.ui.notify(result.diagnostic ?? "The session title could not be generated", "warning");
      }
    },
  });

  pi.registerCommand("session-summary-cost", {
    description: "Show session-summary usage and cost by model",
    handler: async (_args, ctx) => {
      ctx.ui.notify(costReport(summaryUsage), "info");
    },
  });

  pi.registerCommand("session-summaries", {
    description: "Backfill titles for unnamed sessions in the current project",
    handler: async (_args, ctx) => {
      if (process.env.PI_SESSION_SUMMARY === "off") return;

      const capturedSessionId = sessionId;
      const capturedGeneration = sessionGeneration;
      if (!capturedSessionId || !isCurrentSession(capturedSessionId, capturedGeneration)) return;
      if (activeRun) {
        if (ctx.hasUI) ctx.ui.notify("Session Summary is already running", "warning");
        return;
      }

      const token = Symbol("session-summary-backfill");
      const controller = new AbortController();
      activeRun = {
        token,
        sessionId: capturedSessionId,
        generation: capturedGeneration,
        source: "backfill",
        controller,
      };
      try {
        let sessions: Awaited<ReturnType<typeof SessionManager.list>>;
        try {
          sessions = await SessionManager.list(ctx.cwd, ctx.sessionManager.getSessionDir());
        } catch {
          if (isCurrentSession(capturedSessionId, capturedGeneration) && ctx.hasUI) {
            ctx.ui.notify("Could not list sessions for title backfill", "warning");
          }
          return;
        }
        if (!isCurrentSession(capturedSessionId, capturedGeneration)) return;

        const currentPath = ctx.sessionManager.getSessionFile();
        const unnamed = sessions.filter((session) => !session.name && session.path !== currentPath);
        if (unnamed.length === 0) return;

        const failures: string[] = [];
        let usageChanged = false;
        for (const [index, session] of unnamed.entries()) {
          if (!isCurrentSession(capturedSessionId, capturedGeneration)) return;
          let failure: string | undefined;
          try {
            const manager = SessionManager.open(session.path, ctx.sessionManager.getSessionDir());
            const branch = manager.getBranch();
            const existing = getLatestSuccessfulSummary(branch);
            const result = await generateTitle(
              ctx,
              branch,
              existing?.name ?? "",
              existing?.messageCount ?? 0,
              profiles,
              pinnedModels,
              { forceFull: true, signal: controller.signal },
            );
            if (!isCurrentSession(capturedSessionId, capturedGeneration)) return;

            const messageCount = getMessageEntries(branch).length;
            addAttemptUsage(summaryUsage, result.attempts);
            if (result.usage) usageChanged = true;
            if (result.provider && result.model && result.title) {
              pinnedModels.set(result.provider, result.model);
            }
            if (result.title) {
              try {
                manager.appendSessionInfo(result.title);
              } catch {
                failure = "the generated title could not be saved";
              }
            } else {
              failure = result.diagnostic ?? "the provider returned no title";
            }
            if (result.title || result.attempts.length > 0) {
              try {
                manager.appendCustomEntry(
                  CUSTOM_TYPE,
                  persistedSummaryData(result, messageCount, "backfill", false),
                );
              } catch {
                failure ??= "the title usage record could not be saved";
              }
            }
          } catch {
            failure = "the session could not be read or updated";
          }
          if (failure) failures.push(`Session ${index + 1}: ${failure}`);
        }

        if (usageChanged) notifyUsageChanged(pi);
        if (failures.length > 0 && ctx.hasUI) {
          ctx.ui.notify(backfillFailureMessage(failures, unnamed.length), "warning");
        }
      } finally {
        releaseRun(token);
      }
    },
  });
}
