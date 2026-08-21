/**
 * Give sessions a useful one-line title in /resume.
 *
 * Pi's session picker displays session_info names instead of the first user
 * message. This extension uses the active provider to generate a short title
 * after each settled turn and stores it as the session name.
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
const CONFIG_FILE = "pi-session-summary.json";
const MAX_TRANSCRIPT_CHARS = 80_000;
const MAX_TITLE_CHARS = 140;
const MAX_OUTPUT_TOKENS = 800;
const SUMMARY_TIMEOUT_MS = 20_000;
const RESUMMARIZE_TOKEN_THRESHOLD = 20_000;
const STATUS_KEY = "session-summary";
const USAGE_CHANGED_EVENT = "pi-tools:session-summary-usage";
const TRANSCRIPT_TOKEN_RATIO = 4;
const REQUEST_OVERHEAD_CHARS = 256;
const MAX_DIAGNOSTIC_CHARS = 600;
const MAX_DIAGNOSTIC_ATTEMPTS = 4;
const LEGACY_MODEL_LABEL = "github-copilot/gpt-5.6-luna";

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

type AutoSummaryData = {
  name?: string;
  messageCount: number;
  provider?: string;
  model?: string;
  attempts?: SummaryAttempt[];
  usage?: Usage;
  usageAttached?: boolean;
  usageAttachment?: UsageAttachment;
};

type SummaryUpdate = {
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
    .replace(/[\r\n\t]+/g, " ")
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

function getLatestSessionInfo(
  entries: SessionEntry[],
): Extract<SessionEntry, { type: "session_info" }> | undefined {
  return [...entries]
    .reverse()
    .find((entry): entry is Extract<SessionEntry, { type: "session_info" }> => {
      return entry.type === "session_info";
    });
}

function getLatestAutoSummary(entries: SessionEntry[]): AutoSummaryData | undefined {
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

  const auto = getLatestAutoSummary(entries);
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
  pinnedModels: Map<string, string>,
  onAttempt?: (label: string) => void,
): Promise<TitleResult> {
  const tokenEstimate = (text: string) => Math.ceil(text.length / TRANSCRIPT_TOKEN_RATIO);
  const previousConversation = serializeConversationText(entries, lastSummaryMessageCount);
  if (!previousConversation)
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
    !previousSummary || tokenEstimate(previousConversation) >= RESUMMARIZE_TOKEN_THRESHOLD;
  const conversation = shouldResummarize ? fullConversation : previousConversation;
  const attempts: SummaryAttempt[] = [];
  const controller = new AbortController();
  const deadline = Date.now() + SUMMARY_TIMEOUT_MS;
  const timeout = setTimeout(() => controller.abort(), SUMMARY_TIMEOUT_MS);

  try {
    for (const candidate of candidates) {
      if (controller.signal.aborted || Date.now() >= deadline) break;
      const label = `${provider}/${candidate}`;
      onAttempt?.(label);
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
      pinnedModels.set(provider, candidate);
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
  usageAttached: boolean,
  usageAttachment?: UsageAttachment,
): AutoSummaryData {
  return {
    ...(result.title ? { name: result.title } : {}),
    messageCount,
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
  usageAttached: boolean,
  usageAttachment?: UsageAttachment,
): void {
  if (result.title) pi.setSessionName(result.title);
  if (result.title || result.attempts.length > 0) {
    pi.appendEntry(
      CUSTOM_TYPE,
      persistedSummaryData(result, messageCount, usageAttached, usageAttachment),
    );
  }
}

function notifyUsageChanged(pi: ExtensionAPI): void {
  pi.events.emit(USAGE_CHANGED_EVENT, undefined);
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
  let summarizing = false;
  let sessionId: string | undefined;
  let lastSummary = "";
  let lastSummaryMessageCount = 0;
  let summaryUsage = createUsageLedger();
  let profiles: SessionSummaryProfiles = BUILTIN_PROFILES;
  const pinnedModels = new Map<string, string>();

  async function updateCurrentSession(
    ctx: ExtensionContext,
    force: boolean,
    currentMessage?: AssistantMessage,
  ): Promise<SummaryUpdate | undefined> {
    if (summarizing) return undefined;
    if (process.env.PI_SESSION_SUMMARY === "off") return undefined;

    const branch = ctx.sessionManager.getBranch();
    const entries: SessionEntry[] = currentMessage
      ? [
          ...branch,
          {
            type: "message",
            id: "session-summary-current-message",
            parentId: branch.at(-1)?.id ?? null,
            timestamp: new Date().toISOString(),
            message: currentMessage,
          },
        ]
      : branch;
    const messageCount = getMessageEntries(entries).length;
    const currentName = pi.getSessionName();
    const auto = getLatestAutoSummary(entries);

    if (!force) {
      if (hasExplicitName(entries, currentName)) return undefined;
      if (messageCount < 2 || messageCount === lastSummaryMessageCount) return undefined;
      if (auto?.messageCount === messageCount && currentName === auto.name) {
        return { title: auto.name, usage: undefined, usageAttached: false };
      }
    }

    summarizing = true;
    let diagnosticShown = false;
    const setAttemptStatus = (label: string) => {
      if (ctx.hasUI) {
        ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("muted", `summary prompt fired (${label})…`));
      }
    };
    try {
      const result = await generateTitle(
        ctx,
        entries,
        lastSummary,
        lastSummaryMessageCount,
        profiles,
        pinnedModels,
        setAttemptStatus,
      );
      const usageAttached = Boolean(currentMessage && result.usage);
      const usageAttachment =
        usageAttached && currentMessage
          ? {
              messageTimestamp: currentMessage.timestamp,
              provider: currentMessage.provider,
              model: currentMessage.model,
            }
          : undefined;
      persistCurrentSummary(pi, result, messageCount, usageAttached, usageAttachment);
      addAttemptUsage(summaryUsage, result.attempts);
      if (result.usage) notifyUsageChanged(pi);

      if (!result.title) {
        const diagnostic = result.diagnostic ?? "The active provider returned no title";
        if (ctx.hasUI) {
          ctx.ui.setStatus(
            STATUS_KEY,
            ctx.ui.theme.fg("warning", `summary unavailable: ${diagnostic}`),
          );
          diagnosticShown = true;
        }
        return { diagnostic, usage: result.usage, usageAttached };
      }

      lastSummary = result.title;
      lastSummaryMessageCount = messageCount;
      return { title: result.title, usage: result.usage, usageAttached };
    } catch {
      const diagnostic = "The session summary could not persist its result";
      if (ctx.hasUI) {
        ctx.ui.setStatus(
          STATUS_KEY,
          ctx.ui.theme.fg("warning", `summary unavailable: ${diagnostic}`),
        );
        diagnosticShown = true;
      }
      return { diagnostic, usageAttached: false };
    } finally {
      summarizing = false;
      if (ctx.hasUI && !diagnosticShown) ctx.ui.setStatus(STATUS_KEY, undefined);
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    const nextSessionId = ctx.sessionManager.getSessionId();
    if (sessionId !== nextSessionId) pinnedModels.clear();
    sessionId = nextSessionId;
    const entries = ctx.sessionManager.getBranch();
    const auto = getLatestAutoSummary(entries);
    lastSummary = auto?.name ?? "";
    lastSummaryMessageCount = auto?.messageCount ?? 0;
    summaryUsage = getSummaryUsage(ctx.sessionManager.getEntries());
    profiles = await loadSessionSummaryProfiles({
      cwd: ctx.cwd,
      trusted: typeof ctx.isProjectTrusted === "function" && ctx.isProjectTrusted(),
    });
    if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
    notifyUsageChanged(pi);
  });

  pi.on("message_end", async (event, ctx) => {
    if (ctx.mode !== "tui" || sessionId !== ctx.sessionManager.getSessionId()) return;
    if (event.message.role !== "assistant") return;
    if (event.message.content.some((content) => content.type === "toolCall")) return;

    const result = await updateCurrentSession(ctx, false, event.message);
    if (!result?.usage || !result.usageAttached) return;

    return {
      message: {
        ...event.message,
        usage: mergeUsage(event.message.usage, result.usage),
      },
    };
  });

  pi.registerCommand("session-summary", {
    description: "Generate or refresh the current session title shown by /resume",
    handler: async (_args, ctx) => {
      const result = await updateCurrentSession(ctx, true);
      if (ctx.hasUI && !result?.title) {
        ctx.ui.notify(
          `Could not generate a session summary${result?.diagnostic ? `: ${result.diagnostic}` : ""}`,
          "warning",
        );
      } else if (result?.title && ctx.hasUI) {
        ctx.ui.notify(`Session title: ${result.title}`, "info");
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

      const currentPath = ctx.sessionManager.getSessionFile();
      const sessions = await SessionManager.list(ctx.cwd, ctx.sessionManager.getSessionDir());
      const unnamed = sessions.filter((session) => !session.name && session.path !== currentPath);
      if (unnamed.length === 0) {
        if (ctx.hasUI) ctx.ui.notify("No unnamed sessions found in this project", "info");
        return;
      }

      let updated = 0;
      for (const [index, session] of unnamed.entries()) {
        try {
          const manager = SessionManager.open(session.path, ctx.sessionManager.getSessionDir());
          const branch = manager.getBranch();
          const existing = getLatestAutoSummary(branch);
          const result = await generateTitle(
            ctx,
            branch,
            existing?.name ?? "",
            existing?.messageCount ?? 0,
            profiles,
            pinnedModels,
            (label) => {
              if (ctx.hasUI) {
                ctx.ui.setStatus(
                  STATUS_KEY,
                  ctx.ui.theme.fg(
                    "muted",
                    `summary prompt fired (${label}) for session ${index + 1}/${unnamed.length}…`,
                  ),
                );
              }
            },
          );
          const messageCount = getMessageEntries(branch).length;
          if (result.title) {
            manager.appendSessionInfo(result.title);
            updated += 1;
          }
          if (result.title || result.attempts.length > 0) {
            manager.appendCustomEntry(
              CUSTOM_TYPE,
              persistedSummaryData(result, messageCount, false),
            );
          }
          addAttemptUsage(summaryUsage, result.attempts);
        } catch {
          // One unreadable or unauthenticated session must not stop the batch.
        }
      }
      notifyUsageChanged(pi);
      if (ctx.hasUI) {
        ctx.ui.setStatus(STATUS_KEY, undefined);
        ctx.ui.notify(
          `Added summaries to ${updated} of ${unnamed.length} unnamed sessions`,
          "info",
        );
      }
    },
  });
}
