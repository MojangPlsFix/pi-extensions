import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { buildReport, parseStatsArgs } from "./report.js";
import { collectStats } from "./stats.js";

export { buildReport, parseStatsArgs } from "./report.js";
export type { Bucket, ReportMode, StatsReport, UsageTotals } from "./stats.js";
export { collectStats, periodRange, sessionDirectories, sessionDirectory } from "./stats.js";

export default function statsExtension(pi: ExtensionAPI): void {
  pi.registerCommand("stats", {
    description: "Show generic Pi usage by period, model, project, and subagent subset.",
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
      ctx.ui.notify("Reading Pi session history…", "info");
      const report = buildReport(await collectStats(parsed));
      if (ctx.mode === "tui" && ctx.hasUI)
        await ctx.ui.editor("Session statistics (read-only)", report);
      else
        ctx.ui.setWidget("pi-extensions:stats", report.split("\n"), { placement: "aboveEditor" });
    },
  });
}
