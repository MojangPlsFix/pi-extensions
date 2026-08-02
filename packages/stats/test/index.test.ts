import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildReport,
  collectStats,
  formatLiveProviderQuota,
  parseStatsArgs,
  periodRange,
  registerStats,
  type StatsReport,
} from "../index.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map(async (directory) =>
        (await import("node:fs/promises")).rm(directory, { recursive: true, force: true }),
      ),
  );
});

describe("stats", () => {
  it("calculates calendar periods and parses period arguments", () => {
    const range = periodRange("week", new Date("2026-03-04T12:00:00"));
    expect(range.start.getDay()).toBe(1);
    expect(parseStatsArgs("month previous")).toEqual({ mode: "month", offset: -1 });
    expect(parseStatsArgs("nonsense")).toBeUndefined();
  });
  it("reads valid usage once while ignoring malformed and custom summary records", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-extensions-stats-"));
    directories.push(directory);
    await mkdir(join(directory, "subagents"));
    const timestamp = "2026-03-03T10:00:00.000Z";
    const ignoredCustomType = ["session", "summary"].join("-");
    await writeFile(
      join(directory, "main.jsonl"),
      [
        `{"type":"session","id":"main","cwd":"/project"}`,
        `{"type":"message","timestamp":"${timestamp}","message":{"role":"assistant","provider":"test","model":"m","usage":{"input":10,"output":5,"cost":0.01}}}`,
        `{"type":"message","timestamp":"${timestamp}","message":{"role":"toolResult","usage":{}}}`,
        "not json",
        JSON.stringify({
          type: "custom",
          customType: ignoredCustomType,
          timestamp,
          usage: { input: 999 },
        }),
      ].join("\n"),
    );
    await writeFile(
      join(directory, "subagents", "child.jsonl"),
      [
        `{"type":"session","id":"child","cwd":"/project"}`,
        `{"type":"message","timestamp":"${timestamp}","message":{"role":"assistant","usage":{"input":3}}}`,
      ].join("\n"),
    );
    const report = await collectStats({ mode: "week", now: new Date("2026-03-04"), directory });
    expect(report.totals.input).toBe(13);
    expect(report.subagents.input).toBe(3);
    // The zero-usage tool result is not a model response.
    expect(report.totals.responses).toBe(2);
    expect(buildReport(report)).toContain("Subagents (included above)");
  });

  it("scans normal, hidden, and legacy Subagent roots without double-counting nested legacy files", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-extensions-stats-roots-"));
    directories.push(root);
    const normal = join(root, "sessions");
    const hidden = join(root, "subagents", "sessions");
    const legacy = join(normal, "subagents");
    await Promise.all([
      mkdir(normal, { recursive: true }),
      mkdir(hidden, { recursive: true }),
      mkdir(legacy, { recursive: true }),
    ]);
    const timestamp = "2026-03-03T10:00:00.000Z";
    const record = (id: string, input: number) =>
      [
        JSON.stringify({ type: "session", id, cwd: "/project" }),
        JSON.stringify({
          type: "message",
          timestamp,
          message: { role: "assistant", usage: { input } },
        }),
      ].join("\n");
    await Promise.all([
      writeFile(join(normal, "main.jsonl"), record("main", 1)),
      writeFile(join(hidden, "hidden.jsonl"), record("hidden", 2)),
      writeFile(join(legacy, "legacy.jsonl"), record("legacy", 3)),
    ]);

    const report = await collectStats({
      mode: "week",
      now: new Date("2026-03-04"),
      directories: [normal, hidden, legacy],
    });
    expect(report.scannedFiles).toBe(3);
    expect(report.totals.input).toBe(6);
    expect(report.subagents.input).toBe(5);
  });
});

const emptyTotals = () => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  uncategorized: 0,
  cost: 0,
  responses: 0,
  sessions: new Set<string>(),
});

