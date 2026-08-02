import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { buildCodexHeaders, extractCodexAccountId } from "../../shared/codex-auth.js";
import type {
  CodexAdditionalRateLimit,
  CodexCredits,
  CodexRateLimit,
  CodexSpendLimit,
  CodexUsage,
  CodexUsageWindow,
} from "./types.js";

const defaultBaseUrl = "https://chatgpt.com/backend-api";
type ProviderAuthResult = Awaited<ReturnType<ExtensionContext["modelRegistry"]["getProviderAuth"]>>;
type Fetch = typeof globalThis.fetch;
type RecordValue = Record<string, unknown>;
type HeaderSource = Headers | Record<string, string>;

const record = (value: unknown): value is RecordValue =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));
const finite = (value: unknown): number | undefined => {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim()
        ? Number(value)
        : NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
};
const text = (value: unknown, maximum = 160): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim().slice(0, maximum) : undefined;
const timestamp = (value: unknown): string | number | undefined =>
  typeof value === "string" && value.trim()
    ? value.trim().slice(0, 100)
    : typeof value === "number" && Number.isFinite(value)
      ? value
      : undefined;

function parseWindow(value: unknown): CodexUsageWindow | undefined {
  if (!record(value)) return undefined;
  const usedPercent = finite(value.used_percent ?? value.usedPercent);
  const limitWindowSeconds = finite(
    value.limit_window_seconds ?? value.limitWindowSeconds ?? value.window_seconds,
  );
  const resetAfterSeconds = finite(value.reset_after_seconds ?? value.resetAfterSeconds);
  const resetAt = timestamp(value.reset_at ?? value.resetAt ?? value.reset_timestamp);
  if (
    usedPercent === undefined &&
    limitWindowSeconds === undefined &&
    resetAfterSeconds === undefined &&
    resetAt === undefined
  )
    return undefined;
  return {
    ...(usedPercent === undefined ? {} : { usedPercent }),
    ...(limitWindowSeconds === undefined ? {} : { limitWindowSeconds }),
    ...(resetAfterSeconds === undefined ? {} : { resetAfterSeconds }),
    ...(resetAt === undefined ? {} : { resetAt }),
  };
}

function boolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function numericText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim()
    ? value.trim().slice(0, 100)
    : typeof value === "number" && Number.isFinite(value)
      ? String(value)
      : undefined;
}

function parseCredits(value: unknown): CodexCredits | undefined {
  if (!record(value)) return undefined;
  const hasCredits = boolean(value.has_credits ?? value.hasCredits);
  const unlimited = boolean(value.unlimited);
  const balance = numericText(value.balance);
  const used = finite(value.used ?? value.consumed);
  const remaining = finite(value.remaining ?? value.credits_remaining);
  const total = finite(value.total ?? value.limit ?? value.entitlement);
  if (
    hasCredits === undefined &&
    unlimited === undefined &&
    balance === undefined &&
    used === undefined &&
    remaining === undefined &&
    total === undefined
  )
    return undefined;
  return {
    ...(hasCredits === undefined ? {} : { hasCredits }),
    ...(unlimited === undefined ? {} : { unlimited }),
    ...(balance === undefined ? {} : { balance }),
    ...(used === undefined ? {} : { used }),
    ...(remaining === undefined ? {} : { remaining }),
    ...(total === undefined ? {} : { total }),
  };
}

function parseRateLimit(value: unknown): CodexRateLimit | undefined {
  if (!record(value)) return undefined;
  const allowed = boolean(value.allowed);
  const limitReached = boolean(value.limit_reached ?? value.limitReached);
  const primaryWindow = parseWindow(value.primary_window ?? value.primaryWindow);
  const secondaryWindow = parseWindow(value.secondary_window ?? value.secondaryWindow);
  if (allowed === undefined && limitReached === undefined && !primaryWindow && !secondaryWindow)
    return undefined;
  return {
    ...(allowed === undefined ? {} : { allowed }),
    ...(limitReached === undefined ? {} : { limitReached }),
    ...(primaryWindow ? { primaryWindow } : {}),
    ...(secondaryWindow ? { secondaryWindow } : {}),
  };
}

