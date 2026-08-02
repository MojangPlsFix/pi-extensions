import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  fetchProviderUsage,
  formatUsageDetailed,
  type ProviderUsageResult,
  providerLabel,
  usageProviderForModel,
} from "../usage-meter/index.js";
import { buildReport, parseStatsArgs } from "./report.js";
import { collectStats } from "./stats.js";

export type { ReportOptions } from "./report.js";
export { buildReport, parseStatsArgs } from "./report.js";
export type { Bucket, ReportMode, StatsReport, UsageTotals } from "./stats.js";
export { collectStats, periodRange, sessionDirectories, sessionDirectory } from "./stats.js";

const quotaHeading = "Current provider quota (live; not included in period totals)";

export function formatLiveProviderQuota(
  result: ProviderUsageResult | undefined,
  activeProvider?: string,
): string {
  if (!result)
    return [
      quotaHeading,
      `  Live quota is not supported${activeProvider ? ` for ${activeProvider}` : " for the active provider"}.`,
    ].join("\n");
  if (!result.snapshot)
    return [quotaHeading, `  ${providerLabel(result.provider)} quota unavailable.`].join("\n");
  const snapshot = result.snapshot;
  const details = formatUsageDetailed(
    snapshot.provider,
    "quota" in snapshot ? snapshot.quota : snapshot.usage,
  );
  return [quotaHeading, ...details.split("\n").map((line) => `  ${line}`)].join("\n");
}

export type StatsExtensionOptions = {
  collect?: typeof collectStats;
  fetchQuota?: typeof fetchProviderUsage;
};

/** Exposed for deterministic command tests; normal runtime uses local history and live routing. */
export function registerStats(pi: ExtensionAPI, options: StatsExtensionOptions = {}): void {
  const collect = options.collect ?? collectStats;
  const fetchQuota = options.fetchQuota ?? fetchProviderUsage;
  pi.registerCommand("stats", {
    description:
      "Show Pi usage by period, model, project, and subagent subset with separate live quota.",
    getArgumentCompletions: (prefix) =>
      ["workweek", "week", "month", "previous", "-1"]
        .filter((value) => value.startsWith(prefix.trim().toLowerCase()))
        .map((value) => ({ value, label: value })),
    handler: async (args, ctx) => {
      const parsed = parseStatsArgs(args);
      if (!parsed)
        return void ctx.ui.notify(
          "Usage: /stats [workweek|week|month] [previous|-1|-2]",
          "warning",
        );
      ctx.ui.notify("Reading Pi session history and current provider quota…", "info");
      const supportedProvider = usageProviderForModel(ctx.model);
      const quotaRequest = supportedProvider
        ? fetchQuota(ctx.model, ctx.modelRegistry).catch(() => ({ provider: supportedProvider }))
        : Promise.resolve(undefined);
      const [statsReport, quotaResult] = await Promise.all([collect(parsed), quotaRequest]);
      const report = buildReport(statsReport, {
        liveProviderQuota: formatLiveProviderQuota(
          quotaResult,
          typeof ctx.model?.provider === "string" ? ctx.model.provider : undefined,
        ),
      });
      if (ctx.mode === "tui" && ctx.hasUI)
        await ctx.ui.editor("Session statistics (read-only)", report);
      else
        ctx.ui.setWidget("pi-extensions:stats", report.split("\n"), {
          placement: "aboveEditor",
        });
    },
  });
}

export default function statsExtension(pi: ExtensionAPI): void {
  registerStats(pi);
}
