import { createReadStream } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import {
  agentDirectory,
  type CopilotCreditSnapshot,
  type CopilotQuotaSnapshotInput,
  captureCopilotSnapshot as captureStoredCopilotSnapshot,
  loadCopilotSnapshotsInRange,
} from "../../shared/copilot-snapshots.js";

/** Canonical modes plus the legacy `week` spelling accepted by helpers. */
export type ReportMode = "workweek" | "all" | "month" | "week";
type PeriodMode = ReportMode;
type RecordValue = Record<string, unknown>;

type UsageRecord = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  uncategorized: number;
  cost: number;
};

export type UsageTotals = UsageRecord & {
  responses: number;
  sessions: Set<string>;
};

export type Bucket = UsageTotals & { key: string };

export type { CopilotCreditSnapshot } from "../../shared/copilot-snapshots.js";
export type CopilotQuotaLike = CopilotQuotaSnapshotInput;

export type CopilotQuotaFetcher = () => Promise<CopilotQuotaLike | undefined>;

export type StatsReport = {
  mode: ReportMode;
  /** Offset from the current period. Negative values address historical periods. */
  offset?: number;
  /** Bitbucket's historical name for offset; retained for report consumers. */
  weekOffset?: number;
  start: Date;
  end: Date;
  scannedFiles: number;
  unreadableFiles: number;
  totals: UsageTotals;
  subagents: UsageTotals;
  models: Map<string, Bucket>;
  projects: Map<string, Bucket>;
  /** Keys are local dates, or local period starts for monthly weekly rows. */
  days: Map<string, UsageTotals>;
  copilotSnapshots?: CopilotCreditSnapshot[];
};

const isRecord = (value: unknown): value is RecordValue =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));

const number = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value)
    ? value
    : typeof value === "string" && value.trim() && Number.isFinite(Number(value))
      ? Number(value)
      : 0;

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

const dayKey = (date: Date): string =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;

const midnight = (date: Date): Date =>
  new Date(date.getFullYear(), date.getMonth(), date.getDate());

function canonicalMode(mode: PeriodMode): Exclude<ReportMode, "week"> {
  return mode === "week" ? "workweek" : mode;
}

/** Return a Monday-based local calendar range for a stats report. */
export function periodRange(
  mode: PeriodMode,
  now = new Date(),
  offset = 0,
): { start: Date; end: Date } {
  const canonical = canonicalMode(mode);
  if (canonical === "month") {
    const start = new Date(now.getFullYear(), now.getMonth() + offset, 1);
    return { start, end: new Date(start.getFullYear(), start.getMonth() + 1, 1) };
  }

  const start = midnight(now);
  const weekday = start.getDay() || 7;
  start.setDate(start.getDate() - weekday + 1 + offset * 7);
  const end = new Date(start);
  end.setDate(end.getDate() + (canonical === "all" ? 7 : 5));
  return { start, end };
}

export function currentWeekRange(
  mode: Exclude<ReportMode, "month">,
  now = new Date(),
  weekOffset = 0,
): { start: Date; end: Date } {
  return periodRange(mode, now, weekOffset);
}

export function currentMonthRange(now = new Date(), monthOffset = 0): { start: Date; end: Date } {
  return periodRange("month", now, monthOffset);
}

export function sessionDirectory(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.PI_CODING_AGENT_SESSION_DIR?.trim();
  if (configured) return configured.replace(/^~(?=$|[\\/])/, homedir());
  return join(agentDirectory(env), "sessions");
}

/** Normal Pi sessions, hidden new Subagents, and the legacy Subagent tree. */
export function sessionDirectories(env: NodeJS.ProcessEnv = process.env): string[] {
  const root = agentDirectory(env);
  return [
    ...new Set([
      sessionDirectory(env),
      join(root, "subagents", "sessions"),
      join(root, "sessions", "subagents"),
    ]),
  ];
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

function usage(record: RecordValue): UsageRecord {
  // Normal Pi messages and summaries put usage under `usage`. Accepting a
  // direct record as a fallback keeps this reader compatible with older
  // persisted session-summary shapes without accepting arbitrary custom rows.
  const value = isRecord(record.usage) ? record.usage : record;
  const input = number(value.input ?? value.inputTokens ?? value.input_tokens);
  const output = number(value.output ?? value.outputTokens ?? value.output_tokens);
  const cacheRead = number(value.cacheRead ?? value.cacheReadTokens ?? value.cache_read);
  const cacheWrite = number(value.cacheWrite ?? value.cacheWriteTokens ?? value.cache_write);
  const total = number(value.total ?? value.totalTokens ?? value.total_tokens);
  const costValue = isRecord(value.cost)
    ? (value.cost.total ?? value.cost.totalCost)
    : (value.cost ?? value.cost_total);
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    uncategorized: Math.max(0, total - input - output - cacheRead - cacheWrite),
    cost: number(costValue),
  };
}