const emptyReport = (): StatsReport => ({
  mode: "workweek",
  start: new Date("2026-03-02T00:00:00Z"),
  end: new Date("2026-03-07T00:00:00Z"),
  totals: emptyTotals(),
  subagents: emptyTotals(),
  models: new Map(),
  projects: new Map(),
  days: new Map(),
  scannedFiles: 0,
  unreadableFiles: 0,
});

function commandHarness(options: Parameters<typeof registerStats>[1], provider = "openai-codex") {
  let command: { handler: (args: string, ctx: any) => Promise<void> } | undefined;
  registerStats(
    {
      registerCommand: (_name: string, value: typeof command) => {
        command = value;
      },
    } as never,
    options,
  );
  const editor = vi.fn(async (_title: string, _content: string) => undefined);
  const context = {
    model: { provider },
    modelRegistry: {},
    mode: "tui",
    hasUI: true,
    ui: { notify: vi.fn(), editor, setWidget: vi.fn() },
  };
  return { command: () => command!, context, editor };
}

describe("live provider quota", () => {
  it("formats successful Copilot and Codex snapshots separately from local totals", () => {
    const copilot = formatLiveProviderQuota({
      provider: "github-copilot",
      snapshot: {
        provider: "github-copilot",
        quota: {
          remaining: 42,
          total: 300,
          percentRemaining: 14,
          unlimited: false,
          unit: "premium_requests",
        },
      },
    });
    expect(copilot).toContain("Current provider quota (live; not included in period totals)");
    expect(copilot).toContain("Copilot: 42/300 premium requests (14% left)");

    const codex = formatLiveProviderQuota({
      provider: "openai-codex",
      snapshot: {
        provider: "openai-codex",
        usage: {
          planType: "Pro",
          primaryWindow: { usedPercent: 42, limitWindowSeconds: 18_000 },
          secondaryWindow: { usedPercent: 19, limitWindowSeconds: 604_800 },
        },
      },
    });
    expect(codex).toContain("Codex · Pro");
    expect(codex).toContain("5h: 58% left");
    expect(codex).toContain("Weekly: 81% left");
    const report = buildReport(emptyReport(), { liveProviderQuota: codex });
    expect(report).toContain("Total: 0 tokens · 0 responses · $0.0000 · 0 sessions");
    expect(report).toContain("not included in period totals");
  });

  it("renders local history when quota retrieval fails", async () => {
    const subject = commandHarness({
      collect: vi.fn(async () => emptyReport()),
      fetchQuota: vi.fn(async () => {
        throw new Error("provider unavailable");
      }),
    });
    await subject.command().handler("", subject.context);
    const output = subject.editor.mock.calls[0]?.[1] as string;
    expect(output).toContain("Total: 0 tokens");
    expect(output).toContain("Codex quota unavailable.");
  });

  it("does not call the quota router for unsupported providers", async () => {
    const fetchQuota = vi.fn();
    const subject = commandHarness(
      { collect: vi.fn(async () => emptyReport()), fetchQuota },
      "anthropic",
    );
    await subject.command().handler("week", subject.context);
    expect(fetchQuota).not.toHaveBeenCalled();
    expect(subject.editor.mock.calls[0]?.[1]).toContain(
      "Live quota is not supported for anthropic.",
    );
  });

  it("starts local history and provider quota collection concurrently", async () => {
    let releaseCollect: (() => void) | undefined;
    let releaseQuota: (() => void) | undefined;
    let collectStarted = false;
    let quotaStarted = false;
    const collect = vi.fn(
      () =>
        new Promise<StatsReport>((resolve) => {
          collectStarted = true;
          releaseCollect = () => resolve(emptyReport());
        }),
    );
    const fetchQuota = vi.fn(
      () =>
        new Promise<any>((resolve) => {
          quotaStarted = true;
          releaseQuota = () => resolve({ provider: "openai-codex" });
        }),
    );
    const subject = commandHarness({ collect, fetchQuota });
    const pending = subject.command().handler("", subject.context);
    expect(collectStarted).toBe(true);
    expect(quotaStarted).toBe(true);
    releaseCollect?.();
    releaseQuota?.();
    await pending;
  });
});
