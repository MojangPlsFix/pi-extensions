import { randomUUID } from "node:crypto";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  type BackendSearchResult,
  boundedText,
  defaultCodexBaseUrl,
  defaultCodexMaxTokens,
  formatSources,
  maximumSources,
  normalizeCodexSources,
  normalizeSearchParams,
  promptFor,
  type SearchParams,
  type SearchSource,
  safeOption,
  sourcesFromText,
} from "./search.js";

type CodexModel = { id: string; baseUrl?: string };
type ProviderAuthResult = Awaited<ReturnType<ExtensionContext["modelRegistry"]["getProviderAuth"]>>;
type Fetch = typeof globalThis.fetch;

function recencyDays(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  const named: Record<string, number> = {
    day: 1,
    week: 7,
    month: 30,
    quarter: 90,
    year: 365,
  };
  if (named[normalized]) return named[normalized];
  const match = normalized.match(/^(\d+)\s*(?:d|day|days)?$/);
  if (!match) return undefined;
  const result = Number(match[1]);
  return Number.isSafeInteger(result) && result > 0 ? result : undefined;
}

export function buildCodexSearchRequest(
  params: SearchParams,
  activeModelId: string,
  id: string = randomUUID(),
): Record<string, unknown> {
  const normalized = normalizeSearchParams(params);
  if (normalized.reasoningEffort)
    throw new Error("reasoningEffort is supported only by Copilot CLI search.");
  const allowedDomains = normalized.domainFilter?.filter((domain) => !domain.startsWith("-"));
  const blockedDomains = normalized.domainFilter
    ?.filter((domain) => domain.startsWith("-"))
    .map((domain) => domain.slice(1));
  const days = recencyDays(normalized.recencyFilter);
  const maxTokens = normalized.maxTokens ?? defaultCodexMaxTokens;
  return {
    id,
    model: normalized.model ?? safeOption(activeModelId, "active model") ?? activeModelId,
    input: promptFor(normalized),
    commands: {
      search_query: normalized.requests.map((query) => ({
        q: query,
        ...(days ? { recency: days } : {}),
        ...(allowedDomains?.length ? { domains: allowedDomains } : {}),
      })),
      response_length: maxTokens <= 1_500 ? "short" : maxTokens >= 6_000 ? "long" : "medium",
    },
    settings: {
      search_context_size: normalized.includeContent ? "high" : "medium",
      ...((allowedDomains?.length || blockedDomains?.length) && {
        filters: {
          ...(allowedDomains?.length ? { allowed_domains: allowedDomains } : {}),
          ...(blockedDomains?.length ? { blocked_domains: blockedDomains } : {}),
        },
      }),
      allowed_callers: ["direct"],
      external_web_access: "live",
    },
    max_output_tokens: maxTokens,
  };
}

export function extractCodexAccountId(token: string): string {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) throw new Error("invalid token");
    const payload = JSON.parse(Buffer.from(parts[1] ?? "", "base64url").toString("utf8")) as {
      [key: string]: unknown;
    };
    const auth = payload["https://api.openai.com/auth"];
    const accountId =
      auth && typeof auth === "object"
        ? (auth as Record<string, unknown>).chatgpt_account_id
        : undefined;
    if (typeof accountId !== "string" || !accountId) throw new Error("missing account id");
    return accountId;
  } catch {
    throw new Error(
      "OpenAI Codex authentication is invalid. Run `/login openai-codex` and try again.",
    );
  }
}

export function buildCodexHeaders(
  token: string,
  accountId: string,
  inherited?: Record<string, unknown>,
): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(inherited ?? {})) {
    if (typeof value === "string") headers.set(key, value);
  }
  headers.set("authorization", `Bearer ${token}`);
  headers.set("chatgpt-account-id", accountId);
  headers.set("originator", "pi");
  headers.set("accept", "application/json");
  headers.set("content-type", "application/json");
  return headers;
}

