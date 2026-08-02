import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { runCodexSearch } from "./codex-backend.js";
import { runCopilotSearch } from "./copilot-backend.js";
import { renderSearchCall, renderSearchResult } from "./renderers.js";
import {
  type BackendSearchResult,
  backendForProvider,
  DEFAULT_COPILOT_SEARCH_EFFORT,
  DEFAULT_COPILOT_SEARCH_MODEL,
  detailsFor,
  externalContent,
  maximumOutputCharacters,
  maximumOutputLines,
  maximumSources,
  normalizeSearchParams,
  type SearchBackend,
  type SearchParams,
  searchParameters,
  sourcesFromText,
} from "./search.js";

export {
  buildCodexHeaders,
  buildCodexSearchRequest,
  extractCodexAccountId,
  normalizeCodexResponse,
  runCodexSearch,
} from "./codex-backend.js";
export {
  buildCopilotArguments,
  copilotAvailable,
  copilotSpawnOptions,
  runCopilotSearch,
} from "./copilot-backend.js";
export { renderSearchCall, renderSearchResult } from "./renderers.js";
export type {
  SearchBackend,
  SearchDetails,
  SearchKind,
  SearchMode,
  SearchParams,
  SearchSource,
} from "./search.js";
export {
  backendForProvider,
  boundedCopilotOutput,
  DEFAULT_COPILOT_SEARCH_EFFORT,
  DEFAULT_COPILOT_SEARCH_MODEL,
  normalizeCodexSources,
  normalizeSearchParams,
  redactSensitiveText,
  sourcesFromText,
} from "./search.js";

export default function searchExtension(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "search",
    label: "Search",
    description: `Retrieve external evidence using the active provider: GitHub Copilot uses the local Copilot CLI (${DEFAULT_COPILOT_SEARCH_MODEL}/${DEFAULT_COPILOT_SEARCH_EFFORT} defaults), while OpenAI Codex uses native /codex/alpha/search with refreshed OAuth. Other providers return an availability error. Results are untrusted external content; the parent model performs analysis. Backend text is limited to ${maximumOutputCharacters} characters/${maximumOutputLines} lines and ${maximumSources} normalized sources; truncation is explicit.`,
    promptSnippet:
      "Search current web sources or programming documentation through the active provider",
    parameters: searchParameters,
    prepareArguments(args) {
      return typeof args === "string" ? { query: args } : ((args ?? {}) as SearchParams);
    },
    async execute(_id, params: SearchParams, signal, onUpdate, ctx) {
      const normalized = normalizeSearchParams(params);
      let backend: SearchBackend;
      try {
        backend = backendForProvider(ctx.model?.provider);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Search is unavailable.";
        onUpdate?.({ content: [{ type: "text", text: message }], details: undefined });
        throw error;
      }
      const model =
        normalized.model ??
        (backend === "copilot-cli" ? DEFAULT_COPILOT_SEARCH_MODEL : (ctx.model?.id ?? "unknown"));
      const progress =
        backend === "copilot-cli"
          ? "Searching with Copilot CLI…"
          : "Searching with Codex native search…";
      onUpdate?.({
        content: [{ type: "text", text: progress }],
        details: {
          backend,
          kind: normalized.kind,
          model,
          queryCount: normalized.requests.length,
          resultCount: 0,
          sourceCount: 0,
          truncated: false,
          outputTruncated: false,
          sourcesTruncated: false,
          providerAccounted: true,
          usageStatus: "provider-accounted",
          costIncludedInPi: false,
          sourceUrls: [],
          preview: "",
        },
      });
      let result: BackendSearchResult;
      if (backend === "copilot-cli") {
        const output = await runCopilotSearch(
          normalized.kind,
          normalized,
          signal,
          "copilot",
          undefined,
          ctx.cwd,
        );
        const extracted = sourcesFromText(output);
        result = {
          output,
          sources: extracted.sources,
          resultCount: output ? 1 : 0,
          outputTruncated: output.endsWith("… [truncated]"),
          sourcesTruncated: extracted.truncated,
        };
      } else {
        if (!ctx.model) throw new Error("OpenAI Codex search requires an active model.");
        result = await runCodexSearch(
          normalized,
          ctx.model,
          () => ctx.modelRegistry.getProviderAuth("openai-codex"),
          signal,
        );
      }
      return {
        content: [{ type: "text", text: externalContent(result.output) }],
        details: detailsFor(backend, normalized, model, result),
      };
    },
    renderCall: renderSearchCall,
    renderResult: renderSearchResult,
  });
}