function parseSpendLimit(value: unknown): CodexSpendLimit | undefined {
  if (!record(value)) {
    const limit = numericText(value);
    return limit === undefined ? undefined : { limit };
  }
  const source = text(value.source);
  const limit = numericText(value.limit);
  const used = numericText(value.used);
  const remaining = numericText(value.remaining);
  const usedPercent = finite(value.used_percent ?? value.usedPercent);
  const remainingPercent = finite(value.remaining_percent ?? value.remainingPercent);
  const resetAfterSeconds = finite(value.reset_after_seconds ?? value.resetAfterSeconds);
  const resetAt = timestamp(value.reset_at ?? value.resetAt);
  if (
    !source &&
    limit === undefined &&
    used === undefined &&
    remaining === undefined &&
    usedPercent === undefined &&
    remainingPercent === undefined &&
    resetAfterSeconds === undefined &&
    resetAt === undefined
  )
    return undefined;
  return {
    ...(source ? { source } : {}),
    ...(limit === undefined ? {} : { limit }),
    ...(used === undefined ? {} : { used }),
    ...(remaining === undefined ? {} : { remaining }),
    ...(usedPercent === undefined ? {} : { usedPercent }),
    ...(remainingPercent === undefined ? {} : { remainingPercent }),
    ...(resetAfterSeconds === undefined ? {} : { resetAfterSeconds }),
    ...(resetAt === undefined ? {} : { resetAt }),
  };
}

function parseAdditional(value: unknown): CodexAdditionalRateLimit[] | undefined {
  const values: unknown[] = Array.isArray(value)
    ? value
    : record(value)
      ? Object.entries(value).map(([name, item]) => (record(item) ? { name, ...item } : { name }))
      : [];
  const result: CodexAdditionalRateLimit[] = [];
  for (const item of values.slice(0, 20)) {
    if (!record(item)) continue;
    const name = text(item.limit_name ?? item.name ?? item.id);
    const meteredFeature = text(item.metered_feature ?? item.meteredFeature);
    const rateLimit =
      parseRateLimit(item.rate_limit ?? item.rateLimit) ??
      (parseWindow(item) ? { primaryWindow: parseWindow(item) } : undefined);
    if (!name && !meteredFeature && !rateLimit) continue;
    result.push({
      ...(name ? { name } : {}),
      ...(meteredFeature ? { meteredFeature } : {}),
      ...(rateLimit ? { rateLimit } : {}),
    });
  }
  return result.length ? result : undefined;
}

/** Parses bounded usage metadata, tolerating partial provider responses. */
export function parseCodexUsage(value: unknown): CodexUsage | undefined {
  if (!record(value)) return undefined;
  const rateLimit = parseRateLimit(value.rate_limit ?? value.rateLimit);
  const credits =
    parseCredits(value.credits ?? value.credit_usage ?? value.creditUsage) ??
    parseCredits({
      used: value.credits_used,
      remaining: value.credits_remaining,
      total: value.credits_total ?? value.credit_limit,
    });
  const spend = record(value.spend_control) ? value.spend_control : value.spendControl;
  const individualLimit = record(spend)
    ? parseSpendLimit(spend.individual_limit ?? spend.individualLimit)
    : undefined;
  const spendReached = record(spend) ? boolean(spend.reached ?? spend.limit_reached) : undefined;
  const additionalRateLimits = parseAdditional(
    value.additional_rate_limits ?? value.additionalRateLimits,
  );
  const planType = text(value.plan_type ?? value.planType ?? value.plan);
  const rateLimitReachedType = text(value.rate_limit_reached_type ?? value.rateLimitReachedType);
  if (
    !planType &&
    !credits &&
    !individualLimit &&
    spendReached === undefined &&
    !additionalRateLimits &&
    !rateLimit &&
    !rateLimitReachedType
  )
    return undefined;
  return {
    ...(planType ? { planType } : {}),
    ...(credits ? { credits } : {}),
    ...(!individualLimit && spendReached === undefined
      ? {}
      : {
          spendControl: {
            ...(individualLimit ? { individualLimit } : {}),
            ...(spendReached === undefined ? {} : { reached: spendReached }),
          },
        }),
    ...(additionalRateLimits ? { additionalRateLimits } : {}),
    ...(rateLimit?.allowed === undefined ? {} : { allowed: rateLimit.allowed }),
    ...(rateLimit?.limitReached === undefined ? {} : { limitReached: rateLimit.limitReached }),
    ...(rateLimitReachedType ? { rateLimitReachedType } : {}),
    ...(rateLimit?.primaryWindow ? { primaryWindow: rateLimit.primaryWindow } : {}),
    ...(rateLimit?.secondaryWindow ? { secondaryWindow: rateLimit.secondaryWindow } : {}),
  };
}

