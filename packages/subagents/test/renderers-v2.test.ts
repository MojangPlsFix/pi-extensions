import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SubagentActivitySnapshot, SubagentsStatusEvent } from "../../../shared/events.js";
import { BUILTIN_PROFILES } from "../agents.js";
import type { HubSnapshot } from "../manager.js";
import {
  type AgentsOverlayAction,
  AgentsViewer,
  activityViewLines,
  aggregateCompletionMessageRenderer,
  completionMessageRenderer,
} from "../renderers.js";
import { emptyUsage, type RunSnapshot } from "../types.js";

function theme(): Theme {
  return {
    fg: (_color: string, text: string) => text,
    bg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  } as Theme;
}

function activitySnapshot(
  overrides: Partial<SubagentActivitySnapshot> = {},
): SubagentActivitySnapshot {
  return {
    id: "scout-1",
    name: "scout",
    profileClass: "read",
    status: "running",
    task: "Follow-up read-only inspection",
    elapsedMs: 3_631_000,
    effectiveModel: "openai-codex/gpt-5.6-luna",
    effectiveThinking: "low",
    lastEventAt: "2025-01-01T00:00:59.000Z",
    latestActivity: "grep finished",
    ...overrides,
  };
}

function activityStatus(agents: SubagentActivitySnapshot[]): SubagentsStatusEvent {
  const active = agents.filter((agent) =>
    ["queued", "starting", "running", "blocked"].includes(agent.status),
  );
  return {
    active: active.length,
    running: agents.filter((agent) => ["queued", "starting", "running"].includes(agent.status))
      .length,
    wrappingUp: active.filter((agent) => agent.wrappingUp).length,
    blocked: agents.filter((agent) => agent.status === "blocked").length,
    parked: agents.filter((agent) => agent.status === "parked").length,
    failed: agents.filter((agent) => agent.status === "failed").length,
    stopped: agents.filter((agent) => agent.status === "stopped").length,
    writers: active.filter((agent) => agent.profileClass === "write").length,
    total: agents.length,
    capacity: {
      used: active.length,
      limit: 6,
      free: 6 - active.length,
      sharedWritersUsed: active.filter((agent) => agent.profileClass === "write").length,
      sharedWritersLimit: 1,
    },
    agents,
  };
}

function run(id: string, parentId?: string): RunSnapshot {
  return {
    id,
    parentId,
    name: parentId ? "scout" : "orchestrator",
    profileClass: parentId ? "read" : "orchestrator",
    description: "profile",
    task: parentId ? "Inspect child scope" : "Coordinate mission",
    taskHistory: ["task"],
    ownership: {
      key: id,
      owns: [`topic:${id}`],
      deliverable: "report",
      acceptance: "verified report",
      stopConditions: ["stop on completion or blocker"],
      workspace: "shared",
    },
    status: "running",
    runner: "native",
    startedAt: new Date().toISOString(),
    originalEffectiveLimits: {
      maxWallSeconds: 600,
      maxTurns: 60,
      wrapUpRatio: 0.8,
    },
    leaseHistory: [],
    statusChangedAt: new Date().toISOString(),
    statusTransitions: [],
    terminationHistory: [],
    wrappingUp: false,
    elapsedMs: 100,
    sessionDir: `/tmp/${id}`,
    report: "",
    usage: emptyUsage(),
    turns: 0,
    activity: [],
    capabilityNames: [],
    capabilityPolicy: {
      requested: [],
      capabilities: [],
      tools: [],
      executableArgvPrefixes: [],
      skills: [],
      envAllowlist: [],
      state: "isolated",
      approval: "allow",
      diagnostics: [],
    },
    completionReported: false,
    hidden: false,
  };
}

function snapshot(overrides: Partial<HubSnapshot> = {}): HubSnapshot {
  return {
    runs: [],
    batches: [],
    batchCounts: { open: 0, ready: 0, inFlight: 0 },
    requests: [],
    missions: [],
    profiles: BUILTIN_PROFILES.map((profile) => structuredClone(profile)),
    diagnostics: [],
    capacity: {
      used: 0,
      limit: 4,
      free: 4,
      sharedWritersUsed: 0,
      sharedWritersLimit: 1,
    },
    herdr: { enabled: false, available: false },
    ...overrides,
  };
}

afterEach(() => vi.useRealTimers());

