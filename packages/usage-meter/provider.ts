import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isProvider } from "../../shared/provider.js";
import { fetchCodexUsage } from "./codex-client.js";
import { fetchCopilotQuota } from "./copilot-client.js";
import type { CodexUsage, CopilotQuota, UsageProvider, UsageSnapshot } from "./types.js";

export type UsageModel = { provider?: unknown; baseUrl?: string } | null | undefined;
export type UsageModelRegistry = Pick<ExtensionContext["modelRegistry"], "getProviderAuth">;
export type FetchProviderUsageOptions = {
  fetchCopilotQuota?: () => Promise<CopilotQuota | undefined>;
  fetchCodexUsage?: () => Promise<CodexUsage | undefined>;
  fetch?: typeof globalThis.fetch;
};

/** Unsupported models return undefined; supported models always return a provider result. */
export type ProviderUsageResult = {
  provider: UsageProvider;
  snapshot?: UsageSnapshot;
};

export function isCopilotUsageModel(model: UsageModel): boolean {
  return isProvider(model, "github-copilot");
}

export function isCodexUsageModel(model: UsageModel): boolean {
  return isProvider(model, "openai-codex");
}

export function usageProviderForModel(model: UsageModel): UsageProvider | undefined {
  if (isCopilotUsageModel(model)) return "github-copilot";
  if (isCodexUsageModel(model)) return "openai-codex";
  return undefined;
}

/** Routes provider authentication and retrieval without retaining provider payloads. */
export async function fetchProviderUsage(
  model: UsageModel,
  modelRegistry: UsageModelRegistry | undefined,
  options: FetchProviderUsageOptions = {},
): Promise<ProviderUsageResult | undefined> {
  const provider = usageProviderForModel(model);
  if (!provider) return undefined;
  let value: CopilotQuota | CodexUsage | undefined;
  try {
    if (provider === "github-copilot") {
      value = options.fetchCopilotQuota
        ? await options.fetchCopilotQuota()
        : await fetchCopilotQuota(options.fetch);
      return { provider, ...(value ? { snapshot: { provider, quota: value } } : {}) };
    }
    if (!options.fetchCodexUsage && !modelRegistry) return { provider };
    value = options.fetchCodexUsage
      ? await options.fetchCodexUsage()
      : await fetchCodexUsage(
          () => modelRegistry!.getProviderAuth("openai-codex"),
          options.fetch,
          model?.baseUrl,
        );
    return { provider, ...(value ? { snapshot: { provider, usage: value } } : {}) };
  } catch {
    return { provider };
  }
}

export const providerForModel = usageProviderForModel;
export const getUsageProvider = usageProviderForModel;
export const isCopilotModel = isCopilotUsageModel;
export const isCodexModel = isCodexUsageModel;
export const isCopilotProvider = isCopilotUsageModel;
export const isCodexProvider = isCodexUsageModel;

export function providerLabel(provider: UsageProvider): string {
  return provider === "github-copilot" ? "Copilot" : "Codex";
}