function headerGet(headers: HeaderSource, name: string): string | undefined {
  if (headers instanceof Headers) return headers.get(name) ?? undefined;
  return (
    headers[name] ??
    headers[name.toLowerCase()] ??
    Object.entries(headers).find(([key]) => key.toLowerCase() === name)?.[1]
  );
}
function headerNumber(headers: HeaderSource, name: string): number | undefined {
  return finite(headerGet(headers, name));
}
function headerBoolean(headers: HeaderSource, name: string): boolean | undefined {
  const value = headerGet(headers, name)?.toLowerCase();
  return value === undefined
    ? undefined
    : value === "true"
      ? true
      : value === "false"
        ? false
        : undefined;
}

/** Parses the bounded x-codex-* rate-limit metadata exposed by provider responses. */
export function parseCodexUsageHeaders(headers: HeaderSource): Partial<CodexUsage> | undefined {
  const window = (name: "primary" | "secondary"): CodexUsageWindow | undefined => {
    const usedPercent = headerNumber(headers, `x-codex-${name}-used-percent`);
    const seconds = headerNumber(headers, `x-codex-${name}-window-seconds`);
    const minutes = headerNumber(headers, `x-codex-${name}-window-minutes`);
    const resetAfterSeconds = headerNumber(headers, `x-codex-${name}-reset-after-seconds`);
    const resetAt = timestamp(headerGet(headers, `x-codex-${name}-reset-at`));
    if (
      usedPercent === undefined &&
      seconds === undefined &&
      minutes === undefined &&
      resetAfterSeconds === undefined &&
      resetAt === undefined
    )
      return undefined;
    return {
      ...(usedPercent === undefined ? {} : { usedPercent }),
      ...(seconds === undefined && minutes === undefined
        ? {}
        : { limitWindowSeconds: seconds ?? minutes! * 60 }),
      ...(resetAfterSeconds === undefined ? {} : { resetAfterSeconds }),
      ...(resetAt === undefined ? {} : { resetAt }),
    };
  };
  const primaryWindow = window("primary");
  const secondaryWindow = window("secondary");
  const planType = text(
    headerGet(headers, "x-codex-plan-type") ?? headerGet(headers, "x-codex-plan"),
  );
  const credits: CodexCredits = {
    ...(headerBoolean(headers, "x-codex-credits-has-credits") === undefined
      ? {}
      : { hasCredits: headerBoolean(headers, "x-codex-credits-has-credits") }),
    ...(headerBoolean(headers, "x-codex-credits-unlimited") === undefined
      ? {}
      : { unlimited: headerBoolean(headers, "x-codex-credits-unlimited") }),
    ...(numericText(headerGet(headers, "x-codex-credits-balance")) === undefined
      ? {}
      : { balance: numericText(headerGet(headers, "x-codex-credits-balance")) }),
    ...(headerNumber(headers, "x-codex-credits-used") === undefined
      ? {}
      : { used: headerNumber(headers, "x-codex-credits-used") }),
    ...(headerNumber(headers, "x-codex-credits-remaining") === undefined
      ? {}
      : { remaining: headerNumber(headers, "x-codex-credits-remaining") }),
    ...(headerNumber(headers, "x-codex-credits-total") === undefined
      ? {}
      : { total: headerNumber(headers, "x-codex-credits-total") }),
  };
  const hasCreditMetadata = Object.keys(credits).length > 0;
  const individualLimitValue = headerGet(headers, "x-codex-spend-control-individual-limit");
  const individualLimit = parseSpendLimit(individualLimitValue);
  const rateLimitReachedType = text(headerGet(headers, "x-codex-rate-limit-reached-type"));
  const allowed = headerBoolean(headers, "x-codex-allowed");
  const limitReached = headerBoolean(headers, "x-codex-limit-reached");
  let additionalRateLimits: CodexAdditionalRateLimit[] | undefined;
  const additional = headerGet(headers, "x-codex-additional-rate-limits");
  if (additional) {
    try {
      additionalRateLimits = parseAdditional(JSON.parse(additional));
    } catch {
      /* malformed optional metadata is ignored */
    }
  }
  if (
    !planType &&
    !hasCreditMetadata &&
    !individualLimit &&
    !additionalRateLimits &&
    !primaryWindow &&
    !secondaryWindow &&
    !rateLimitReachedType &&
    allowed === undefined &&
    limitReached === undefined
  )
    return undefined;
  return {
    ...(planType ? { planType } : {}),
    ...(hasCreditMetadata ? { credits } : {}),
    ...(individualLimit ? { spendControl: { individualLimit } } : {}),
    ...(additionalRateLimits ? { additionalRateLimits } : {}),
    ...(rateLimitReachedType ? { rateLimitReachedType } : {}),
    ...(allowed === undefined ? {} : { allowed }),
    ...(limitReached === undefined ? {} : { limitReached }),
    ...(primaryWindow ? { primaryWindow } : {}),
    ...(secondaryWindow ? { secondaryWindow } : {}),
  };
}

