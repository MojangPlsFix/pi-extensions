import { createReadStream } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

export type ReportMode = "workweek" | "week" | "month";
type RecordValue = Record<string, unknown>;
export type UsageTotals = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  uncategorized: number;
  cost: number;
  responses: number;
  sessions: Set<string>;
};
export type Bucket = UsageTotals & { key: string };
export type StatsReport = {
  mode: ReportMode;
  start: Date;
  end: Date;
  scannedFiles: number;
  unreadableFiles: number;
  totals: UsageTotals;
  subagents: UsageTotals;
  models: Map<string, Bucket>;
  projects: Map<string, Bucket>;
  days: Map<string, UsageTotals>;
};

const isRecord = (value: unknown): value is RecordValue =>
  Boolean(value && typeof value === "object");
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

export function periodRange(
  mode: ReportMode,
  now = new Date(),
  offset = 0,
): { start: Date; end: Date } {
  if (mode === "month") {
    const start = new Date(now.getFullYear(), now.getMonth() + offset, 1);
    return { start, end: new Date(start.getFullYear(), start.getMonth() + 1, 1) };
  }
  const start = midnight(now);
  const weekday = start.getDay() || 7;
  start.setDate(start.getDate() - weekday + 1 + offset * 7);
  const end = new Date(start);
  end.setDate(end.getDate() + (mode === "workweek" ? 5 : 7));
  return { start, end };
}

export function sessionDirectory(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.PI_CODING_AGENT_SESSION_DIR?.trim();
  if (configured) return configured.replace(/^~(?=$|[\\/])/, homedir());
  const agentDirectory =
    env.PI_CODING_AGENT_DIR?.trim()?.replace(/^~(?=$|[\\/])/, homedir()) ||
    join(homedir(), ".pi", "agent");
  return join(agentDirectory, "sessions");
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
function usage(record: RecordValue): Omit<UsageTotals, "responses" | "sessions"> {
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
function hasUsage(source: ReturnType<typeof usage>): boolean {
  return (
    source.input !== 0 ||
    source.output !== 0 ||
    source.cacheRead !== 0 ||
    source.cacheWrite !== 0 ||
    source.uncategorized !== 0 ||
    source.cost !== 0
  );
}
function add(target: UsageTotals, source: ReturnType<typeof usage>, session: string): void {
  target.input += source.input;
  target.output += source.output;
  target.cacheRead += source.cacheRead;
  target.cacheWrite += source.cacheWrite;
  target.uncategorized += source.uncategorized;
  target.cost += source.cost;
  if (hasUsage(source)) target.responses += 1;
  target.sessions.add(session);
}
function addBucket(
  map: Map<string, Bucket>,
  key: string,
  value: ReturnType<typeof usage>,
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
async function files(directory: string): Promise<string[]> {
  const pending = [directory];
  const found: string[] = [];
  while (pending.length) {
    const current = pending.pop();
    if (!current) continue;
    try {
      for (const entry of await readdir(current, { withFileTypes: true })) {
        const path = join(current, entry.name);
        if (entry.isDirectory()) pending.push(path);
        else if (entry.isFile() && entry.name.endsWith(".jsonl")) found.push(path);
      }
    } catch {
      /* an absent or unreadable directory is an empty source */
    }
  }
  return found.sort();
}

async function collectFile(
  path: string,
  range: { start: Date; end: Date },
  report: StatsReport,
): Promise<void> {
  let session = path;
  let project = "unknown project";
  let model = "unknown model";
  const subagent = path.split(/[\\/]/).includes("subagents");
  const input = createInterface({
    input: createReadStream(path, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
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
      model = provider && id ? `${provider}/${id}` : (id ?? model);
      continue;
    }
    let record: RecordValue | undefined;
    let currentModel = model;
    if (
      entry.type === "message" &&
      isRecord(entry.message) &&
      ["assistant", "toolResult"].includes(String(entry.message.role))
    ) {
      record = entry.message;
      const provider = text(record.provider);
      const id = text(record.model ?? record.modelId);
      currentModel = provider && id ? `${provider}/${id}` : (id ?? model);
    } else if (entry.type === "compaction" || entry.type === "branch_summary") record = entry;
    // Custom entries are intentionally excluded: extensions must not double-count synthetic summaries.
    if (!record) continue;
    const timestamp = parsedDate(record.timestamp ?? entry.timestamp);
    if (!timestamp || timestamp < range.start || timestamp >= range.end) continue;
    const value = usage(record);
    add(report.totals, value, session);
    if (subagent) add(report.subagents, value, session);
    addBucket(report.models, currentModel, value, session);
    addBucket(report.projects, project, value, session);
    const day = report.days.get(dayKey(timestamp)) ?? emptyTotals();
    add(day, value, session);
    report.days.set(dayKey(timestamp), day);
  }
}

export async function collectStats(
  options: { mode?: ReportMode; offset?: number; now?: Date; directory?: string } = {},
): Promise<StatsReport> {
  const mode = options.mode ?? "workweek";
  const { start, end } = periodRange(mode, options.now, options.offset ?? 0);
  const report: StatsReport = {
    mode,
    start,
    end,
    scannedFiles: 0,
    unreadableFiles: 0,
    totals: emptyTotals(),
    subagents: emptyTotals(),
    models: new Map(),
    projects: new Map(),
    days: new Map(),
  };
  const sessionFiles = await files(options.directory ?? sessionDirectory());
  report.scannedFiles = sessionFiles.length;
  for (const path of sessionFiles)
    try {
      await collectFile(path, { start, end }, report);
    } catch {
      report.unreadableFiles += 1;
    }
  return report;
}
