import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
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
    taskKey: "follow-up-read-only-inspection",
    task: "Follow-up read-only inspection",
    elapsedMs: 3_631_000,
    activeLeaseGeneration: 1,
    lastEventAt: "2025-01-01T00:00:59.000Z",
    ...overrides,
  };
}

function activityStatus(agents: SubagentActivitySnapshot[]): SubagentsStatusEvent {
  const active = agents.filter((agent) =>
    ["queued", "starting", "running", "blocked"].includes(agent.status),
  );
  return {
    active: active.length,
    foreground: agents.filter(
      (agent) =>
        !(
          ["parked", "failed", "stopped"].includes(agent.status) &&
          agent.activeLeaseGeneration !== undefined &&
          agent.completionAcknowledgedGeneration === agent.activeLeaseGeneration
        ),
    ).length,
    history: agents.filter(
      (agent) =>
        ["parked", "failed", "stopped"].includes(agent.status) &&
        agent.activeLeaseGeneration !== undefined &&
        agent.completionAcknowledgedGeneration === agent.activeLeaseGeneration,
    ).length,
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
    activeLeaseGeneration: 1,
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
  it("renders one compact header and at most two lines per foreground run", () => {
    const value = activityStatus([
      activitySnapshot({
        taskKey: "plan-mode-integration",
        task: "FORBIDDEN full child prompt",
        currentTool: "read",
        lastAction: "grep finished",
      }),
    ]);
    value.history = 12;
    const lines = activityViewLines(value, theme(), 160);
    const output = lines.join("\n");

    expect(lines).toHaveLength(4);
    expect(output).toContain("Hackler · ◐ 1/6 active");
    expect(output).toContain("◐ Plan mode integration · working · 60:31");
    expect(output).toContain("now: read · last: grep finished");
    expect(output).toContain("○ 12 history");
    expect(output).not.toContain("FORBIDDEN");
    expect(output).not.toMatch(/[!●✗△▵▴▲]/u);
  });

  it("sanitizes child-provided labels and activity", () => {
    const output = activityViewLines(
      activityStatus([
        activitySnapshot({
          taskKey: "inspect-\u001b]0;spoofed\u0007-auth",
          currentTool: "read\u001b[31m\u001b[0m",
          lastAction: "grep \u001b[31msecret\u001b[0m finished",
        }),
      ]),
      theme(),
      160,
    ).join("\n");
    expect(output).toContain("Inspect auth");
    expect(output).toContain("grep secret finished");
    expect(output).not.toContain("spoofed");
    expect(output).not.toContain("\u001b");
  });

  it("uses lifecycle operation fallback and hides a missing context line", () => {
    const withOperation = activityViewLines(
      activityStatus([
        activitySnapshot({
          taskKey: "finalize-result",
          latestActivity: undefined,
          currentOperation: {
            kind: "finalization",
            name: "sensitive operation details",
            startedAt: "2025-01-01T00:00:00.000Z",
            generation: 1,
          },
        }),
      ]),
      theme(),
      120,
    );
    expect(withOperation.join("\n")).toContain("now: finalization");
    expect(withOperation.join("\n")).not.toContain("sensitive operation details");

    const withoutActivity = activityViewLines(
      activityStatus([activitySnapshot({ taskKey: "idle-context", latestActivity: undefined })]),
      theme(),
      120,
    );
    expect(withoutActivity).toHaveLength(2);
  });

  it("prioritizes Attention, caps four entries, and reports overflow", () => {
    const agents = [
      activitySnapshot({ id: "working", taskKey: "working-row" }),
      activitySnapshot({ id: "queued", taskKey: "queued-row", status: "queued" }),
      activitySnapshot({ id: "wrap", taskKey: "wrapping-row", wrappingUp: true }),
      activitySnapshot({
        id: "ready",
        taskKey: "ready-row",
        status: "parked",
        activeLeaseGeneration: 1,
      }),
      activitySnapshot({ id: "blocked", taskKey: "blocked-row", status: "blocked" }),
    ];
    const lines = activityViewLines(activityStatus(agents), theme(), 140);
    const output = lines.join("\n");
    expect(output.indexOf("Blocked row")).toBeLessThan(output.indexOf("Ready row"));
    expect(output.indexOf("Ready row")).toBeLessThan(output.indexOf("Wrapping row"));
    expect(output).toContain("+1 active");
    expect(lines.length).toBeLessThanOrEqual(10);
  });

  it("renders no widget lines when only acknowledged History remains", () => {
    const value = activityStatus([
      activitySnapshot({
        status: "parked",
        activeLeaseGeneration: 2,
        completionAcknowledgedGeneration: 2,
      }),
    ]);
    value.history = 1;
    expect(activityViewLines(value, theme(), 120)).toEqual([]);
  });

  it("reserves state and elapsed time before the label at narrow widths", () => {
    const lines = activityViewLines(
      activityStatus([
        activitySnapshot({
          taskKey: "an-extremely-long-api-contract-review-label",
          currentTool: "read",
          lastAction: "grep finished after a long scan",
        }),
      ]),
      theme(),
      20,
    );
    expect(lines[1]).toContain("working");
    expect(lines[1]).toContain("60:31");
    expect(lines[2]).toMatch(/^ {2}now: read/u);
  });

  it.each([1, 8, 20, 40, 60, 120])("never exceeds width %i", (width) => {
    const lines = activityViewLines(
      activityStatus([
        activitySnapshot({
          taskKey: "api-界面-review-🧪-with-a-very-long-label",
          currentTool: "read",
          lastAction: "grep finished after a very long previous action",
        }),
      ]),
      theme(),
      width,
    );
    for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
  });
});