export function mergeCodexUsage(
  base: CodexUsage | undefined,
  update: Partial<CodexUsage>,
): CodexUsage {
  return {
    ...(base ?? {}),
    ...update,
    ...(base?.primaryWindow || update.primaryWindow
      ? { primaryWindow: { ...base?.primaryWindow, ...update.primaryWindow } }
      : {}),
    ...(base?.secondaryWindow || update.secondaryWindow
      ? { secondaryWindow: { ...base?.secondaryWindow, ...update.secondaryWindow } }
      : {}),
    ...(base?.credits || update.credits
      ? { credits: { ...base?.credits, ...update.credits } }
      : {}),
    ...(base?.spendControl || update.spendControl
      ? { spendControl: { ...base?.spendControl, ...update.spendControl } }
      : {}),
  };
}

export function codexUsageUrl(baseUrl?: string): string {
  const base = (baseUrl?.trim() || defaultBaseUrl).replace(/\/+$/, "");
  let parsed: URL;
  try {
    parsed = new URL(base);
  } catch {
    throw new Error("OpenAI Codex usage has an invalid provider base URL.");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.hostname !== "chatgpt.com" ||
    parsed.username ||
    parsed.password
  )
    throw new Error("OpenAI Codex usage requires the trusted HTTPS chatgpt.com provider endpoint.");
  if (
    parsed.search ||
    parsed.hash ||
    !["/backend-api", "/backend-api/codex"].includes(parsed.pathname)
  )
    throw new Error("OpenAI Codex usage requires the trusted HTTPS chatgpt.com provider endpoint.");
  return "https://chatgpt.com/backend-api/wham/usage";
}

export async function fetchCodexUsage(
  getAuth: () => Promise<ProviderAuthResult>,
  fetchImplementation: Fetch = globalThis.fetch,
  baseUrl?: string,
): Promise<CodexUsage | undefined> {
  let auth: ProviderAuthResult;
  try {
    auth = await getAuth();
    if (!auth?.auth?.apiKey) return undefined;
    const token = auth.auth.apiKey;
    const accountId = extractCodexAccountId(token);
    const response = await fetchImplementation(codexUsageUrl(auth.auth.baseUrl ?? baseUrl), {
      method: "GET",
      headers: buildCodexHeaders(token, accountId, auth.auth.headers),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) return undefined;
    const payload = parseCodexUsage(await response.json());
    const headerUsage = parseCodexUsageHeaders(response.headers);
    if (!payload && !headerUsage) return undefined;
    return mergeCodexUsage(headerUsage as CodexUsage | undefined, payload ?? {});
  } catch {
    return undefined;
  }
}
