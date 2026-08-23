import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import type { HubSnapshot } from "../manager.js";
import { type AgentsOverlayAction, AgentsViewer } from "../renderers.js";

const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;
const keybindings = { matches: () => false } as unknown as KeybindingsManager;

function request(id: string, fromRunId = "run-one") {
  return {
    id,
    fromRunId,
    kind: "integration-ready" as const,
    title: "Candidate ready",
    detail: "Candidate detail",
    choices: [
      { value: "integrate", label: "Integrate" },
      { value: "keep", label: "Keep" },
    ],
    blocking: false,
    status: "pending" as const,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

function hub(overrides: Partial<HubSnapshot> = {}): HubSnapshot {
  return {
    runs: [],
    batches: [],
    batchCounts: { open: 0, ready: 0, inFlight: 0 },
    requests: [],
    missions: [],
    profiles: [],
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

function viewer(snapshot: HubSnapshot, actions: AgentsOverlayAction[]) {
  return new AgentsViewer(
    { terminal: { rows: 40 }, requestRender: vi.fn() },
    theme,
    keybindings,
    () => () => {},
    (action) => actions.push(action),
    snapshot,
  );
}

describe("validator Hub eligibility", () => {
  it("shows and accepts Validate only for the exact eligible request", () => {
    const actions: AgentsOverlayAction[] = [];
    const exact = request("exact");
    const subject = viewer(
      hub({ requests: [exact], validators: ["check"], validatableRequestIds: [exact.id] }),
      actions,
    );
    subject.handleInput("\t");
    expect(subject.render(100).join("\n")).toContain(
      "v validates with a trusted configured command",
    );
    subject.handleInput("v");
    expect(actions).toEqual([{ kind: "validate", id: exact.id }]);
  });

  it("excludes arbitrary child integration-ready requests and supports no-validator snapshots", () => {
    const actions: AgentsOverlayAction[] = [];
    const forged = request("forged", "arbitrary-child");
    const subject = viewer(
      hub({ requests: [forged], validators: ["check"], validatableRequestIds: [] }),
      actions,
    );
    subject.handleInput("\t");
    expect(subject.render(100).join("\n")).not.toContain("v validates");
    subject.handleInput("v");
    expect(actions).toEqual([]);
    subject.dispose();

    const compatible = viewer(hub({ requests: [forged] }), actions);
    compatible.handleInput("\t");
    compatible.handleInput("v");
    expect(actions).toEqual([]);
    compatible.dispose();
  });

  it("answers a parked run request on Enter before offering revival", () => {
    const actions: AgentsOverlayAction[] = [];
    const pending = request("pending");
    const parked = {
      id: "run-one",
      name: "worker",
      profileClass: "write",
      description: "Worker",
      task: "Prepare candidate",
      taskHistory: ["Prepare candidate"],
      ownership: {
        key: "candidate",
        owns: ["path:file.txt"],
        deliverable: "Candidate",
        acceptance: "Candidate ready",
        stopConditions: ["Stop when ready"],
        workspace: "worktree",
      },
      status: "parked",
      runner: "native",
      startedAt: "2026-01-01T00:00:00.000Z",
      finishedAt: "2026-01-01T00:00:01.000Z",
      elapsedMs: 1_000,
      originalEffectiveLimits: { maxWallSeconds: 10, maxTurns: 4, wrapUpRatio: 0.8 },
      leaseHistory: [],
      statusChangedAt: "2026-01-01T00:00:01.000Z",
      statusTransitions: [],
      terminationHistory: [],
      wrappingUp: false,
      sessionDir: "/tmp/session",
      report: "",
      completionReported: true,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 },
      turns: 1,
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
      hidden: false,
    } as unknown as HubSnapshot["runs"][number];
    const subject = viewer(hub({ runs: [parked], requests: [pending] }), actions);
    subject.handleInput("\r");
    expect(actions).toEqual([{ kind: "answer", id: pending.id }]);
  });
});