function hasUsage(source: UsageRecord): boolean {
  return (
    source.input !== 0 ||
    source.output !== 0 ||
    source.cacheRead !== 0 ||
    source.cacheWrite !== 0 ||
    source.uncategorized !== 0 ||
    source.cost !== 0
  );
}

function add(target: UsageTotals, source: UsageRecord, session: string): void {
  target.input += source.input;
  target.output += source.output;
  target.cacheRead += source.cacheRead;
  target.cacheWrite += source.cacheWrite;
  target.uncategorized += source.uncategorized;
  target.cost += source.cost;
  // Pi's tool-result stream can contain empty usage records. Keep those
  // records' sessions, but only count a response when it contributes usage.
  if (hasUsage(source)) target.responses += 1;
  target.sessions.add(session);
}

function addBucket(
  map: Map<string, Bucket>,
  key: string,
  value: UsageRecord,
  session: string,
): void {
  const bucket = map.get(key) ?? { key, ...emptyTotals() };
  add(bucket, value, session);
  map.set(key, bucket);
}

function parsedDate(value: unknown): Date | undefined {
  const date = new Date(
    typeof value === "number" ? value : typeof value === "string" ? value : Number.NaN,
  );
  return Number.isFinite(date.getTime()) ? date : undefined;
}

function localWeekStart(date: Date): Date {
  const start = midnight(date);
  const sundayBasedDay = start.getDay();
  const daysSinceMonday = sundayBasedDay === 0 ? 6 : sundayBasedDay - 1;
  start.setDate(start.getDate() - daysSinceMonday);
  return start;
}

function monthPeriodStart(date: Date, monthStart: Date): Date {
  const weekStart = localWeekStart(date);
  return weekStart < monthStart ? new Date(monthStart) : weekStart;
}

function periodStarts(
  mode: Exclude<ReportMode, "week">,
  range: { start: Date; end: Date },
): Date[] {
  if (mode === "month") {
    const starts = [new Date(range.start)];
    const nextMonday = localWeekStart(range.start);
    nextMonday.setDate(nextMonday.getDate() + 7);
    for (let date = nextMonday; date < range.end; date.setDate(date.getDate() + 7)) {
      starts.push(new Date(date));
    }
    return starts;
  }
  return Array.from({ length: mode === "all" ? 7 : 5 }, (_, index) => {
    const date = new Date(range.start);
    date.setDate(date.getDate() + index);
    return date;
  });
}

async function files(directories: string[]): Promise<string[]> {
  const pending = [...directories];
  const found = new Set<string>();
  while (pending.length) {
    const current = pending.pop();
    if (!current) continue;
    try {
      for (const entry of await readdir(current, { withFileTypes: true })) {
        const path = join(current, entry.name);
        if (entry.isDirectory()) pending.push(path);
        else if (entry.isFile() && entry.name.endsWith(".jsonl")) found.add(path);
      }
    } catch {
      /* An absent or unreadable directory is an empty source. */
    }
  }
  return [...found].sort();
}

function isSubagentSession(path: string): boolean {
  return path.split(/[\\/]/).includes("subagents");
}

function modelKey(record: RecordValue, activeModel: string): string {
  const provider = text(record.provider);
  const id = text(record.model ?? record.modelId);
  if (provider && id) return `${provider}/${id}`;
  return id ?? activeModel;
}

function customSummaryRecord(
  entry: RecordValue,
): { record: RecordValue; model: string; timestamp: unknown } | undefined {
  if (entry.type !== "custom" || entry.customType !== "session-summary") return undefined;

  const data = isRecord(entry.data) ? entry.data : undefined;
  // A summary with attached usage is already represented by the provider
  // message that produced it. Counting it again would inflate every total.
  if (data?.usageAttached === true || entry.usageAttached === true) return undefined;

  // Historical session-summary entries store their usage in data.usage. A
  // direct entry.usage variant was used by an older writer and is harmless to
  // support, but arbitrary custom entries never reach this path.
  const record = data && isRecord(data.usage) ? data : isRecord(entry.usage) ? entry : undefined;
  if (!record) return undefined;

  const provider = text(record.provider);
  const id = text(record.model ?? record.modelId);
  const model = provider && id ? `${provider}/${id}` : (id ?? "github-copilot/gpt-5.4-nano");
  return { record, model, timestamp: record.timestamp ?? entry.timestamp };
}

