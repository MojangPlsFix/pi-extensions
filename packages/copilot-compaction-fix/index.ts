import {
  compact,
  type ExtensionAPI,
  type ExtensionContext,
  generateBranchSummary,
  type SessionBeforeCompactEvent,
  type SessionBeforeTreeEvent,
} from "@earendil-works/pi-coding-agent";
import { isCopilotModel } from "../../shared/provider.js";

type Model = NonNullable<ExtensionContext["model"]>;
type ResolvedRequest = {
  model: Model;
  apiKey?: string;
  headers?: Record<string, string>;
  env?: Record<string, string>;
};

/**
 * Some Pi versions resolve Copilot auth for ordinary requests but omit its
 * credential-specific base URL for compaction and branch-summary requests.
 * Return undefined whenever Pi's normal compaction path is already correct.
 */
export async function resolveCompactionRequest(
  ctx: ExtensionContext,
  model: Model,
): Promise<ResolvedRequest | undefined> {
  if (!isCopilotModel(model) || process.env.PI_DISABLE_COPILOT_COMPACTION_BASE_URL_FIX === "1")
    return undefined;
  try {
    const result = await ctx.modelRegistry.getProviderAuth(model.provider);
    const baseUrl = result?.auth.baseUrl;
    if (!baseUrl || baseUrl === model.baseUrl) return undefined;
    const headers = result.auth.headers
      ? Object.fromEntries(
          Object.entries(result.auth.headers).filter(
            (entry): entry is [string, string] => typeof entry[1] === "string",
          ),
        )
      : undefined;
    return { model: { ...model, baseUrl }, apiKey: result.auth.apiKey, headers, env: result.env };
  } catch {
    // Credential lookup is intentionally best-effort. Core Pi handles normal auth failures.
    return undefined;
  }
}

export async function provideCompaction(event: SessionBeforeCompactEvent, ctx: ExtensionContext) {
  if (!ctx.model || !isCopilotModel(ctx.model)) return undefined;
  const request = await resolveCompactionRequest(ctx, ctx.model);
  if (!request) return undefined;
  return {
    compaction: await compact(
      event.preparation,
      request.model,
      request.apiKey,
      request.headers,
      event.customInstructions,
      event.signal,
      ctx.thinkingLevel,
      undefined,
      request.env,
    ),
  };
}

export async function provideBranchSummary(event: SessionBeforeTreeEvent, ctx: ExtensionContext) {
  if (
    !event.preparation.userWantsSummary ||
    event.preparation.entriesToSummarize.length === 0 ||
    !ctx.model ||
    !isCopilotModel(ctx.model)
  )
    return undefined;
  const request = await resolveCompactionRequest(ctx, ctx.model);
  if (!request) return undefined;
  const result = await generateBranchSummary(event.preparation.entriesToSummarize, {
    model: request.model,
    apiKey: request.apiKey,
    headers: request.headers,
    env: request.env,
    signal: event.signal,
    customInstructions: event.preparation.customInstructions,
    replaceInstructions: event.preparation.replaceInstructions,
  });
  if (result.aborted) return { cancel: true };
  if (result.error || !result.summary)
    throw new Error(result.error ?? "Branch summarization produced no summary.");
  return {
    summary: {
      summary: result.summary,
      details: { readFiles: result.readFiles ?? [], modifiedFiles: result.modifiedFiles ?? [] },
      usage: result.usage,
    },
  };
}

export default function copilotCompactionFixExtension(pi: ExtensionAPI): void {
  pi.on("session_before_compact", provideCompaction);
  pi.on("session_before_tree", provideBranchSummary);
}