describe("completionMessageRenderer", () => {
  it("renders aggregate batches compactly and complete failure evidence when expanded", () => {
    const successful = {
      ...run("successful"),
      status: "parked" as const,
      completionAcknowledgedGeneration: 1,
      report: "Implemented and validated.",
    };
    const failed = {
      ...run("failed"),
      status: "failed" as const,
      error: "provider disconnected",
      report: `Partial failure evidence.\n${Array.from(
        { length: 12 },
        (_, index) => `evidence line ${index + 1}`,
      ).join("\n")}\nFINAL EXPANDED EVIDENCE`,
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
    expect(collapsed).toContain("Hackler results · 2 · 1 failed");
    expect(collapsed).toContain("Implemented and validated.");
    expect(collapsed).toContain("runner_error");

    const expanded =
      aggregateCompletionMessageRenderer(details, true, theme())?.render(180).join("\n") ?? "";
    expect(expanded).toContain("Failure · runner_error · phase execution");
    expect(expanded.indexOf("provider disconnected")).toBeLessThan(
      expanded.indexOf("Partial failure evidence."),
    );
    expect(expanded).toContain("FINAL EXPANDED EVIDENCE");
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

    expect(output).toContain("wall_limit · phase execution · wall 601/600");
    expect(output.indexOf("wall clock expired")).toBeLessThan(
      output.indexOf("Partial report from cleanup"),
    );
  });

  it("prefers result snapshots, then matching runs, then a sanitized legacy id", () => {
    const snapshotRun = {
      ...run("snapshot-source"),
      task: "FORBIDDEN snapshot prompt",
      ownership: { ...run("snapshot-source").ownership, key: "api-snapshot-source" },
      status: "parked" as const,
    };
    const matchingRun = {
      ...run("matching-source"),
      task: "FORBIDDEN matching prompt",
      ownership: { ...run("matching-source").ownership, key: "ui-matching-source" },
      status: "parked" as const,
    };
    const legacyId = "legacy-\u001b]0;spoofed\u0007-run";
    const results = [
      {
        runId: snapshotRun.id,
        generation: 1,
        status: "parked" as const,
        snapshot: snapshotRun,
      },
      { runId: matchingRun.id, generation: 1, status: "parked" as const },
      { runId: legacyId, generation: 1, status: "parked" as const },
    ];
    const output =
      aggregateCompletionMessageRenderer(
        {
          schemaVersion: 3,
          batch: {
            id: "batch-source-order",
            sequence: 1,
            members: results.map((result) => ({
              runId: result.runId,
              generation: result.generation,
            })),
            originSessionId: "session",
            originEntryId: null,
            dispatchMarkerId: null,
            route: "pi",
            codeChanging: false,
            phase: "ready",
            results,
            createdAt: "2025-01-01T00:00:00.000Z",
            updatedAt: "2025-01-01T00:01:00.000Z",
          },
          runs: [matchingRun],
        },
        false,
        theme(),
      )
        ?.render(140)
        .join("\n") ?? "";
    expect(output).toContain("API snapshot source");
    expect(output).toContain("UI matching source");
    expect(output).toContain("legacy-run");
    expect(output).not.toContain("spoofed");
    expect(output).not.toContain("FORBIDDEN");
  });

  it("caps collapsed summaries, omits prompts, and reports omitted History", () => {
    const runs = Array.from({ length: 6 }, (_, index) => ({
      ...run(`history-${index}`),
      task: `FORBIDDEN prompt ${index}`,
      ownership: { ...run(`history-${index}`).ownership, key: `history-task-${index}` },
      status: "parked" as const,
      completionAcknowledgedGeneration: 1,
      report: `report ${index}`,
    }));
    const component = aggregateCompletionMessageRenderer(
      {
        schemaVersion: 3,
        batch: {
          id: "batch-history",
          sequence: 1,
          members: runs.map((item) => ({ runId: item.id, generation: 1 })),
          originSessionId: "session",
          originEntryId: null,
          dispatchMarkerId: null,
          route: "pi",
          codeChanging: false,
          phase: "delivered",
          results: [],
          createdAt: "2025-01-01T00:00:00.000Z",
          updatedAt: "2025-01-01T00:01:00.000Z",
        },
        runs,
      },
      false,
      theme(),
    );
    const output = component?.render(100).join("\n") ?? "";
    expect((output.match(/○ History/gu) ?? []).length).toBe(4);
    expect(output).toContain("+2 omitted · ○ 6 History");
    expect(output).toContain("to expand");
    expect(output).not.toContain("FORBIDDEN");
    for (const width of [1, 8, 20, 40, 60, 120])
      for (const line of component?.render(width) ?? [])
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
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
    expect(output).toContain("Active");
    expect(output).toContain("Coordinate mission");
    expect(output).toContain("└─ Scout · child");
    expect(tui.requestRender).toHaveBeenCalled();

    viewer.dispose();
    expect(unsubscribe).toHaveBeenCalledOnce();
    const renders = tui.requestRender.mock.calls.length;
    vi.advanceTimersByTime(2_000);
    expect(tui.requestRender).toHaveBeenCalledTimes(renders);
  });

  it("preserves selection by run id when regrouping", () => {
    let listener: ((value: HubSnapshot) => void) | undefined;
    const selected = { ...run("selected"), task: "Selected task" };
    const other = { ...run("other"), task: "Other task" };
    const viewer = new AgentsViewer(
      { terminal: { rows: 40 }, requestRender: vi.fn() },
      theme(),
      { matches: () => false } as unknown as KeybindingsManager,
      (next) => {
        listener = next;
        return () => {};
      },
      vi.fn(),
      snapshot({ runs: [selected, other] }),
    );

    listener?.(
      snapshot({
        runs: [
          {
            ...selected,
            status: "parked",
            completionAcknowledgedGeneration: 1,
          },
          other,
        ],
      }),
    );
    const output = viewer.render(120).join("\n");
    expect(output).toContain("selected 2 of 2");
    expect(output).toContain("Task: Selected task");
    expect(output.indexOf(" Active")).toBeLessThan(output.indexOf(" History"));
    viewer.dispose();
  });

  it("does not draw lineage connectors across groups and shows the parent id", () => {
    const parent = {
      ...run("parent"),
      status: "parked" as const,
      completionAcknowledgedGeneration: 1,
    };
    const child = run("child", "parent");
    const viewer = new AgentsViewer(
      { terminal: { rows: 40 }, requestRender: vi.fn() },
      theme(),
      { matches: () => false } as unknown as KeybindingsManager,
      () => () => {},
      vi.fn(),
      snapshot({ runs: [parent, child] }),
    );
    const output = viewer.render(120).join("\n");
    expect(output).not.toContain("└─ Scout · child");
    expect(output).toContain("Parent: parent");
    viewer.dispose();
  });

  it.each([1, 8, 20, 40, 60, 120])("keeps every Hub line within width %i", (width) => {
    const viewer = new AgentsViewer(
      { terminal: { rows: 24 }, requestRender: vi.fn() },
      theme(),
      { matches: () => false } as unknown as KeybindingsManager,
      () => () => {},
      vi.fn(),
      snapshot({ runs: [run("api-界面-🧪")] }),
    );
    for (const line of viewer.render(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    viewer.dispose();
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
    const rendered = viewer.render(72);
    const output = rendered.join("\n");
    expect(rendered.every((line) => visibleWidth(line) <= 72)).toBe(true);
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

    expect(output).toContain("Slots 1/3 · 2 free");
    expect(output).toContain("Attention 1 · Active 0 · History 0");
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