describe("activityViewLines", () => {
  it("renders compact Hackler activity without any triangle glyph", () => {
    const output = activityViewLines(
      activityStatus([activitySnapshot()]),
      theme(),
      160,
      Date.parse("2025-01-01T00:01:00.000Z"),
    ).join("\n");
    expect(output).toContain("Hackler · slots 1/6 used · 5 free · shared writer 0/1");
    expect(output).toContain("running 1 · wrapping 0 · blocked 0 · failed 0 · stopped 0");
    expect(output).toContain("└─ Follow-up read-only inspection");
    expect(output).toContain("read · working · luna · 60:31 · grep finished");
    expect(output).not.toMatch(/[△▵▴▲]/u);
  });

  it("sanitizes control sequences in task and activity text", () => {
    const output = activityViewLines(
      activityStatus([
        activitySnapshot({
          task: "Inspect \u001b]0;spoofed\u0007 auth",
          latestActivity: "reading \u001b[31msecret\u001b[0m",
        }),
      ]),
      theme(),
      160,
      Date.parse("2025-01-01T00:01:00.000Z"),
    ).join("\n");
    expect(output).toContain("Inspect auth");
    expect(output).toContain("reading secret");
    expect(output).not.toContain("spoofed");
    expect(output).not.toContain("\u001b");
  });

  it.each([
    ["queued", {}, "starting"],
    ["starting", {}, "starting"],
    ["running", { wrappingUp: true }, "wrapping up"],
    ["blocked", {}, "blocked"],
    ["parked", {}, "done (parked)"],
    ["failed", {}, "failed"],
    ["stopped", {}, "stopped"],
  ] as const)("labels %s from factual lifecycle data", (status, extra, label) => {
    const output = activityViewLines(
      activityStatus([activitySnapshot({ status, ...extra })]),
      theme(),
      160,
      Date.parse("2025-01-01T00:01:00.000Z"),
    ).join("\n");
    expect(output).toContain(`read · ${label}`);
  });

  it("shows a quarantined cleanup failure without inferring a stall", () => {
    const output = activityViewLines(
      activityStatus([
        activitySnapshot({
          status: "failed",
          cleanupFailure: {
            at: "2025-01-01T00:01:00.000Z",
            message: "Safe cleanup cannot be proven; worktree retained.",
          },
        }),
      ]),
      theme(),
      220,
      Date.parse("2025-01-01T00:01:01.000Z"),
    ).join("\n");
    expect(output).toContain("cleanup retained: Safe cleanup cannot be proven; worktree retained.");
    expect(output).not.toContain("stalled");
  });

  it("uses event age, not run age, to distinguish working from quiet", () => {
    const now = Date.parse("2025-01-01T00:02:00.000Z");
    const output = activityViewLines(
      activityStatus([
        activitySnapshot({
          id: "fresh",
          task: "Long but fresh",
          elapsedMs: 7_200_000,
          lastEventAt: "2025-01-01T00:01:59.000Z",
        }),
        activitySnapshot({
          id: "quiet",
          task: "Long and quiet",
          elapsedMs: 7_200_000,
          lastEventAt: "2025-01-01T00:01:20.000Z",
        }),
      ]),
      theme(),
      180,
      now,
    ).join("\n");

    expect(output).toMatch(/Long but fresh[\s\S]*working/u);
    expect(output).toMatch(/Long and quiet[\s\S]*quiet · no event for 00:40/u);
    expect(output).not.toContain("stalled");
  });

  it("preserves mixed counts, capacity, leases, turns, operation, and oldest block", () => {
    const now = Date.parse("2025-01-01T00:02:00.000Z");
    const agents = [
      activitySnapshot({
        id: "writer",
        profileClass: "write",
        task: "Write implementation",
        wrappingUp: true,
        runner: "native",
        turns: 7,
        activeLeaseGeneration: 2,
        originalEffectiveLimits: { maxWallSeconds: 600, maxTurns: 20, wrapUpRatio: 0.8 },
        leaseHistory: [
          {
            id: "lease-2",
            generation: 2,
            startedAt: "2025-01-01T00:01:00.000Z",
            wrapAt: "2025-01-01T00:09:00.000Z",
            deadlineAt: "2025-01-01T00:11:00.000Z",
            effectiveLimits: { maxWallSeconds: 600, maxTurns: 20, wrapUpRatio: 0.8 },
          },
        ],
        currentOperation: {
          kind: "tool",
          name: "apply patch",
          startedAt: "2025-01-01T00:01:50.000Z",
          generation: 2,
        },
      }),
      activitySnapshot({ id: "blocked", status: "blocked", task: "Need API choice" }),
    ];
    const value = activityStatus(agents);
    value.blockingRequestCount = 3;
    value.oldestBlockingRequest = {
      id: "request-1",
      title: "Choose API",
      createdAt: "2025-01-01T00:01:30.000Z",
      action: "open /agents inbox and answer",
    };
    const output = activityViewLines(value, theme(), 220, now).join("\n");

    expect(output).toContain("slots 2/6 used · 4 free · shared writer 1/1");
    expect(output).toContain("running 1 · wrapping 1 · blocked 1 · failed 0 · stopped 0");
    expect(output).toContain(
      "oldest block: Choose API · 00:30 ago · action: open /agents inbox and answer · +2 more request(s)",
    );
    expect(output).toContain("lease 01:00 elapsed / 09:00 remaining");
    expect(output).toContain("turns 7 used / 13 remaining");
    expect(output).toContain("last event 01:01 ago");
    expect(output).toContain("operation tool: apply patch · 00:10");
  });

  it("prioritizes exceptions, preserves blocked and working rows, and reports overflow", () => {
    const agents = [
      activitySnapshot({ id: "working", task: "Working row" }),
      activitySnapshot({ id: "parked", task: "Done row", status: "parked" }),
      activitySnapshot({ id: "stopped", task: "Stopped row", status: "stopped" }),
      activitySnapshot({ id: "failed", task: "Failed row", status: "failed" }),
      activitySnapshot({ id: "wrap", task: "Wrapping row", wrappingUp: true }),
      activitySnapshot({ id: "blocked", task: "Blocked row", status: "blocked" }),
    ];
    const output = activityViewLines(
      activityStatus(agents),
      theme(),
      180,
      Date.parse("2025-01-01T00:01:00.000Z"),
    ).join("\n");

    expect(output.indexOf("Blocked row")).toBeLessThan(output.indexOf("Wrapping row"));
    expect(output.indexOf("Wrapping row")).toBeLessThan(output.indexOf("Failed row"));
    expect(output.indexOf("Failed row")).toBeLessThan(output.indexOf("Stopped row"));
    expect(output).toContain("blocked 1");
    expect(output).toContain("running 2");
    expect(output).toContain("+2 more");
    expect(output).not.toContain("Done row");
  });
});

