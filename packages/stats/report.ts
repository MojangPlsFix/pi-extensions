import { homedir } from "node:os";
import type { Bucket, ReportMode, StatsReport, UsageTotals } from "./stats.js";

export type ReportOptions = {
  /** Legacy test/consumer hook. Production stats uses historical snapshots instead. */
  liveProviderQuota?: string;
};

export const totalTokens = (total: UsageTotals): number =>
  total.input + total.output + total.cacheRead + total.cacheWrite + total.uncategorized;

export function formatTokens(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

export function formatCompactTokens(value: number): string {
  const absolute = Math.abs(value);
  if (absolute < 1_000) return formatTokens(value);
  if (absolute < 1_000_000) return `${(value / 1_000).toFixed(1)}k`;
  if (absolute < 1_000_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  return `${(value / 1_000_000_000).toFixed(1)}B`;
}

export function formatMoney(value: number): string {
  if (!Number.isFinite(value) || value === 0) return "$0.00";
  const decimals = Math.abs(value) < 0.01 ? 6 : 4;
  return `$${value.toFixed(decimals)}`;
}

function emptyTotals(): UsageTotals {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    uncategorized: 0,
    cost: 0,
    responses: 0,
    sessions: new Set(),
  };
}

function dayKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function localMidnight(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function localWeekStart(date: Date): Date {
  const start = localMidnight(date);
  const sundayBasedDay = start.getDay();
  const daysSinceMonday = sundayBasedDay === 0 ? 6 : sundayBasedDay - 1;
  start.setDate(start.getDate() - daysSinceMonday);
  return start;
}

function monthWeekStarts(range: { start: Date; end: Date }): Date[] {
  const starts = [new Date(range.start)];
  const nextMonday = localWeekStart(range.start);
  nextMonday.setDate(nextMonday.getDate() + 7);
  for (let date = nextMonday; date < range.end; date.setDate(date.getDate() + 7)) {
    starts.push(new Date(date));
  }
  return starts;
}

function periodStarts(report: StatsReport): Date[] {
  if (report.mode === "month") return monthWeekStarts(report);
  return Array.from({ length: report.mode === "all" ? 7 : 5 }, (_, index) => {
    const date = new Date(report.start);
    date.setDate(date.getDate() + index);
    return date;
  });
}

function formatDate(date: Date, options: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat(undefined, options).format(date);
}

function formatRange(report: StatsReport): string {
  const end = new Date(report.end);
  end.setDate(end.getDate() - 1);
  const startText = formatDate(report.start, { month: "short", day: "numeric" });
  const endText = formatDate(end, { month: "short", day: "numeric", year: "numeric" });
  return `${startText} – ${endText} (local time)`;
}

function sortedBuckets(buckets: Map<string, Bucket>): Bucket[] {
  return [...buckets.values()].sort((a, b) => {
    return b.cost - a.cost || totalTokens(b) - totalTokens(a) || a.key.localeCompare(b.key);
  });
}

function shortenProject(value: string): string {
  const home = homedir();
  const display = value.startsWith(home) ? `~${value.slice(home.length)}` : value;
  return display.length > 56 ? `…${display.slice(-55)}` : display;
}

function bucketLine(bucket: Bucket, includeProjectPath = false): string {
  const key = includeProjectPath ? shortenProject(bucket.key) : bucket.key;
  return `  ${key} · ${formatMoney(bucket.cost)} · ${formatCompactTokens(totalTokens(bucket))} tokens · ${bucket.responses} responses · ${bucket.sessions.size} sessions`;
}

function monthWeekLabel(report: StatsReport, start: Date, index: number): string {
  const end = new Date(start);
  end.setDate(end.getDate() + 6);
  const lastDay = new Date(report.end);
  lastDay.setDate(lastDay.getDate() - 1);
  if (end > lastDay) end.setTime(lastDay.getTime());

  const startText = formatDate(start, { month: "short", day: "numeric" });
  const endText = formatDate(end, { month: "short", day: "numeric" });
  const range = startText === endText ? startText : `${startText}–${endText}`;
  return `Week ${index + 1} (${range})`;
}

function offsetOf(report: StatsReport): number {
  return report.offset ?? report.weekOffset ?? 0;
}

function periodLabel(report: StatsReport): string {
  if (report.mode === "month") return "Calendar month";
  return report.mode === "all" ? "All days (Mon–Sun)" : "Work week (Mon–Fri)";
}

function historicalLabel(report: StatsReport): string {
  const offset = offsetOf(report);
  if (offset === 0) return "";
  const count = Math.abs(offset);
  const unit = report.mode === "month" ? "month" : "week";
  return ` · ${count} ${unit}${count === 1 ? "" : "s"} ago`;
}

export function buildReport(report: StatsReport, options: ReportOptions = {}): string {
  const totals = report.totals;
  const snapshots = report.copilotSnapshots ?? [];
  const rows = periodStarts(report).map((date, index) => {
    const bucket = report.days.get(dayKey(date)) ?? emptyTotals();
    const label =
      report.mode === "month"
        ? monthWeekLabel(report, date, index)
        : formatDate(date, { weekday: "short", month: "short", day: "numeric" });
    const labelWidth = report.mode === "month" ? 22 : 12;
    const startSnapshot =
      report.mode === "month"
        ? undefined
        : snapshots.find((snapshot) => snapshot.date === dayKey(date));
    const startCredits = startSnapshot ? formatTokens(startSnapshot.used) : "—";
    const startCreditsColumn = report.mode === "month" ? "" : ` ${startCredits.padStart(13)}`;
    return `  ${label.padEnd(labelWidth)} ${formatMoney(bucket.cost).padStart(10)} ${formatCompactTokens(totalTokens(bucket)).padStart(10)} ${formatTokens(bucket.responses).padStart(10)} ${formatTokens(bucket.sessions.size).padStart(8)}${startCreditsColumn}`;
  });

  const lines = [
    `Pi usage · ${periodLabel(report)}${historicalLabel(report)}`,
    `${formatRange(report)} · all workspaces`,
    "",
    "SUMMARY",
    `  Cost          ${formatMoney(totals.cost)}`,
    `  Responses     ${formatTokens(totals.responses)}`,
    `  Sessions      ${formatTokens(totals.sessions.size)}`,
    `  Tokens        ${formatCompactTokens(totalTokens(totals))} (${formatTokens(totalTokens(totals))})`,
    `    input       ${formatCompactTokens(totals.input)}`,
    `    output      ${formatCompactTokens(totals.output)}`,
    `    cache read  ${formatCompactTokens(totals.cacheRead)}`,
    `    cache write ${formatCompactTokens(totals.cacheWrite)}`,
    ...(totals.uncategorized
      ? [`    other       ${formatCompactTokens(totals.uncategorized)}`]
      : []),
    "",
    "SUBAGENTS (included above)",
    `  Cost          ${formatMoney(report.subagents.cost)}`,
    `  Responses     ${formatTokens(report.subagents.responses)}`,
    `  Sessions      ${formatTokens(report.subagents.sessions.size)}`,
    `  Tokens        ${formatCompactTokens(totalTokens(report.subagents))}`,
    "",
    report.mode === "month" ? "WEEKLY" : "DAILY",
    report.mode === "month"
      ? `  ${"Week".padEnd(22)} ${"Cost".padStart(10)} ${"Tokens".padStart(10)} ${"Responses".padStart(10)} ${"Sessions".padStart(8)}`
      : `  ${"Day".padEnd(12)} ${"Cost".padStart(10)} ${"Tokens".padStart(10)} ${"Responses".padStart(10)} ${"Sessions".padStart(8)} ${"Start Credits".padStart(13)}`,
    ...rows,
    "",
    "MODELS",
    ...(report.models.size > 0
      ? sortedBuckets(report.models).map((bucket) => bucketLine(bucket))
      : ["  none"]),
    "",
    "PROJECTS",
    ...(report.projects.size > 0
      ? sortedBuckets(report.projects).map((bucket) => bucketLine(bucket, true))
      : ["  none"]),
    "",
    `Scanned ${report.scannedFiles} session files${report.unreadableFiles ? ` · ${report.unreadableFiles} unreadable` : ""}. Recorded Pi costs; missing pricing appears as $0.00.`,
  ];

  if (options.liveProviderQuota) lines.push("", options.liveProviderQuota);
  return lines.join("\n");
}

export function parseStatsArgs(args: string): { mode: ReportMode; offset: number } | undefined {
  let mode: ReportMode = "workweek";
  let offset = 0;
  for (const token of args.trim().toLowerCase().split(/\s+/).filter(Boolean)) {
    if (token === "all") mode = "all";
    else if (token === "workweek" || token === "week") mode = "workweek";
    else if (token === "month") mode = "month";
    else if (["previous", "prev", "last"].includes(token)) offset = -1;
    else if (/^-\d+$/.test(token)) offset = Number(token);
    else return undefined;
  }
  return { mode, offset };
}

/** Compatibility helper matching the original Bitbucket stats module. */
export function parseMode(args: string): ReportMode | "invalid" {
  const parsed = parseStatsArgs(args);
  return parsed?.mode ?? "invalid";
}

/** Compatibility alias used by older report consumers. */
export const tokenTotal = totalTokens;
