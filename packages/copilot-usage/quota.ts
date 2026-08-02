type RecordValue = Record<string, unknown>;
export type CopilotQuota = {
  remaining: number;
  total?: number;
  unlimited: boolean;
  percentRemaining?: number;
  unit: "ai_credits" | "premium_requests";
  resetDate?: string;
};

const record = (value: unknown): value is RecordValue =>
  Boolean(value && typeof value === "object");
const finite = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value)
    ? value
    : typeof value === "string" && value.trim() && Number.isFinite(Number(value))
      ? Number(value)
      : undefined;
const string = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

/** Parses the provider response without retaining any authentication material. */
export function parseCopilotQuota(value: unknown): CopilotQuota | undefined {
  if (!record(value) || !record(value.quota_snapshots)) return undefined;
  const snapshots = value.quota_snapshots;
  const quota = record(snapshots.premium_models)
    ? snapshots.premium_models
    : record(snapshots.premium_interactions)
      ? snapshots.premium_interactions
      : undefined;
  if (!quota) return undefined;
  const tokenBilling = value.token_based_billing === true;
  const total = tokenBilling
    ? (finite(quota.entitlement) ?? finite(quota.total))
    : (finite(quota.total) ?? finite(quota.entitlement));
  const percentRemaining = finite(quota.percent_remaining);
  const remaining =
    finite(quota.remaining) ??
    finite(quota.quota_remaining) ??
    (total !== undefined && percentRemaining !== undefined ? (total * percentRemaining) / 100 : 0);
  return {
    remaining,
    ...(total === undefined ? {} : { total }),
    unlimited: quota.unlimited === true || total === -1,
    ...(percentRemaining === undefined ? {} : { percentRemaining }),
    unit: tokenBilling ? "ai_credits" : "premium_requests",
    ...(string(value.quota_reset_date_utc) ||
    string(value.quota_reset_date) ||
    string(quota.reset_date)
      ? {
          resetDate:
            string(value.quota_reset_date_utc) ??
            string(value.quota_reset_date) ??
            string(quota.reset_date),
        }
      : {}),
  };
}