async function collectFile(
  path: string,
  range: { start: Date; end: Date },
  report: StatsReport,
): Promise<void> {
  let session = path;
  let project = "unknown project";
  let activeModel = "unknown model";
  const subagent = isSubagentSession(path);
  const input = createInterface({
    input: createReadStream(path, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  const mode = report.mode;

  for await (const line of input) {
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(entry)) continue;

    if (entry.type === "session") {
      session = text(entry.id) ?? session;
      project = text(entry.cwd) ?? project;
      continue;
    }

    if (entry.type === "model_change") {
      const provider = text(entry.provider);
      const id = text(entry.modelId ?? entry.model);
      activeModel = provider && id ? `${provider}/${id}` : (id ?? activeModel);
      continue;
    }

    let record: RecordValue | undefined;
    let currentModel = activeModel;
    let timestampValue: unknown;

    if (entry.type === "message" && isRecord(entry.message)) {
      const message = entry.message;
      if (!["assistant", "toolResult"].includes(String(message.role))) continue;
      record = message;
      currentModel = modelKey(message, activeModel);
      timestampValue = message.timestamp ?? entry.timestamp;
    } else if (entry.type === "compaction" || entry.type === "branch_summary") {
      record = entry;
      timestampValue = entry.timestamp;
    } else {
      const summary = customSummaryRecord(entry);
      if (!summary) continue;
      record = summary.record;
      currentModel = summary.model;
      timestampValue = summary.timestamp;
    }

    const timestamp = parsedDate(timestampValue ?? record.timestamp);
    if (!timestamp || timestamp < range.start || timestamp >= range.end) continue;

    const value = usage(record);
    add(report.totals, value, session);
    if (subagent) add(report.subagents, value, session);
    addBucket(report.models, currentModel, value, session);
    addBucket(report.projects, project, value, session);

    const periodDate = mode === "month" ? monthPeriodStart(timestamp, range.start) : timestamp;
    const day = report.days.get(dayKey(periodDate)) ?? emptyTotals();
    add(day, value, session);
    report.days.set(dayKey(periodDate), day);
  }
}

export type CollectStatsOptions = {
  mode?: PeriodMode;
  offset?: number;
  now?: Date;
  directory?: string;
  directories?: string[];
  /** Environment override used by tests and alternate Pi installations. */
  env?: NodeJS.ProcessEnv;
};

export async function collectStats(options: CollectStatsOptions = {}): Promise<StatsReport> {
  const mode = canonicalMode(options.mode ?? "workweek");
  const offset = options.offset ?? 0;
  const { start, end } = periodRange(mode, options.now, offset);
  const report: StatsReport = {
    mode,
    offset,
    weekOffset: offset,
    start,
    end,
    scannedFiles: 0,
    unreadableFiles: 0,
    totals: emptyTotals(),
    subagents: emptyTotals(),
    models: new Map(),
    projects: new Map(),
    days: new Map(),
    copilotSnapshots: [],
  };
  const env = options.env ?? process.env;
  const sessionFiles = await files(
    options.directories ?? (options.directory ? [options.directory] : sessionDirectories(env)),
  );
  report.scannedFiles = sessionFiles.length;
  for (const path of sessionFiles) {
    try {
      await collectFile(path, { start, end }, report);
    } catch {
      report.unreadableFiles += 1;
    }
  }
  // Keep the data model complete as well as the rendered report: empty days
  // (or empty monthly weekly periods) remain visible to report consumers.
  for (const date of periodStarts(mode, { start, end })) {
    const key = dayKey(date);
    if (!report.days.has(key)) report.days.set(key, emptyTotals());
  }
  report.copilotSnapshots = await loadCopilotSnapshotsInRange({ start, end }, env);
  return report;
}

export { agentDirectory, copilotSnapshotPath } from "../../shared/copilot-snapshots.js";

/** Capture one optional account-level Copilot checkpoint for the local day. */
export async function captureCopilotSnapshot(
  fetchQuota: CopilotQuotaFetcher,
  env: NodeJS.ProcessEnv = process.env,
  now = new Date(),
): Promise<void> {
  await captureStoredCopilotSnapshot(fetchQuota, env, now);
}

export async function loadCopilotSnapshots(
  range: { start: Date; end: Date },
  env: NodeJS.ProcessEnv = process.env,
): Promise<CopilotCreditSnapshot[]> {
  return loadCopilotSnapshotsInRange(range, env);
}
