import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { loadCopilotSnapshots, recordCopilotSnapshot } from "../../shared/copilot-snapshots.js";
import { mergeCodexUsage, parseCodexUsageHeaders } from "./codex-client.js";
import { copilotDailyPacePercent } from "./copilot-pace.js";
import { formatCodexUsage, formatUsageDetailed } from "./format.js";
import {
  fetchProviderUsage,
  isCopilotUsageModel,
  providerLabel,
  usageProviderForModel,
} from "./provider.js";
import type { CopilotQuota, UsageMeterOptions, UsageProvider, UsageSnapshot } from "./types.js";

const defaultCopilotRefreshMs = 30_000;
const defaultCodexRefreshMs = 60_000;
export const usageStatusKey = "pi-extensions:usage-meter";

export type { CopilotCreditSnapshot } from "../../shared/copilot-snapshots.js";
export {
  codexUsageUrl,
  fetchCodexUsage,
  mergeCodexUsage,
  parseCodexUsage,
  parseCodexUsageHeaders,
} from "./codex-client.js";
export { fetchCopilotQuota } from "./copilot-client.js";
export {
  copilotDailyPace,
  copilotDailyPacePercent,
  daysInMonth,
  monthToDateWorkdays,
  workdaysInMonth,
} from "./copilot-pace.js";
export { parseCopilotQuota } from "./copilot-quota.js";
export {
  formatCodexUsage,
  formatCodexUsageDetailed,
  formatCodexWindowLabel,
  formatCopilotQuota,
  formatCopilotQuotaDetailed,
  formatUsage,
  formatUsageDetailed,
} from "./format.js";
export type {
  FetchProviderUsageOptions,
  ProviderUsageResult,
  UsageModel,
  UsageModelRegistry,
} from "./provider.js";
export {
  fetchProviderUsage,
  getUsageProvider,
  isCodexModel,
  isCodexProvider,
  isCodexUsageModel,
  isCopilotModel,
  isCopilotProvider,
  isCopilotUsageModel,
  providerForModel,
  providerLabel,
  usageProviderForModel,
} from "./provider.js";
export type {
  CodexAdditionalRateLimit,
  CodexCredits,
  CodexRateLimit,
  CodexSpendControl,
  CodexSpendLimit,
  CodexUsage,
  CodexUsageWindow,
  CopilotQuota,
  UsageMeterOptions,
  UsageProvider,
  UsageSnapshot,
} from "./types.js";

/** Format the Copilot footer quota without changing non-AI-credit output. */
export function formatCopilotQuotaFooter(
  quota: CopilotQuota,
  dailyPercent: number | undefined,
): string {
  if (quota.unlimited) return "unlimited AI credits";
  const daily =
    quota.unit === "ai_credits"
      ? `daily: ${dailyPercent === undefined ? "—" : `${dailyPercent}%`} · `
      : "";
  return `${daily}${quota.remaining.toLocaleString("en-US")}${quota.total === undefined ? "" : `/${quota.total.toLocaleString("en-US")}`}${quota.percentRemaining === undefined ? "" : ` (${Math.round(quota.percentRemaining)}% left)`}`;
}

type FooterData = {
  getGitBranch(): string | null;
  getExtensionStatuses(): ReadonlyMap<string, string>;
  getAvailableProviderCount(): number;
};

