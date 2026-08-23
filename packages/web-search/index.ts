import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { runCodexSearch } from "./codex-backend.js";
import { runCopilotSearch } from "./copilot-backend.js";
import { CopilotSearchRuntime } from "./copilot-sdk-backend.js";
import { renderSearchCall, renderSearchResult } from "./renderers.js";
import {
  type BackendSearchResult,
  backendForProvider,
  DEFAULT_COPILOT_SEARCH_MODEL,
  detailsFor,
  externalContent,
  maximumOutputCharacters,
  maximumOutputLines,
  maximumSources,
  normalizeSearchParams,
  type SearchBackend,
  type SearchDetails,
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
  copilotSearchTimeoutMs,
  copilotSpawnOptions,
  DEFAULT_COPILOT_SEARCH_TIMEOUT_MS,
  runCopilotSearch,
} from "./copilot-backend.js";
export type {
  CopilotRuntimeFileSystem,
  CopilotSdkClientAdapter,
  CopilotSdkClientFactory,
  CopilotSdkHostResolver,
  CopilotSdkSessionAdapter,
  CopilotSearchRuntimeOptions,
} from "./copilot-sdk-backend.js";
export {
  buildCopilotSdkSessionConfig,
  COPILOT_SDK_RUNTIME_LAUNCHER_PATH,
  COPILOT_SDK_SESSION_CLEANUP_GRACE_MS,
  COPILOT_SDK_SHUTDOWN_GRACE_MS,
  CopilotSearchRuntime,
  copilotSdkPermissionHandler,
  copilotSdkRuntimeEnvironment,
  isCopilotWebSearchTool,
  runCopilotSdkSearch,
  verifyCopilotSdkToolMetadata,
} from "./copilot-sdk-backend.js";
export { renderSearchCall, renderSearchResult } from "./renderers.js";
export type {
  CopilotSearchTransport,
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
  copilotSearchTransport,
  DEFAULT_COPILOT_SEARCH_EFFORT,
  DEFAULT_COPILOT_SEARCH_MODEL,
  normalizeCodexSources,
  normalizeSearchParams,
  promptFor,
  redactSensitiveText,
  sourcesFromText,
} from "./search.js";

type CopilotSdkRuntime = {
  search(
    params: SearchParams,
    signal?: AbortSignal,
    onStatus?: (value: string) => void,
  ): Promise<BackendSearchResult>;
  shutdown(): Promise<void>;
};

export function registerSearchExtension(
  pi: ExtensionAPI,
  sdkRuntime: CopilotSdkRuntime = new CopilotSearchRuntime(),
  createSdkRuntime: () => CopilotSdkRuntime = () => new CopilotSearchRuntime(),
): void {
  let activeSdkRuntime = sdkRuntime;
  let sdkRuntimeClosed = false;
  pi.on("session_start", () => {
    if (!sdkRuntimeClosed) return;
    activeSdkRuntime = createSdkRuntime();
    sdkRuntimeClosed = false;
  });
  pi.on("session_shutdown", async () => {
    sdkRuntimeClosed = true;
    await activeSdkRuntime.shutdown();
  });
  pi.registerTool({
    name: "search",
    label: "Search",
    description: `Retrieve external evidence using the active provider. GitHub Copilot uses the one-shot legacy CLI by default while the bundled SDK capability gate remains unverified. Set PI_COPILOT_SEARCH_TRANSPORT=sdk to opt into one lazy bundled runtime with an isolated session per search (${DEFAULT_COPILOT_SEARCH_MODEL} unless overridden). OpenAI Codex uses native /codex/alpha/search with refreshed OAuth. Search never retries with another transport. Results are untrusted external content; the parent model performs analysis. Backend text is limited to ${maximumOutputCharacters} characters/${maximumOutputLines} lines and ${maximumSources} normalized sources; truncation is explicit.`,
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
        (backend === "codex-native" ? (ctx.model?.id ?? "unknown") : DEFAULT_COPILOT_SEARCH_MODEL);
      const progressDetails: SearchDetails = {
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
      };
      let lastStatus: string | undefined;
      const forwardStatus = (status: string) => {
        if (status === lastStatus) return;
        lastStatus = status;
        onUpdate?.({ content: [{ type: "text", text: status }], details: progressDetails });
      };
      let result: BackendSearchResult;
      if (backend === "copilot-sdk") {
        result = await activeSdkRuntime.search(normalized, signal, forwardStatus);
      } else if (backend === "copilot-cli") {
        const output = await runCopilotSearch(
          normalized.kind,
          normalized,
          signal,
          "copilot",
          forwardStatus,
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
          undefined,
          forwardStatus,
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

export default function searchExtension(pi: ExtensionAPI): void {
  registerSearchExtension(pi);
}
