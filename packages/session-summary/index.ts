/**
 * Give sessions a useful one-line title in /resume.
 *
 * Pi's session picker displays session_info names instead of the first user
 * message. This extension asks the configured Luna model for a short title
 * after each settled turn and stores it as the session name.
 */

import type { AssistantMessage, Message, ProviderHeaders, Usage } from "@earendil-works/pi-ai";
import {
  convertToLlm,
  type ExtensionAPI,
  type ExtensionContext,
  type SessionEntry,
  SessionManager,
  serializeConversation,
} from "@earendil-works/pi-coding-agent";

const CUSTOM_TYPE = "session-summary";
const SUMMARY_PROVIDER = "github-copilot";
const SUMMARY_MODEL = "gpt-5.6-luna";
const MAX_TRANSCRIPT_CHARS = 80_000;
const MAX_TITLE_CHARS = 140;
const MAX_OUTPUT_TOKENS = 800;
const SUMMARY_TIMEOUT_MS = 20_000;
const RESUMMARIZE_TOKEN_THRESHOLD = 20_000;
const STATUS_KEY = "session-summary";
const USAGE_CHANGED_EVENT = "pi-tools:session-summary-usage";

const SUMMARY_SYSTEM_PROMPT = [
  "You create concise titles for coding-agent sessions.",
  "Return only one plain-text line, with no markdown, quotes, or prefix.",
  `Keep it under ${MAX_TITLE_CHARS} characters. Mention the main task and, when useful, its current state or next step.`,
].join(" ");

type AutoSummaryData = {
  name: string;
  messageCount: number;
  usage?: Usage;
  usageAttached?: boolean;
};

type SummaryUpdate = {
  title?: string;
  usage?: Usage;
  usageAttached: boolean;
  diagnostic?: string;
};