function renderUsageFooter(
  pi: ExtensionAPI,
  activeContext: ExtensionContext,
  theme: ExtensionContext["ui"]["theme"],
  footerData: FooterData,
  width: number,
  provider: UsageProvider,
  snapshot: UsageSnapshot | undefined,
  copilotDailyPercent: number | undefined,
): string[] {
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let cost = 0;
  for (const entry of activeContext.sessionManager.getEntries()) {
    const record =
      entry.type === "message"
        ? (entry.message as unknown as Record<string, unknown>)
        : (entry as unknown as Record<string, unknown>);
    if (
      entry.type !== "message" &&
      entry.type !== "compaction" &&
      entry.type !== "branch_summary" &&
      !(entry.type === "custom" && entry.customType === "session-summary")
    )
      continue;
    const usage = usageFromRecord(record);
    input += usage.input;
    output += usage.output;
    cacheRead += usage.cacheRead;
    cacheWrite += usage.cacheWrite;
    cost += usage.cost;
  }
  let pwd = activeContext.sessionManager.getCwd();
  const home = process.env.HOME || process.env.USERPROFILE;
  if (home && pwd.startsWith(home)) pwd = `~${pwd.slice(home.length)}`;
  const branch = footerData.getGitBranch();
  if (branch) pwd = `${pwd} (${branch})`;

  const stats: string[] = [];
  if (input) stats.push(`↑${formatTokens(input)}`);
  if (output) stats.push(`↓${formatTokens(output)}`);
  if (cacheRead) stats.push(`R${formatTokens(cacheRead)}`);
  if (cacheWrite) stats.push(`W${formatTokens(cacheWrite)}`);
  const model = activeContext.model;
  if (cost || (model && activeContext.modelRegistry.isUsingOAuth(model))) {
    stats.push(
      `$${cost.toFixed(3)}${model && activeContext.modelRegistry.isUsingOAuth(model) ? " (sub)" : ""}`,
    );
  }
  const contextUsage = activeContext.getContextUsage();
  const contextWindow = contextUsage?.contextWindow ?? model?.contextWindow ?? 0;
  const contextPercent = contextUsage?.percent;
  const contextText =
    contextPercent === null || contextPercent === undefined
      ? `?/${formatTokens(contextWindow)}`
      : `${contextPercent.toFixed(1)}%/${formatTokens(contextWindow)}`;
  stats.push(
    contextPercent !== undefined && contextPercent !== null && contextPercent > 90
      ? theme.fg("error", contextText)
      : contextPercent !== undefined && contextPercent !== null && contextPercent > 70
        ? theme.fg("warning", contextText)
        : contextText,
  );
  let left = stats.join(" ");
  let leftWidth = visibleWidth(left);
  if (leftWidth > width) {
    left = truncateToWidth(left, width, "...");
    leftWidth = visibleWidth(left);
  }

  const modelName = model?.id || "no-model";
  let right = modelName;
  if (model?.reasoning) {
    const level = pi.getThinkingLevel() || "off";
    right = level === "off" ? `${modelName} • thinking off` : `${modelName} • ${level}`;
  }
  if (footerData.getAvailableProviderCount() > 1 && model) {
    const withProvider = `(${model.provider}) ${right}`;
    if (leftWidth + 2 + visibleWidth(withProvider) <= width) right = withProvider;
  }
  const rightWidth = visibleWidth(right);
  const statsLine =
    leftWidth + 2 + rightWidth <= width
      ? `${left}${" ".repeat(width - leftWidth - rightWidth)}${right}`
      : left;

  let usageText = "usage unavailable";
  let usageColor: "dim" | "warning" | "error" = "dim";
  if (snapshot?.provider === provider) {
    if (snapshot.provider === "github-copilot") {
      const quota = snapshot.quota;
      usageText = formatCopilotQuotaFooter(quota, copilotDailyPercent);
      if ((quota.percentRemaining ?? 100) <= 5) usageColor = "error";
    } else if (snapshot.provider === "openai-codex") {
      usageText = formatCodexUsage(snapshot.usage).replace(/^Codex:\s*/, "");
      const windows = [snapshot.usage.primaryWindow, snapshot.usage.secondaryWindow];
      if (snapshot.usage.limitReached || windows.some((window) => (window?.usedPercent ?? 0) >= 95))
        usageColor = "error";
      else if (windows.some((window) => (window?.usedPercent ?? 0) >= 75)) usageColor = "warning";
    }
  }
  const statuses = Array.from(footerData.getExtensionStatuses().entries())
    .filter(([key]) => key !== usageStatusKey)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, text]) => sanitizeStatusText(text));
  return [
    truncateToWidth(theme.fg("dim", pwd), width, theme.fg("dim", "...")),
    theme.fg("dim", left) + theme.fg("dim", statsLine.slice(left.length)),
    ...(statuses.length
      ? [truncateToWidth(statuses.join(" "), width, theme.fg("dim", "..."))]
      : []),
    rightAlign(theme.fg(usageColor, usageText), width, theme.fg("dim", "...")),
  ];
}

