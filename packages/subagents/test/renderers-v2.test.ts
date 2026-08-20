import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BUILTIN_PROFILES } from "../agents.js";
import type { HubSnapshot } from "../manager.js";
import { type AgentsOverlayAction, AgentsViewer } from "../renderers.js";
import { emptyUsage, type RunSnapshot } from "../types.js";

function theme(): Theme {
  return {
    fg: (_color: string, text: string) => text,
    bg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  } as Theme;
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
    ownership: { key: id, owns: [`topic:${id}`], deliverable: "report", workspace: "shared" },
    status: "running",
    runner: "native",
    startedAt: new Date().toISOString(),
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
    requests: [],
    missions: [],
    profiles: BUILTIN_PROFILES.map((profile) => structuredClone(profile)),
    diagnostics: [],
    ...overrides,
  };
}

afterEach(() => vi.useRealTimers());

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
    const output = viewer.render(120).join("\n");
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
    expect(output).toContain("enter revive parked");
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
    ) =>
      new AgentsViewer(
        { terminal: { rows: 40 }, requestRender: vi.fn() },
        theme(),
        keybindings,
        () => () => {},
        done,
        snapshot({ runs: [value] }),
      );

    const active = make({ ...run("active"), sessionFile: "/tmp/active.jsonl" });
    active.handleInput("x");
    expect(actions.pop()).toEqual({ kind: "stop", id: "active" });

    const inspect = make({ ...run("inspect"), sessionFile: "/tmp/inspect.jsonl" });
    inspect.handleInput("t");
    expect(actions.pop()).toEqual({ kind: "inspect", id: "inspect" });

    const noTranscript = make(run("no-transcript"));
    noTranscript.handleInput("t");
    expect(actions).toEqual([]);
    noTranscript.dispose();

    const parked = make({ ...run("parked"), status: "parked" });
    parked.handleInput("\r");
    expect(actions.pop()).toEqual({ kind: "steer", id: "parked" });
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