describe("completionMessageRenderer", () => {
  it("renders aggregate batches compactly and complete failure evidence when expanded", () => {
    const successful = { ...run("successful"), report: "Implemented and validated." };
    const failed = {
      ...run("failed"),
      status: "failed" as const,
      error: "provider disconnected",
      report: "Partial failure evidence.",
      terminationReason: {
        code: "runner_error" as const,
        at: "2025-01-01T00:01:00.000Z",
        generation: 1,
        phase: "execution" as const,
      },
    };
    const details = {
      schemaVersion: 3,
      batch: {
        id: "batch-render",
        sequence: 1,
        members: [
          { runId: successful.id, generation: 1 },
          { runId: failed.id, generation: 1 },
        ],
        originSessionId: "session",
        originEntryId: null,
        dispatchMarkerId: null,
        route: "pi",
        codeChanging: true,
        phase: "ready",
        results: [],
        createdAt: "2025-01-01T00:00:00.000Z",
        updatedAt: "2025-01-01T00:01:00.000Z",
      },
      runs: [successful, failed],
    };
    const collapsed =
      aggregateCompletionMessageRenderer(details, false, theme())?.render(180).join("\n") ?? "";
    expect(collapsed).toContain("Hackler batch · 2 results · 1 failed");
    expect(collapsed).toContain("Implemented and validated.");
    expect(collapsed).toContain("runner_error");

    const expanded =
      aggregateCompletionMessageRenderer(details, true, theme())?.render(180).join("\n") ?? "";
    expect(expanded).toContain("Failure · runner_error · phase execution");
    expect(expanded.indexOf("provider disconnected")).toBeLessThan(
      expanded.indexOf("Partial failure evidence."),
    );
  });

  it("renders an exact failure reason before an available partial report", () => {
    const component = completionMessageRenderer(
      {
        run: {
          ...run("limited"),
          status: "failed",
          error: "wall clock expired",
          report: "Partial report from cleanup",
          terminationReason: {
            code: "wall_limit",
            at: "2025-01-01T00:02:00.000Z",
            generation: 1,
            phase: "execution",
            limit: { kind: "wall", maximum: 600, observed: 601 },
          },
        },
      },
      false,
      theme(),
    );
    const output = component?.render(180).join("\n") ?? "";

    expect(output).toContain("Reason: wall_limit · phase execution · wall 601/600");
    expect(output.indexOf("wall clock expired")).toBeLessThan(
      output.indexOf("Partial report from cleanup"),
    );
  });
});

