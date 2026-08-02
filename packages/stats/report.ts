import type { Bucket, ReportMode, StatsReport, UsageTotals } from "./stats.js";

const totalTokens = (total: UsageTotals): number =>
  total.input + total.output + total.cacheRead + total.cacheWrite + total.uncategorized;
const compactTokens = (value: number): string =>
  value >= 1_000_000
    ? `${(value / 1_000_000).toFixed(1)}M`
    : value >= 1_000
      ? `${(value / 1_000).toFixed(1)}k`
      : String(Math.round(value));
const totalsLine = (label: string, total: UsageTotals): string =>
  `${label}: ${compactTokens(totalTokens(total))} tokens · ${total.responses} responses · $${total.cost.toFixed(4)} · ${total.sessions.size} sessions`;
export type ReportOptions = { liveProviderQuota?: string };

export function buildReport(report: StatsReport, options: ReportOptions = {}): string {
  const heading = `${report.mode} · ${report.start.toLocaleDateString()} – ${new Date(report.end.getTime() - 1).toLocaleDateString()}`;
  const bucketLines = (label: string, buckets: Map<string, Bucket>): string[] => [
    label,
    ...[...buckets.values()]
      .sort((a, b) => totalTokens(b) - totalTokens(a))
      .map(
        (bucket) =>
          `  ${bucket.key}: ${compactTokens(totalTokens(bucket))} · $${bucket.cost.toFixed(4)}`,
      ),
  ];
  return [
    heading,
    "",
    totalsLine("Total", report.totals),
    totalsLine("Subagents (included above)", report.subagents),
    "",
    ...bucketLines("Models", report.models),
    "",
    ...bucketLines("Projects", report.projects),
    "",
    `Scanned ${report.scannedFiles} session files${report.unreadableFiles ? `; ${report.unreadableFiles} unreadable` : ""}.`,
    ...(options.liveProviderQuota ? ["", options.liveProviderQuota] : []),
  ].join("\n");
}

export function parseStatsArgs(args: string): { mode: ReportMode; offset: number } | undefined {
  let mode: ReportMode = "workweek";
  let offset = 0;
  for (const token of args.trim().toLowerCase().split(/\s+/).filter(Boolean)) {
    if (token === "workweek") mode = "workweek";
    else if (token === "week" || token === "all") mode = "week";
    else if (token === "month") mode = "month";
    else if (["previous", "prev", "last"].includes(token)) offset = -1;
    else if (/^-\d+$/.test(token)) offset = Number(token);
    else return undefined;
  }
  return { mode, offset };
}
