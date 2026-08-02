export type UsageProvider = "github-copilot" | "openai-codex";

export type CopilotQuota = {
  remaining: number;
  total?: number;
  unlimited: boolean;
  percentRemaining?: number;
  unit: "ai_credits" | "premium_requests";
  resetDate?: string;
};

export type CodexUsageWindow = {
  usedPercent?: number;
  limitWindowSeconds?: number;
  resetAfterSeconds?: number;
  resetAt?: string | number;
  reached?: boolean;
};

export type CodexCredits = {
  hasCredits?: boolean;
  unlimited?: boolean;
  balance?: string;
  /** Tolerated alternate aggregate credit fields returned by some deployments. */
  used?: number;
  remaining?: number;
  total?: number;
};

export type CodexSpendLimit = {
  source?: string;
  limit?: string;
  used?: string;
  remaining?: string;
  usedPercent?: number;
  remainingPercent?: number;
  resetAfterSeconds?: number;
  resetAt?: string | number;
};

export type CodexSpendControl = {
  individualLimit?: CodexSpendLimit;
  reached?: boolean;
};

export type CodexRateLimit = {
  allowed?: boolean;
  limitReached?: boolean;
  primaryWindow?: CodexUsageWindow;
  secondaryWindow?: CodexUsageWindow;
};

export type CodexAdditionalRateLimit = {
  name?: string;
  meteredFeature?: string;
  rateLimit?: CodexRateLimit;
};

/** Bounded metadata returned by Codex /wham/usage and x-codex-* response headers. */
export type CodexUsage = {
  planType?: string;
  credits?: CodexCredits;
  spendControl?: CodexSpendControl;
  additionalRateLimits?: CodexAdditionalRateLimit[];
  allowed?: boolean;
  limitReached?: boolean;
  rateLimitReachedType?: string;
  primaryWindow?: CodexUsageWindow;
  secondaryWindow?: CodexUsageWindow;
};

export type UsageSnapshot =
  | { provider: "github-copilot"; quota: CopilotQuota }
  | { provider: "openai-codex"; usage: CodexUsage };

export type UsageMeterOptions = {
  fetchCopilotQuota?: () => Promise<CopilotQuota | undefined>;
  fetchCodexUsage?: () => Promise<CodexUsage | undefined>;
  copilotRefreshIntervalMs?: number;
  codexRefreshIntervalMs?: number;
};