describe("AgentsViewer", () => {
  it("updates from subscriptions, renders lineage, and unsubscribes on dispose", () => {
    vi.useFakeTimers();
    let listener: ((value: HubSnapshot) => void) | undefined;
    const unsubscribe = vi.fn();
    const tui = { terminal: { rows: 40 }, requestRender: vi.fn() };
    const viewer = new AgentsViewer(
      tui,
      theme(),
      { matches: () => false } as unknown as KeybindingsManager,
      (next) => {
        listener = next;
        return unsubscribe;
      },
      vi.fn(),
      snapshot(),
    );

    listener?.(snapshot({ runs: [run("parent"), run("child", "parent")] }));
    const lines = viewer.render(120);
    const output = lines.join("\n");
    expect(lines[0]).toMatch(/^┌─+┐$/);
    expect(lines.at(-1)).toMatch(/^└─+┘$/);
    expect(output).toContain("│ Agent Hub ");
    expect(output).toContain("Coordinate mission");
    expect(output).toContain("└─ Inspect child scope");
    expect(tui.requestRender).toHaveBeenCalled();

    viewer.dispose();
    expect(unsubscribe).toHaveBeenCalledOnce();
    const renders = tui.requestRender.mock.calls.length;
    vi.advanceTimersByTime(2_000);
    expect(tui.requestRender).toHaveBeenCalledTimes(renders);
  });

  it("supports bounded keyboard navigation and strips terminal controls", () => {
    const runs = Array.from({ length: 10 }, (_, index) => ({
      ...run(`run-${index}`),
      status: "parked" as const,
      task: index === 9 ? "Last \u001b]0;forged\u0007 task" : `Task ${index}`,
      report: index === 9 ? "safe \u001b[31mred\u001b[0m" : "",
      latestActivity: index === 9 ? "reading \u001b]2;spoofed\u0007 file" : undefined,
      effectiveModel: index === 9 ? "provider/model\u001b[31m" : undefined,
    }));
    const viewer = new AgentsViewer(
      { terminal: { rows: 24 }, requestRender: vi.fn() },
      theme(),
      { matches: () => false } as unknown as KeybindingsManager,
      () => () => {},
      vi.fn(),
      snapshot({ runs }),
    );
    viewer.handleInput("\u001b[F");
    const output = viewer.render(72).join("\n");
    expect(output).toContain("selected 10 of 10");
    expect(output).toContain("Last task");
    expect(output).toContain("safe red");
    expect(output).not.toContain("forged");
    expect(output).not.toContain("spoofed");
    expect(output).not.toContain("\u001b]0;");
    expect(output).not.toContain("\u001b[31m");
    expect(output).toContain("enter answer blocked/revive");
    viewer.handleInput("\u001b[H");
    expect(viewer.render(72).join("\n")).toContain("selected 1 of 10");
    viewer.dispose();
  });

  it("gates run controls by lifecycle state and transcript availability", () => {
    const actions: AgentsOverlayAction[] = [];
    const keybindings = { matches: () => false } as unknown as KeybindingsManager;
    const make = (
      value: RunSnapshot,
      done = (action: AgentsOverlayAction) => actions.push(action),
      hub: Partial<HubSnapshot> = {},
    ) =>
      new AgentsViewer(
        { terminal: { rows: 40 }, requestRender: vi.fn() },
        theme(),
        keybindings,
        () => () => {},
        done,
        snapshot({ ...hub, runs: [value] }),
      );

    const active = make({ ...run("active"), sessionFile: "/tmp/active.jsonl" });
    active.handleInput("x");
    expect(actions.pop()).toEqual({ kind: "stop", id: "active" });

    const blocked = make({ ...run("blocked"), status: "blocked" }, undefined, {
      requests: [
        {
          id: "request-oldest",
          fromRunId: "blocked",
          kind: "decision",
          title: "Oldest decision",
          detail: "Answer this first.",
          choices: [],
          blocking: true,
          status: "pending",
          createdAt: "2025-01-01T00:00:00.000Z",
        },
        {
          id: "request-newer",
          fromRunId: "blocked",
          kind: "blocker",
          title: "Newer blocker",
          detail: "Answer this later.",
          choices: [],
          blocking: true,
          status: "pending",
          createdAt: "2025-01-01T00:00:01.000Z",
        },
      ],
    });
    expect(blocked.render(180).join("\n")).toContain("+1 more request(s)");
    blocked.handleInput("\r");
    expect(actions.pop()).toEqual({ kind: "answer", id: "request-oldest" });

    const inspect = make({ ...run("inspect"), sessionFile: "/tmp/inspect.jsonl" }, undefined, {
      herdr: { enabled: true, available: true },
    });
    inspect.handleInput("t");
    expect(actions.pop()).toEqual({ kind: "inspect", id: "inspect" });

    const disabled = make({ ...run("disabled"), sessionFile: "/tmp/disabled.jsonl" });
    disabled.handleInput("t");
    expect(actions).toEqual([]);
    disabled.dispose();

    const noTranscript = make(run("no-transcript"));
    noTranscript.handleInput("t");
    expect(actions).toEqual([]);
    noTranscript.dispose();

    const parked = make({ ...run("parked"), status: "parked" });
    parked.handleInput("\r");
    expect(actions.pop()).toEqual({ kind: "steer", id: "parked" });
  });

  it("shows operational hub capacity and failure reason before a partial report", () => {
    const failed = {
      ...run("failed"),
      status: "failed" as const,
      error: "runner disconnected",
      report: "Partial evidence only",
      terminationReason: {
        code: "runner_error" as const,
        at: "2025-01-01T00:02:00.000Z",
        generation: 1,
        phase: "execution" as const,
      },
    };
    const viewer = new AgentsViewer(
      { terminal: { rows: 40 }, requestRender: vi.fn() },
      theme(),
      { matches: () => false } as unknown as KeybindingsManager,
      () => () => {},
      vi.fn(),
      snapshot({
        runs: [failed],
        capacity: {
          used: 1,
          limit: 3,
          free: 2,
          sharedWritersUsed: 1,
          sharedWritersLimit: 1,
        },
      }),
    );
    const output = viewer.render(180).join("\n");

    expect(output).toContain("Slots 1/3 used · 2 free · shared writer 1/1");
    expect(output).toContain("Running 0 · wrapping 0 · blocked 0 · failed 1 · stopped 0");
    expect(output).toContain("Termination: runner_error · phase execution");
    expect(output.indexOf("Termination:")).toBeLessThan(output.indexOf("Partial evidence only"));
    expect(output.indexOf("Error: runner disconnected")).toBeLessThan(
      output.indexOf("Partial evidence only"),
    );
    viewer.dispose();
  });

  it("exposes blocked inbox and profile actions through keyboard input", () => {
    const actions: AgentsOverlayAction[] = [];
    const keybindings = { matches: () => false } as unknown as KeybindingsManager;
    const base = snapshot({
      requests: [
        {
          id: "request-1",
          fromRunId: "run-1",
          kind: "decision",
          title: "Choose API",
          detail: "Pick one",
          choices: [],
          blocking: true,
          status: "pending",
          createdAt: new Date().toISOString(),
        },
      ],
    });
    const make = () =>
      new AgentsViewer(
        { terminal: { rows: 40 }, requestRender: vi.fn() },
        theme(),
        keybindings,
        () => () => {},
        (action) => actions.push(action),
        base,
      );

    const inbox = make();
    inbox.handleInput("\t");
    expect(inbox.render(100).join("\n")).toContain("Choose API");
    inbox.handleInput("\r");
    expect(actions.pop()).toEqual({ kind: "answer", id: "request-1" });

    const profiles = make();
    profiles.handleInput("\t");
    profiles.handleInput("\t");
    profiles.handleInput("\r");
    expect(actions.pop()).toEqual({ kind: "toggleProfile", id: "scout" });

    const eject = make();
    eject.handleInput("\t");
    eject.handleInput("\t");
    eject.handleInput("e");
    expect(actions.pop()).toEqual({ kind: "ejectProfile", id: "scout" });
  });
});
