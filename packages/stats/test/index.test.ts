import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildReport,
  captureCopilotSnapshot,
  collectStats,
  copilotSnapshotPath,
  formatLiveProviderQuota,
  parseStatsArgs,
  periodRange,
  registerCopilotSnapshots,
  registerStats,
  type StatsReport,
  StatsViewer,
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

describe("stats periods and historical records", () => {
  it("uses Bitbucket-compatible aliases and Monday-based ranges", () => {
    const now = new Date("2026-03-04T12:00:00");
    const workweek = periodRange("week", now);
    const calendarWeek = periodRange("all", now);
    expect(workweek.end.getTime() - workweek.start.getTime()).toBe(5 * 24 * 60 * 60 * 1000);
    expect(calendarWeek.end.getTime() - calendarWeek.start.getTime()).toBe(7 * 24 * 60 * 60 * 1000);
    expect(parseStatsArgs("all previous")).toEqual({ mode: "all", offset: -1 });
    expect(parseStatsArgs("week")).toEqual({ mode: "workweek", offset: 0 });
    expect(parseStatsArgs("month -2")).toEqual({ mode: "month", offset: -2 });
    expect(parseStatsArgs("nonsense")).toBeUndefined();
  });

  it("reads normal usage and compatible historical summaries once while ignoring other custom rows", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-extensions-stats-"));
    directories.push(directory);
    await mkdir(join(directory, "subagents"));
    const timestamp = "2026-03-03T10:00:00.000Z";
    await writeFile(
      join(directory, "main.jsonl"),
      [
        `{"type":"session","id":"main","cwd":"/project"}`,
        `{"type":"message","timestamp":"${timestamp}","message":{"role":"assistant","provider":"test","model":"m","usage":{"input":10,"output":5,"cost":0.01}}}`,
        `{"type":"message","timestamp":"${timestamp}","message":{"role":"toolResult","usage":{}}}`,
        JSON.stringify({
          type: "custom",
          customType: "session-summary",
          timestamp,
          data: { usage: { input: 7, cost: 0.02 }, usageAttached: false },
        }),
        JSON.stringify({
          type: "custom",
          customType: "session-summary",
          timestamp,
          data: { usage: { input: 999 }, usageAttached: true },
        }),
        JSON.stringify({
          type: "custom",
          customType: "unrelated-summary",
          timestamp,
          usage: { input: 1000 },
        }),
        "not json",
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
    expect(report.mode).toBe("workweek");
    expect(report.totals.input).toBe(20);
    expect(report.subagents.input).toBe(3);
    // The zero-usage tool result is not a model response.
    expect(report.totals.responses).toBe(3);
    expect(report.models.get("github-copilot/gpt-5.4-nano")?.input).toBe(7);
    expect(buildReport(report)).toContain("HACKLER (included above)");
  });

  it("attributes attached and unattached summary attempts without duplicating totals", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-extensions-stats-summaries-"));
    directories.push(directory);
    const timestamp = "2026-03-03T10:00:00.000Z";
    const messageTimestamp = new Date(timestamp).getTime();
    const usage = (input: number, output: number, cost: number) => ({
      input,
      output,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: input + output,
      cost: { input: 0, output: cost, cacheRead: 0, cacheWrite: 0, total: cost },
    });
    const sparkUsage = usage(7, 1, 0.02);
    const lunaUsage = usage(3, 2, 0.03);
    const combinedUsage = usage(10, 3, 0.05);
    await writeFile(
      join(directory, "main.jsonl"),
      [
        JSON.stringify({ type: "session", id: "main", cwd: "/project" }),
        // Session Summary appends its custom entry from message_end before Pi
        // persists the replacement parent assistant message.
        JSON.stringify({
          type: "custom",
          customType: "session-summary",
          timestamp,
          data: {
            name: "Fallback title",
            messageCount: 2,
            provider: "openai-codex",
            model: "gpt-5.6-luna",
            attempts: [
              {
                provider: "openai-codex",
                model: "gpt-5.3-codex-spark",
                outcome: "empty-output",
                usage: sparkUsage,
              },
              {
                provider: "openai-codex",
                model: "gpt-5.6-luna",
                outcome: "success",
                usage: lunaUsage,
              },
            ],
            usage: combinedUsage,
            usageAttached: true,
            usageAttachment: {
              messageTimestamp,
              provider: "main-provider",
              model: "main-model",
            },
          },
        }),
        JSON.stringify({
          type: "message",
          timestamp,
          message: {
            role: "assistant",
            provider: "main-provider",
            model: "main-model",
            timestamp: messageTimestamp,
            usage: usage(110, 13, 0.15),
          },
        }),
        JSON.stringify({
          type: "custom",
          customType: "session-summary",
          timestamp,
          data: {
            name: "Manual title",
            messageCount: 2,
            provider: "anthropic",
            model: "cheap-summary",
            attempts: [
              {
                provider: "anthropic",
                model: "cheap-summary",
                outcome: "success",
                usage: usage(4, 1, 0.01),
              },
            ],
            usage: usage(4, 1, 0.01),
            usageAttached: false,
          },
        }),
      ].join("\n"),
    );

    const report = await collectStats({ mode: "week", now: new Date("2026-03-04"), directory });
    expect(report.totals.input).toBe(114);
    expect(report.totals.output).toBe(14);
    expect(report.totals.cost).toBeCloseTo(0.16);
    expect(report.totals.responses).toBe(4);
    expect(report.models.get("main-provider/main-model")?.input).toBe(100);
    expect(report.models.get("main-provider/main-model")?.cost).toBeCloseTo(0.1);
    expect(report.models.get("openai-codex/gpt-5.3-codex-spark")?.input).toBe(7);
    expect(report.models.get("openai-codex/gpt-5.6-luna")?.input).toBe(3);
    expect(report.models.get("anthropic/cheap-summary")?.input).toBe(4);
    expect([...report.models.values()].reduce((total, bucket) => total + bucket.input, 0)).toBe(
      report.totals.input,
    );
  });

  it("does not double-count usage attached to a parent Hackler tool result", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-extensions-stats-attached-"));
    directories.push(directory);
    await mkdir(join(directory, "subagents"));
    const timestamp = "2026-03-03T10:00:00.000Z";
    await writeFile(
      join(directory, "main.jsonl"),
      [
        JSON.stringify({ type: "session", id: "main", cwd: "/project" }),
        JSON.stringify({
          type: "message",
          timestamp,
          message: {
            role: "assistant",
            provider: "github-copilot",
            model: "gpt-5.6-luna",
            usage: { input: 10, output: 5, cost: { total: 0.01 } },
          },
        }),
        JSON.stringify({
          type: "message",
          timestamp,
          message: {
            role: "toolResult",
            toolName: "subagent_collect",
            details: { subagentUsageAttached: true },
            usage: { input: 100, output: 20, cost: { total: 0.2 } },
          },
        }),
      ].join("\n"),
    );
    await writeFile(
      join(directory, "subagents", "child.jsonl"),
      [
        JSON.stringify({ type: "session", id: "child", cwd: "/project" }),
        JSON.stringify({
          type: "message",
          timestamp,
          message: {
            role: "assistant",
            provider: "github-copilot",
            model: "gpt-5.3-codex",
            usage: { input: 3, output: 2, cost: { total: 0.03 } },
          },
        }),
      ].join("\n"),
    );

    const report = await collectStats({
      mode: "week",
      now: new Date("2026-03-04"),
      directory,
    });
    expect(report.totals.input).toBe(13);
    expect(report.totals.cost).toBeCloseTo(0.04);
    expect(report.subagents.input).toBe(3);
    expect(report.subagents.cost).toBeCloseTo(0.03);
  });

  it("scans normal, hidden, and legacy Hackler roots without double-counting nested legacy files", async () => {
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

describe("Bitbucket report layout", () => {
  it("renders complete daily rows, credits, sections, and sorted buckets", () => {
    const report = emptyReport();
    report.copilotSnapshots = [
      {
        date: "2026-03-02",
        capturedAt: "2026-03-02T08:00:00.000Z",
        used: 81_055,
        remaining: 68_945,
        total: 150_000,
        unit: "ai_credits",
      },
    ];
    report.totals.input = 1_234;
    report.totals.cost = 0.012345;
    report.totals.responses = 2;
    report.totals.sessions.add("main");
    report.models.set("cheap", {
      key: "cheap",
      ...emptyTotals(),
      cost: 0.01,
      input: 100,
    });
    report.models.set("expensive", {
      key: "expensive",
      ...emptyTotals(),
      cost: 1,
      input: 1,
    });
    report.projects.set("/home/test/project", {
      key: "/home/test/project",
      ...emptyTotals(),
      cost: 1,
      input: 1,
    });
    const output = buildReport(report);
    expect(output).toContain("SUMMARY");
    expect(output).toContain("HACKLER (included above)");
    expect(output).toContain("DAILY");
    expect(output).toContain("Start Credits");
    expect(output).toContain("81,055");
    expect(output).toContain("$0.0123");
    expect(output.indexOf("expensive")).toBeLessThan(output.indexOf("cheap"));
    expect(output).toContain("all workspaces");
    expect(output.match(/^ {2}(Mon|Tue|Wed|Thu|Fri),/gm)).toHaveLength(5);
  });

  it("renders monthly weekly rows instead of daily rows", () => {
    const report = emptyReport();
    report.mode = "month";
    report.offset = -1;
    report.start = new Date("2026-02-01T00:00:00Z");
    report.end = new Date("2026-03-01T00:00:00Z");
    const output = buildReport(report);
    expect(output).toContain("Calendar month · 1 month ago");
    expect(output).toContain("WEEKLY");
    expect(output).not.toContain("Start Credits");
    expect(output.match(/^ {2}Week /gm)?.length).toBeGreaterThan(3);
  });
});

describe("Copilot snapshots", () => {
  it("captures one optional daily checkpoint in the configured agent directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-extensions-copilot-"));
    directories.push(root);
    const env = { ...process.env, PI_CODING_AGENT_DIR: root };
    const fetchQuota = vi.fn().mockResolvedValue({
      remaining: 68_945,
      total: 150_000,
      unlimited: false,
      unit: "ai_credits" as const,
    });
    const now = new Date("2026-03-02T08:00:00");
    await captureCopilotSnapshot(fetchQuota, env, now);
    await captureCopilotSnapshot(fetchQuota, env, now);
    expect(fetchQuota).toHaveBeenCalledTimes(1);
    const store = JSON.parse(await readFile(copilotSnapshotPath(env), "utf8")) as {
      snapshots: Array<{ date: string; used: number }>;
    };
    expect(store.snapshots).toHaveLength(1);
    expect(store.snapshots[0]).toMatchObject({ date: "2026-03-02", used: 81_055 });
  });

  it("does not fetch for a non-Copilot active model", async () => {
    const on = new Map<string, (event: unknown, ctx: any) => void>();
    const fetchQuota = vi.fn();
    const wait = registerCopilotSnapshots(
      {
        on(name: string, handler: (event: unknown, ctx: any) => void) {
          on.set(name, handler);
        },
      } as never,
      fetchQuota,
    );
    on.get("session_start")?.({}, { model: { provider: "openai-codex" } });
    await wait();
    expect(fetchQuota).not.toHaveBeenCalled();
  });
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

describe("legacy command test hook", () => {
  it("does not request live provider usage in the shipped stats command", async () => {
    const subject = commandHarness({ collect: vi.fn(async () => emptyReport()) });
    await subject.command().handler("", subject.context);
    const output = subject.editor.mock.calls[0]?.[1] as string;
    expect(output).toContain("SUMMARY");
    expect(output).not.toContain("Current provider quota");
  });

  it("keeps opt-in live quota formatting separate from the normal stats command", async () => {
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
    expect(buildReport(emptyReport(), { liveProviderQuota: codex })).toContain(
      "not included in period totals",
    );

    const subject = commandHarness({
      collect: vi.fn(async () => emptyReport()),
      fetchQuota: vi.fn(async () => {
        throw new Error("provider unavailable");
      }),
    });
    await subject.command().handler("week", subject.context);
    const output = subject.editor.mock.calls[0]?.[1] as string;
    expect(output).toContain("SUMMARY");
    expect(output).toContain("Codex quota unavailable.");
  });

  it("starts injected history and quota collection concurrently", async () => {
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

describe("StatsViewer", () => {
  it("supports scrolling, period arrows, mode switching, and close keys", async () => {
    const rendered: string[] = [];
    const navigated: number[] = [];
    const modes: string[] = [];
    let closed = 0;
    const viewer = new StatsViewer(
      { terminal: { rows: 10 }, requestRender: vi.fn() },
      { fg: (_color: string, text: string) => text, bold: (text: string) => text },
      { matches: (data: string, key: string) => data === key } as never,
      "workweek",
      Array.from({ length: 30 }, (_, index) => `line ${index}`).join("\n"),
      () => {
        closed += 1;
      },
      async (delta) => {
        navigated.push(delta);
        return "historical";
      },
      async (mode) => {
        modes.push(mode);
        return "monthly";
      },
    );
    rendered.push(...viewer.render(80));
    viewer.handleInput("down");
    viewer.handleInput("\u001b[D");
    await new Promise((resolve) => setTimeout(resolve, 0));
    viewer.handleInput("m");
    await new Promise((resolve) => setTimeout(resolve, 0));
    viewer.handleInput("q");
    expect(rendered.length).toBeGreaterThan(2);
    expect(navigated).toEqual([-1]);
    expect(modes).toEqual(["month"]);
    expect(closed).toBe(1);
  });
});
