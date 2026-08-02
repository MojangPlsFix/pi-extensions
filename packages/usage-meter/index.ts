import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { mergeCodexUsage, parseCodexUsageHeaders } from "./codex-client.js";
import { formatCodexUsage, formatUsage, formatUsageDetailed } from "./format.js";
import {
  fetchProviderUsage,
  isCopilotUsageModel,
  providerLabel,
  usageProviderForModel,
} from "./provider.js";
import type { UsageMeterOptions, UsageProvider, UsageSnapshot } from "./types.js";

const defaultCopilotRefreshMs = 30_000;
const defaultCodexRefreshMs = 60_000;
export const usageStatusKey = "pi-extensions:usage-meter";

export {
  codexUsageUrl,
  fetchCodexUsage,
  mergeCodexUsage,
  parseCodexUsage,
  parseCodexUsageHeaders,
} from "./codex-client.js";
export { fetchCopilotQuota } from "./copilot-client.js";
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

export function registerUsageMeter(pi: ExtensionAPI, options: UsageMeterOptions = {}): void {
  let ctx: ExtensionContext | undefined;
  let provider: UsageProvider | undefined;
  let generation = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  let cached: UsageSnapshot | undefined;
  const inFlight = new Map<UsageProvider, Promise<UsageSnapshot | undefined>>();
  const lastRefresh = new Map<UsageProvider, number>();

  const intervalFor = (value: UsageProvider): number =>
    value === "github-copilot"
      ? (options.copilotRefreshIntervalMs ?? defaultCopilotRefreshMs)
      : (options.codexRefreshIntervalMs ?? defaultCodexRefreshMs);

  const clearStatus = (): void => ctx?.ui.setStatus(usageStatusKey, undefined);
  const clearTimer = (): void => {
    if (timer) clearInterval(timer);
    timer = undefined;
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
      cached = snapshot;
      if (snapshot) {
        const text = formatUsage(
          snapshot.provider,
          "quota" in snapshot ? snapshot.quota : snapshot.usage,
        );
        if (text === "Codex: usage unavailable") clearStatus();
        else ctx.ui.setStatus(usageStatusKey, ctx.ui.theme.fg("dim", text));
      } else clearStatus();
      return snapshot;
    });
  };

  const activate = (next: ExtensionContext): void => {
    generation += 1;
    ctx = next;
    provider = usageProviderForModel(next.model);
    cached = undefined;
    clearTimer();
    clearStatus();
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
    const text = formatCodexUsage(usage);
    if (text === "Codex: usage unavailable") clearStatus();
    else next.ui.setStatus(usageStatusKey, next.ui.theme.fg("dim", text));
  });
  pi.on("session_shutdown", () => {
    generation += 1;
    clearTimer();
    clearStatus();
    ctx = undefined;
    provider = undefined;
    cached = undefined;
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

export default function usageMeterExtension(pi: ExtensionAPI): void {
  registerUsageMeter(pi);
}
