import type {
  CodexRateLimit,
  CodexSpendLimit,
  CodexUsage,
  CodexUsageWindow,
  CopilotQuota,
  UsageProvider,
} from "./types.js";

const number = (value: number): string =>
  value.toLocaleString("en-US", { maximumFractionDigits: 1 });
const title = (value: string): string =>
  value
    .trim()
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());

export function formatCopilotQuota(quota: CopilotQuota): string {
  if (quota.unlimited) return "Copilot: unlimited";
  const total = quota.total === undefined ? "" : `/${number(quota.total)}`;
  const percent =
    quota.percentRemaining === undefined ? "" : ` (${Math.round(quota.percentRemaining)}% left)`;
  return `Copilot: ${number(quota.remaining)}${total} ${quota.unit.replace("_", " ")}${percent}`;
}

function durationLabel(seconds: number | undefined): string | undefined {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds <= 0) return undefined;
  if (Math.abs(seconds - 7 * 24 * 60 * 60) < 60) return "Weekly";
  if (seconds % 3600 === 0) return `${seconds / 3600}h`;
  if (seconds % 60 === 0) return `${seconds / 60}m`;
  return `${Math.round(seconds)}s`;
}

export function formatCodexWindowLabel(
  window: CodexUsageWindow | undefined,
  fallback: string,
): string {
  return durationLabel(window?.limitWindowSeconds) ?? fallback;
}

function remaining(window: CodexUsageWindow): number | undefined {
  if (window.usedPercent === undefined || !Number.isFinite(window.usedPercent)) return undefined;
  return Math.round(100 - Math.max(0, Math.min(100, window.usedPercent)));
}

function resetText(window: CodexUsageWindow): string | undefined {
  if (window.resetAt !== undefined) {
    const date =
      typeof window.resetAt === "number"
        ? new Date(window.resetAt < 10_000_000_000 ? window.resetAt * 1000 : window.resetAt)
        : /^\d+(?:\.\d+)?$/.test(window.resetAt)
          ? new Date(Number(window.resetAt) * 1000)
          : new Date(window.resetAt);
    if (!Number.isNaN(date.valueOf())) return `resets ${date.toISOString()}`;
  }
  if (window.resetAfterSeconds !== undefined && window.resetAfterSeconds >= 0)
    return `resets in ${durationLabel(window.resetAfterSeconds) ?? `${window.resetAfterSeconds}s`}`;
  return undefined;
}

function compactWindow(window: CodexUsageWindow | undefined, fallback: string): string | undefined {
  if (!window) return undefined;
  const left = remaining(window);
  if (left === undefined) return undefined;
  return `${formatCodexWindowLabel(window, fallback).toLowerCase()} ${left}% left`;
}

/** Compact footer form. */
export function formatCodexUsage(usage: CodexUsage): string {
  const windows = [
    compactWindow(usage.primaryWindow, "primary"),
    compactWindow(usage.secondaryWindow, "secondary"),
  ].filter((value): value is string => Boolean(value));
  return windows.length ? `Codex: ${windows.join(" · ")}` : "Codex: usage unavailable";
}

function windowLine(window: CodexUsageWindow | undefined, fallback: string): string | undefined {
  if (!window) return undefined;
  const left = remaining(window);
  const reset = resetText(window);
  const state = left === undefined ? undefined : `${left}% left`;
  if (!state && !reset) return undefined;
  return `${formatCodexWindowLabel(window, fallback)}: ${[state, reset].filter(Boolean).join(" · ")}`;
}

function creditsLine(usage: CodexUsage): string | undefined {
  const credits = usage.credits;
  if (!credits) return undefined;
  const parts = [
    credits.unlimited ? "unlimited" : undefined,
    credits.balance === undefined ? undefined : `balance ${credits.balance}`,
    credits.used === undefined ? undefined : `${number(credits.used)} used`,
    credits.remaining === undefined ? undefined : `${number(credits.remaining)} remaining`,
    credits.total === undefined ? undefined : `${number(credits.total)} total`,
    credits.hasCredits === false ? "none available" : undefined,
  ].filter((value): value is string => Boolean(value));
  return parts.length ? `Credits: ${parts.join(" · ")}` : undefined;
}