type TitleResult = {
  title?: string;
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

function createUsageTotals(): UsageTotals {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 };
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
  const current = base ?? {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  return {
    ...current,
    input: current.input + extra.input,
    output: current.output + extra.output,
    cacheRead: current.cacheRead + extra.cacheRead,
    cacheWrite: current.cacheWrite + extra.cacheWrite,
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

function formatCost(cost: number): string {
  return `$${cost.toFixed(4)}`;
}

function truncateTranscript(text: string): string {
  if (text.length <= MAX_TRANSCRIPT_CHARS) return text;

  const firstChars = Math.floor(MAX_TRANSCRIPT_CHARS * 0.4);
  const lastChars = MAX_TRANSCRIPT_CHARS - firstChars;
  return `${text.slice(0, firstChars)}\n\n[...middle of conversation omitted...]\n\n${text.slice(-lastChars)}`;
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

function buildConversationText(entries: SessionEntry[], fromMessage = 0): string {
  const messages = getMessageEntries(entries)
    .slice(fromMessage)
    .map((entry) => entry.message);

  if (messages.length === 0) return "";
  return truncateTranscript(serializeConversation(convertToLlm(messages)).trim());
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
    if (!data || typeof data !== "object") return undefined;
    const candidate = data as Partial<AutoSummaryData>;
    if (typeof candidate.name !== "string" || typeof candidate.messageCount !== "number")
      return undefined;
    return {
      name: candidate.name,
      messageCount: candidate.messageCount,
      usage: candidate.usage,
      usageAttached: candidate.usageAttached,
    };
  }
  return undefined;
}

function getSummaryUsage(entries: SessionEntry[]): UsageTotals {
  const totals = createUsageTotals();
  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== CUSTOM_TYPE) continue;
    const usage = (entry.data as Partial<AutoSummaryData> | undefined)?.usage;
    if (usage) addUsage(totals, usage);
  }
  return totals;
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

export function buildSessionSummaryRequest(
  model: NonNullable<ExtensionContext["model"]>,
  auth: Auth,
): { model: NonNullable<ExtensionContext["model"]>; auth: Auth } {
  const baseUrl = auth.baseUrl;
  const requestModel = baseUrl && baseUrl !== model.baseUrl ? { ...model, baseUrl } : model;
  return { model: requestModel, auth };
}

type SummaryRequest = { model: NonNullable<ExtensionContext["model"]>; auth: Auth };

type SummaryResolution = SummaryRequest | { diagnostic: string };

const summaryModelLabel = `${SUMMARY_PROVIDER}/${SUMMARY_MODEL}`;

async function resolveAuth(ctx: ExtensionContext): Promise<SummaryResolution> {
  const model = ctx.modelRegistry.find(SUMMARY_PROVIDER, SUMMARY_MODEL);
  if (!model) {
    return { diagnostic: `${summaryModelLabel} is unavailable` };
  }

  try {
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok) {
      return { diagnostic: `${summaryModelLabel} authentication is unavailable` };
    }
    return buildSessionSummaryRequest(model, auth);
  } catch {
    return { diagnostic: `${summaryModelLabel} authentication is unavailable` };
  }
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

function noFinalTextDiagnostic(response: AssistantMessage): string {
  return `${summaryModelLabel} returned no final text (stop: ${response.stopReason}; content: ${summarizeContent(response.content)})`;
}

function completionFailureDiagnostic(signal: AbortSignal): string {
  return signal.aborted
    ? `${summaryModelLabel} request timed out or was aborted`
    : `${summaryModelLabel} provider request failed`;
}

async function generateTitle(
  ctx: ExtensionContext,
  entries: SessionEntry[],
  previousSummary: string,
  lastSummaryMessageCount: number,
): Promise<TitleResult> {
  const tokenEstimate = (text: string) => Math.ceil(text.length / 4);
  const previousConversation = buildConversationText(entries, lastSummaryMessageCount);
  if (!previousConversation) return { diagnostic: "No conversation is available to summarize" };

  const fullConversation = buildConversationText(entries);
  const shouldResummarize =
    !previousSummary || tokenEstimate(previousConversation) >= RESUMMARIZE_TOKEN_THRESHOLD;
  const conversation = shouldResummarize ? fullConversation : previousConversation;
  let request: SummaryResolution;
  try {
    request = await resolveAuth(ctx);
  } catch {
    return { diagnostic: `${summaryModelLabel} model lookup failed` };
  }
  if ("diagnostic" in request) return request;

  const prompt = shouldResummarize
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

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SUMMARY_TIMEOUT_MS);
  try {
    const messages: Message[] = [
      {
        role: "user",
        content: [{ type: "text", text: prompt }],
        timestamp: Date.now(),
      },
    ];
    try {
      const response = await ctx.modelRegistry.complete(
        request.model,
        { systemPrompt: SUMMARY_SYSTEM_PROMPT, messages },
        {
          apiKey: request.auth.apiKey,
          headers: request.auth.headers,
          env: request.auth.env,
          // Keep the effort option unset for provider compatibility. The output budget
          // remains bounded so title generation cannot consume an unbounded response.
          maxTokens: MAX_OUTPUT_TOKENS,
          timeoutMs: SUMMARY_TIMEOUT_MS,
          signal: controller.signal,
        },
      );

      const title = extractTitle(
        response.content
          .filter((content): content is { type: "text"; text: string } => content.type === "text")
          .map((content) => content.text)
          .join("\n"),
      );
      if (!title) return { diagnostic: noFinalTextDiagnostic(response), usage: response.usage };

      return { title, usage: response.usage };
    } catch {
      return { diagnostic: completionFailureDiagnostic(controller.signal) };
    }
  } finally {
    clearTimeout(timeout);
  }
}

function persistAutoSummary(
  pi: ExtensionAPI,
  name: string,
  messageCount: number,
  usage: Usage | undefined,
  usageAttached: boolean,
): void {
  pi.setSessionName(name);
  pi.appendEntry(CUSTOM_TYPE, { name, messageCount, usage, usageAttached });
}

function notifyUsageChanged(pi: ExtensionAPI): void {
  pi.events.emit(USAGE_CHANGED_EVENT, undefined);
}

export default function (pi: ExtensionAPI) {
  let summarizing = false;
  let sessionId: string | undefined;
  let lastSummary = "";
  let lastSummaryMessageCount = 0;
  let summaryUsage = createUsageTotals();

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
    if (ctx.hasUI) {
      ctx.ui.setStatus(
        STATUS_KEY,
        ctx.ui.theme.fg("muted", `summary prompt fired (${summaryModelLabel})…`),
      );
    }
    try {
      const result = await generateTitle(ctx, entries, lastSummary, lastSummaryMessageCount);
      if (!result.title) {
        const diagnostic = result.diagnostic ?? `${summaryModelLabel} returned no title`;
        if (ctx.hasUI) {
          ctx.ui.setStatus(
            STATUS_KEY,
            ctx.ui.theme.fg("warning", `summary unavailable: ${diagnostic}`),
          );
          diagnosticShown = true;
        }
        return { diagnostic, usageAttached: false };
      }
      const usageAttached = Boolean(currentMessage && result.usage);
      persistAutoSummary(pi, result.title, messageCount, result.usage, usageAttached);
      lastSummary = result.title;
      lastSummaryMessageCount = messageCount;
      if (result.usage) {
        addUsage(summaryUsage, result.usage);
        notifyUsageChanged(pi);
      }
      return { title: result.title, usage: result.usage, usageAttached };
    } catch {
      const diagnostic = `${summaryModelLabel} could not persist a generated title`;
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
    sessionId = ctx.sessionManager.getSessionId();
    const entries = ctx.sessionManager.getBranch();
    const auto = getLatestAutoSummary(entries);
    lastSummary = auto?.name ?? "";
    lastSummaryMessageCount = auto?.messageCount ?? 0;
    summaryUsage = getSummaryUsage(ctx.sessionManager.getEntries());
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
    description: "Show Luna session-summary usage and cost",
    handler: async (_args, ctx) => {
      ctx.ui.notify(
        `${summaryModelLabel} | ${summaryUsage.totalTokens.toLocaleString()} tokens | cost: ${formatCost(summaryUsage.cost)} | ${summaryUsage.input.toLocaleString()} input, ${summaryUsage.output.toLocaleString()} output`,
        "info",
      );
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
        if (ctx.hasUI) {
          ctx.ui.setStatus(
            STATUS_KEY,
            ctx.ui.theme.fg(
              "muted",
              `summary prompt fired (${summaryModelLabel}) for session ${index + 1}/${unnamed.length}…`,
            ),
          );
        }
        try {
          const manager = SessionManager.open(session.path, ctx.sessionManager.getSessionDir());
          const existing = getLatestAutoSummary(manager.getBranch());
          const result = await generateTitle(
            ctx,
            manager.getBranch(),
            existing?.name ?? "",
            existing?.messageCount ?? 0,
          );
          if (result.title) {
            manager.appendSessionInfo(result.title);
            manager.appendCustomEntry(CUSTOM_TYPE, {
              name: result.title,
              messageCount: manager.getBranch().filter((entry) => entry.type === "message").length,
              usage: result.usage,
              usageAttached: false,
            });
            if (result.usage) addUsage(summaryUsage, result.usage);
            updated++;
          }
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