export function registerUsageMeter(pi: ExtensionAPI, options: UsageMeterOptions = {}): void {
  let ctx: ExtensionContext | undefined;
  let provider: UsageProvider | undefined;
  let generation = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  let cached: UsageSnapshot | undefined;
  let copilotDailyPercent: number | undefined;
  const inFlight = new Map<UsageProvider, Promise<UsageSnapshot | undefined>>();
  const lastRefresh = new Map<UsageProvider, number>();
  let footerRequestRender: (() => void) | undefined;

  const intervalFor = (value: UsageProvider): number =>
    value === "github-copilot"
      ? (options.copilotRefreshIntervalMs ?? defaultCopilotRefreshMs)
      : (options.codexRefreshIntervalMs ?? defaultCodexRefreshMs);

  const clearStatus = (): void => ctx?.ui.setStatus(usageStatusKey, undefined);
  const clearFooter = (): void => {
    ctx?.ui.setFooter(undefined);
    footerRequestRender = undefined;
  };
  const clearTimer = (): void => {
    if (timer) clearInterval(timer);
    timer = undefined;
  };

  const bindFooter = (activeContext: ExtensionContext): void => {
    clearFooter();
    if (!provider) return;
    activeContext.ui.setFooter((tui, theme, footerData) => {
      footerRequestRender = () => tui.requestRender();
      return {
        render: (width: number) =>
          renderUsageFooter(
            pi,
            activeContext,
            theme,
            footerData,
            width,
            provider!,
            cached?.provider === provider ? cached : undefined,
            copilotDailyPercent,
          ),
        invalidate: () => {},
      };
    });
  };

  const refresh = (force = false): Promise<UsageSnapshot | undefined> => {
    if (!ctx || !provider) return Promise.resolve(undefined);
    const activeContext = ctx;
    const activeProvider = provider;
    const activeGeneration = generation;
    const now = Date.now();
    if (!force && now - (lastRefresh.get(activeProvider) ?? 0) < intervalFor(activeProvider))
      return Promise.resolve(cached?.provider === activeProvider ? cached : undefined);
    lastRefresh.set(activeProvider, now);
    let request = inFlight.get(activeProvider);
    if (!request) {
      request = fetchProviderUsage(activeContext.model, activeContext.modelRegistry, {
        fetchCopilotQuota: options.fetchCopilotQuota,
        fetchCodexUsage: options.fetchCodexUsage,
      })
        .then((result) => result?.snapshot)
        .catch(() => undefined)
        .finally(() => {
          if (inFlight.get(activeProvider) === request) inFlight.delete(activeProvider);
        });
      inFlight.set(activeProvider, request);
    }
    return request.then((snapshot) => {
      if (ctx !== activeContext || provider !== activeProvider || generation !== activeGeneration)
        return snapshot;
      copilotDailyPercent = undefined;
      cached = snapshot;
      if (snapshot) {
        clearStatus();
        footerRequestRender?.();
      } else clearStatus();
      if (snapshot?.provider === "github-copilot") {
        const now = options.now?.() ?? new Date();
        const env = options.copilotSnapshotEnv ?? process.env;
        void (async () => {
          await recordCopilotSnapshot(snapshot.quota, env, now);
          const snapshots = await loadCopilotSnapshots(env);
          if (
            ctx !== activeContext ||
            provider !== activeProvider ||
            generation !== activeGeneration
          )
            return;
          copilotDailyPercent = copilotDailyPacePercent(snapshot.quota, snapshots, now);
          footerRequestRender?.();
        })().catch(() => {});
      }
      return snapshot;
    });
  };

  const activate = (next: ExtensionContext): void => {
    generation += 1;
    ctx = next;
    provider = usageProviderForModel(next.model);
    cached = undefined;
    copilotDailyPercent = undefined;
    clearTimer();
    clearStatus();
    bindFooter(next);
    if (!provider) return;
    void refresh(true);
    timer = setInterval(() => void refresh(), intervalFor(provider));
  };

  pi.on("session_start", (_event, next) => activate(next));
  pi.on("model_select", (_event, next) => activate(next));
  pi.on("agent_end", (_event, next) => {
    if (isCopilotUsageModel(next.model) && provider === "github-copilot") void refresh();
  });
  pi.on("tool_result", (_event, next) => {
    if (isCopilotUsageModel(next.model) && provider === "github-copilot") void refresh();
  });
  pi.on("after_provider_response", (event, next) => {
    if (!ctx || provider !== "openai-codex" || usageProviderForModel(next.model) !== "openai-codex")
      return;
    const update = parseCodexUsageHeaders(event.headers);
    if (!update || generation < 1) return;
    const previous = cached?.provider === "openai-codex" ? cached.usage : undefined;
    const usage = mergeCodexUsage(previous, update);
    cached = { provider: "openai-codex", usage };
    clearStatus();
    footerRequestRender?.();
  });
  pi.on("session_shutdown", () => {
    generation += 1;
    clearTimer();
    clearStatus();
    clearFooter();
    ctx = undefined;
    provider = undefined;
    cached = undefined;
    copilotDailyPercent = undefined;
  });
  pi.registerCommand("usage-meter", {
    description: "Refresh active GitHub Copilot or OpenAI Codex usage details.",
    handler: async (_args, next) => {
      const nextProvider = usageProviderForModel(next.model);
      if (!nextProvider)
        return void next.ui.notify(
          "Usage meter supports active github-copilot and openai-codex models only.",
          "info",
        );
      if (ctx !== next || provider !== nextProvider) activate(next);
      else ctx = next;
      const snapshot = await refresh(true);
      next.ui.notify(
        snapshot
          ? formatUsageDetailed(
              snapshot.provider,
              "quota" in snapshot ? snapshot.quota : snapshot.usage,
            )
          : `${providerLabel(nextProvider)} usage unavailable.`,
        "info",
      );
    },
  });
}

function sanitizeStatusText(text: string): string {
  return text
    .replace(/[\r\n\t]/g, " ")
    .replace(/ +/g, " ")
    .trim();
}

function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10_000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
  if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  return `${Math.round(count / 1_000_000)}M`;
}

function rightAlign(text: string, width: number, ellipsis: string): string {
  const truncated = truncateToWidth(text, width, ellipsis);
  return `${" ".repeat(Math.max(0, width - visibleWidth(truncated)))}${truncated}`;
}

function usageFromRecord(record: Record<string, unknown>): {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
} {
  const usage = record.usage;
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) {
    return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  }
  const value = usage as Record<string, unknown>;
  const number = (candidate: unknown): number =>
    typeof candidate === "number" && Number.isFinite(candidate) ? candidate : 0;
  const cost = value.cost;
  const totalCost =
    typeof cost === "object" && cost !== null && !Array.isArray(cost)
      ? number((cost as Record<string, unknown>).total)
      : number(cost);
  return {
    input: number(value.input),
    output: number(value.output),
    cacheRead: number(value.cacheRead),
    cacheWrite: number(value.cacheWrite),
    cost: totalCost,
  };
}

export default function usageMeterExtension(pi: ExtensionAPI): void {
  registerUsageMeter(pi);
}