function codexSearchUrl(baseUrl: string | undefined): string {
  const base = (baseUrl?.trim() || defaultCodexBaseUrl).replace(/\/+$/, "");
  let url: URL;
  try {
    url = new URL(base.endsWith("/codex") ? `${base}/alpha/search` : `${base}/codex/alpha/search`);
  } catch {
    throw new Error("OpenAI Codex search has an invalid provider base URL.");
  }
  if (url.protocol !== "https:" || url.hostname !== "chatgpt.com" || url.username || url.password)
    throw new Error(
      "OpenAI Codex native search requires the trusted HTTPS chatgpt.com provider endpoint.",
    );
  return url.toString();
}

export function normalizeCodexResponse(payload: unknown): BackendSearchResult {
  if (!payload || typeof payload !== "object" || Array.isArray(payload))
    throw new Error("Codex native search returned a malformed response.");
  const record = payload as Record<string, unknown>;
  if (typeof record.output !== "string")
    throw new Error("Codex native search returned a malformed response.");
  if (record.results !== undefined && !Array.isArray(record.results))
    throw new Error("Codex native search returned malformed structured results.");
  const output = boundedText(record.output);
  const rawResults = (record.results as unknown[] | undefined) ?? [];
  const structured = normalizeCodexSources(rawResults);
  const textual = sourcesFromText(output.text);
  const sources: SearchSource[] = [];
  const seen = new Set<string>();
  for (const source of [...structured.sources, ...textual.sources]) {
    if (seen.has(source.url)) continue;
    seen.add(source.url);
    if (sources.length < maximumSources) sources.push(source);
  }
  const sourcesTruncated = structured.truncated || textual.truncated || seen.size > maximumSources;
  const sourceSection = formatSources(sources, sourcesTruncated);
  if (!output.text && sources.length === 0)
    throw new Error("Codex native search completed without results.");
  return {
    output: [output.text, sourceSection.text].filter(Boolean).join("\n\n"),
    sources,
    resultCount: rawResults.length || sources.length || (output.text ? 1 : 0),
    outputTruncated: output.truncated,
    sourcesTruncated: sourceSection.truncated,
  };
}

function isAbortError(error: unknown, signal?: AbortSignal): boolean {
  return signal?.aborted === true || (error instanceof Error && error.name === "AbortError");
}

async function withAbortSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted();
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

export async function runCodexSearch(
  params: SearchParams,
  model: CodexModel,
  getAuth: () => Promise<ProviderAuthResult>,
  signal?: AbortSignal,
  fetchImplementation: Fetch = globalThis.fetch,
  onStatus?: (value: string) => void,
): Promise<BackendSearchResult> {
  const body = buildCodexSearchRequest(params, model.id);
  onStatus?.("Searching with Codex native search…");
  signal?.throwIfAborted();
  let auth: ProviderAuthResult;
  try {
    auth = await withAbortSignal(getAuth(), signal);
  } catch (error) {
    if (isAbortError(error, signal)) throw error;
    throw new Error(
      "OpenAI Codex authentication could not be refreshed. Run `/login openai-codex` and try again.",
    );
  }
  const token = auth?.auth.apiKey;
  if (!auth || !token)
    throw new Error(
      "OpenAI Codex search requires authentication. Run `/login openai-codex` and try again.",
    );
  const accountId = extractCodexAccountId(token);
  const headers = buildCodexHeaders(token, accountId, auth.auth.headers);
  const url = codexSearchUrl(auth.auth.baseUrl ?? model.baseUrl);
  signal?.throwIfAborted();
  let response: Response;
  try {
    response = await fetchImplementation(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal,
    });
  } catch (error) {
    if (isAbortError(error, signal)) throw error;
    throw new Error("Codex native search could not reach the provider endpoint.");
  }
  if (!response.ok)
    throw new Error(
      `Codex native search failed with HTTP ${response.status}. Check authentication and provider availability.`,
    );
  let payload: unknown;
  try {
    payload = await withAbortSignal(response.json(), signal);
  } catch (error) {
    if (isAbortError(error, signal)) throw error;
    throw new Error("Codex native search returned a malformed response.");
  }
  return normalizeCodexResponse(payload);
}