function spendLine(
  limit: CodexSpendLimit | undefined,
  reached: boolean | undefined,
): string | undefined {
  if (!limit && reached === undefined) return undefined;
  const parts = [
    limit?.limit === undefined ? undefined : `limit ${limit.limit}`,
    limit?.used === undefined ? undefined : `${limit.used} used`,
    limit?.remaining === undefined ? undefined : `${limit.remaining} remaining`,
    limit?.remainingPercent === undefined
      ? undefined
      : `${Math.max(0, Math.min(100, limit.remainingPercent))}% left`,
    limit ? resetText(limit) : undefined,
    reached === undefined ? undefined : reached ? "reached" : "not reached",
  ].filter((value): value is string => Boolean(value));
  return parts.length ? `Spend control: ${parts.join(" · ")}` : undefined;
}

function additionalLines(usage: CodexUsage): string[] {
  const lines: string[] = [];
  for (const limit of usage.additionalRateLimits ?? []) {
    const label = title(limit.name ?? limit.meteredFeature ?? "Additional limit");
    const rate: CodexRateLimit | undefined = limit.rateLimit;
    const primary = windowLine(rate?.primaryWindow, "Primary");
    const secondary = windowLine(rate?.secondaryWindow, "Secondary");
    const state =
      rate?.limitReached === undefined
        ? undefined
        : rate.limitReached
          ? "limit reached"
          : "available";
    const details = [primary, secondary, state].filter((value): value is string => Boolean(value));
    lines.push(details.length ? `${label}: ${details.join(" · ")}` : label);
  }
  return lines;
}

export function formatCopilotQuotaDetailed(quota: CopilotQuota): string {
  return [formatCopilotQuota(quota), quota.resetDate ? `Reset: ${quota.resetDate}` : undefined]
    .filter((value): value is string => Boolean(value))
    .join("\n");
}

export function formatCodexUsageDetailed(usage: CodexUsage): string {
  const heading = `Codex${usage.planType ? ` · ${title(usage.planType)}` : ""}`;
  return [
    heading,
    windowLine(usage.primaryWindow, "Primary"),
    windowLine(usage.secondaryWindow, "Secondary"),
    creditsLine(usage),
    spendLine(usage.spendControl?.individualLimit, usage.spendControl?.reached),
    usage.rateLimitReachedType
      ? `Reached limit: ${title(usage.rateLimitReachedType)}`
      : usage.limitReached
        ? "Reached limit: yes"
        : undefined,
    ...additionalLines(usage),
  ]
    .filter((value): value is string => Boolean(value))
    .join("\n");
}

export function formatUsage(provider: "github-copilot", value: CopilotQuota): string;
export function formatUsage(provider: "openai-codex", value: CodexUsage): string;
export function formatUsage(provider: UsageProvider, value: CopilotQuota | CodexUsage): string;
export function formatUsage(provider: UsageProvider, value: CopilotQuota | CodexUsage): string {
  return provider === "github-copilot"
    ? formatCopilotQuota(value as CopilotQuota)
    : formatCodexUsage(value as CodexUsage);
}

export function formatUsageDetailed(provider: "github-copilot", value: CopilotQuota): string;
export function formatUsageDetailed(provider: "openai-codex", value: CodexUsage): string;
export function formatUsageDetailed(
  provider: UsageProvider,
  value: CopilotQuota | CodexUsage,
): string;
export function formatUsageDetailed(
  provider: UsageProvider,
  value: CopilotQuota | CodexUsage,
): string {
  return provider === "github-copilot"
    ? formatCopilotQuotaDetailed(value as CopilotQuota)
    : formatCodexUsageDetailed(value as CodexUsage);
}
