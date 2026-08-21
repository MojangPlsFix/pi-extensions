import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isCopilotModel } from "../../shared/provider.js";
import {
  fetchCopilotQuota,
  type fetchProviderUsage,
  formatUsageDetailed,
  type ProviderUsageResult,
  providerLabel,
  usageProviderForModel,
} from "../usage-meter/index.js";
import { buildReport, parseStatsArgs } from "./report.js";
import { captureCopilotSnapshot, collectStats } from "./stats.js";
import { StatsViewer } from "./viewer.js";

export type { ReportOptions } from "./report.js";
export {
  buildReport,
  formatCompactTokens,
  formatMoney,
  formatTokens,
  parseMode,
  parseStatsArgs,
  tokenTotal,
  totalTokens,
} from "./report.js";
export type {
  Bucket,
  CollectStatsOptions,
  CopilotCreditSnapshot,
  CopilotQuotaFetcher,
  CopilotQuotaLike,
  ReportMode,
  StatsReport,
  UsageTotals,
} from "./stats.js";
export {
  agentDirectory,
  captureCopilotSnapshot,
  collectStats,
  copilotSnapshotPath,
  currentMonthRange,
  currentWeekRange,
  loadCopilotSnapshots,
  periodRange,
  sessionDirectories,
  sessionDirectory,
} from "./stats.js";
export { StatsViewer } from "./viewer.js";

const quotaHeading = "Current provider quota (live; not included in period totals)";

/**
 * Kept as a consumer/test compatibility helper. The normal stats command does
 * not request live Usage Meter data; the standalone Usage Meter owns that UI.
 */
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
  /** Legacy injected live-quota hook retained for deterministic consumers. */
  fetchQuota?: typeof fetchProviderUsage;
  /** Wait for an optional startup task before reading historical files. */
  beforeCollect?: () => Promise<void> | void;
};

/** Exposed for deterministic command tests and alternate extension hosts. */
export function registerStats(pi: ExtensionAPI, options: StatsExtensionOptions = {}): void {
  const collect = options.collect ?? collectStats;
  const fetchQuota = options.fetchQuota;
  pi.registerCommand("stats", {
    description:
      "Show Pi usage by period, model, project, and Hackler subset; use arrows to browse history.",
    getArgumentCompletions: (prefix) =>
      ["all", "workweek", "week", "month", "previous", "-1"]
        .filter((value) => value.startsWith(prefix.trim().toLowerCase()))
        .map((value) => ({ value, label: value })),
    handler: async (args, ctx) => {
      const parsed = parseStatsArgs(args);
      if (!parsed)
        return void ctx.ui.notify(
          "Usage: /stats [all|workweek|week|month] [previous|-1|-2]",
          "warning",
        );

      if (options.beforeCollect) await options.beforeCollect();
      ctx.ui.notify(
        fetchQuota
          ? "Reading Pi session history and current provider quota…"
          : "Reading Pi session history…",
        "info",
      );
      const supportedProvider = usageProviderForModel(ctx.model);
      // This compatibility path is opt-in. The shipped stats extension leaves
      // provider quota fetching to the separate Usage Meter extension.
      const quotaRequest =
        fetchQuota && supportedProvider
          ? fetchQuota(ctx.model, ctx.modelRegistry).catch(() => ({ provider: supportedProvider }))
          : Promise.resolve(undefined);
      const [statsReport, quotaResult] = await Promise.all([collect(parsed), quotaRequest]);
      const report = buildReport(
        statsReport,
        fetchQuota
          ? {
              liveProviderQuota: formatLiveProviderQuota(
                quotaResult,
                typeof ctx.model?.provider === "string" ? ctx.model.provider : undefined,
              ),
            }
          : undefined,
      );

      if (ctx.mode === "tui" && ctx.hasUI && typeof ctx.ui.custom === "function") {
        let mode = parsed.mode;
        let offset = parsed.offset;
        await ctx.ui.custom<void>(
          (tui, theme, keybindings, done) =>
            new StatsViewer(
              tui,
              theme,
              keybindings,
              mode,
              report,
              () => done(undefined),
              async (delta) => {
                offset = Math.min(0, offset + delta);
                return buildReport(await collect({ mode, offset }));
              },
              async (nextMode) => {
                mode = nextMode;
                offset = 0;
                return buildReport(await collect({ mode, offset }));
              },
            ),
          {
            overlay: true,
            overlayOptions: {
              anchor: "center",
              width: "92%",
              maxHeight: "84%",
              minWidth: 60,
              margin: 1,
            },
          },
        );
      } else if (ctx.mode === "tui" && ctx.hasUI && typeof ctx.ui.editor === "function") {
        // Test hosts and older interactive runtimes without custom overlays
        // still receive the complete read-only report.
        await ctx.ui.editor("Session statistics (read-only)", report);
      } else {
        ctx.ui.setWidget("pi-extensions:stats", report.split("\n"), {
          placement: "aboveEditor",
        });
      }
    },
  });
}

/** Register optional daily Copilot history without touching other providers. */
export function registerCopilotSnapshots(
  pi: ExtensionAPI,
  fetchQuota: typeof fetchCopilotQuota = fetchCopilotQuota,
): () => Promise<void> {
  let dailySnapshotPromise: Promise<void> | undefined;
  const captureFor = (ctx: ExtensionContext): void => {
    if (!isCopilotModel(ctx.model)) return;
    // captureCopilotSnapshot is itself fail-open; keep the promise so /stats
    // can include the just-captured date without racing the write.
    dailySnapshotPromise = captureCopilotSnapshot(fetchQuota).catch(() => {});
  };
  pi.on("session_start", (_event, ctx) => captureFor(ctx));
  pi.on("model_select", (_event, ctx) => captureFor(ctx));
  return () => dailySnapshotPromise ?? Promise.resolve();
}

export default function statsExtension(pi: ExtensionAPI): void {
  const waitForSnapshot = registerCopilotSnapshots(pi);
  registerStats(pi, { beforeCollect: waitForSnapshot });
}
