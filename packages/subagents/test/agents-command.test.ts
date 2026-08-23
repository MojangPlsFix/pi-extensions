import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { registerAgentsCommand } from "../agents-command.js";
import type { EvaluationTraceV1 } from "../evaluation.js";
import type { HubSnapshot, SubagentManager } from "../manager.js";
import type { RunSnapshot } from "../types.js";

function setup(manager: Partial<SubagentManager>) {
  const commands = new Map<string, { handler: (args: string, ctx: ExtensionContext) => unknown }>();
  const pi = {
    registerCommand(
      name: string,
      command: { handler: (args: string, ctx: ExtensionContext) => unknown },
    ) {
      commands.set(name, command);
    },
  } as unknown as ExtensionAPI;
  registerAgentsCommand(pi, manager as SubagentManager);
  const notifications: Array<{ message: string; level: string }> = [];
  const ctx = {
    mode: "print",
    hasUI: false,
    ui: {
      notify(message: string, level: string) {
        notifications.push({ message, level });
      },
    },
  } as unknown as ExtensionContext;
  return { handler: commands.get("agents")!.handler, ctx, notifications };
}

function failedRun(): RunSnapshot {
  const start = "2026-01-01T00:00:00.000Z";
  const end = "2026-01-01T00:00:10.000Z";
  return {
    id: "reviewer-failed",
    name: "reviewer",
    profileClass: "review",
    description: "Review",
    task: "Review the boundary.",
    taskHistory: ["Review the boundary."],
    ownership: {
      key: "review-boundary",
      owns: ["topic:boundary"],
      deliverable: "Findings.",
      acceptance: "Findings verified.",
      stopConditions: ["Stop after review."],
      workspace: "shared",
    },
    status: "failed",
    runner: "native",
    startedAt: start,
    finishedAt: end,
    elapsedMs: 10_000,
    originalEffectiveLimits: { maxWallSeconds: 10, maxTurns: 4, wrapUpRatio: 0.8 },
    leaseHistory: [
      {
        id: "reviewer-failed:1",
        generation: 1,
        startedAt: start,
        acceptedAt: "2026-01-01T00:00:01.000Z",
        wrapAt: "2026-01-01T00:00:08.000Z",
        deadlineAt: end,
        endedAt: end,
        endReason: "wall_limit",
        effectiveLimits: { maxWallSeconds: 10, maxTurns: 4, wrapUpRatio: 0.8 },
      },
    ],
    statusChangedAt: end,
    statusTransitions: [],
    lastEventAt: "2026-01-01T00:00:09.000Z",
    currentOperation: {
      kind: "cleanup",
      name: "transport cleanup",
      startedAt: "2026-01-01T00:00:09.000Z",
      generation: 1,
    },
    terminationReason: {
      code: "wall_limit",
      at: end,
      generation: 1,
      phase: "cleanup",
    },
    terminationHistory: [],
    wrappingUp: false,
    sessionDir: "/forbidden/session",
    report: "Supported partial finding.",
    error: "Wall-time limit reached.",
    usage: { input: 3, output: 2, cacheRead: 0, cacheWrite: 0, total: 5, cost: 0 },
    turns: 4,
    activity: [],
    effectiveModel: "provider/model",
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
    completionReported: true,
    hidden: false,
  };
}

describe("/agents operational output", () => {
  it("prints the same operational fields in non-TUI mode and puts failure reason first", async () => {
    const run = failedRun();
    const hub = {
      runs: [run],
      requests: [
        {
          id: "request-one",
          fromRunId: run.id,
          kind: "decision",
          title: "Choose",
          detail: "Choose.",
          choices: [],
          blocking: true,
          status: "pending",
          createdAt: "2026-01-01T00:00:05.000Z",
        },
      ],
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
    } as HubSnapshot;
    const status = vi.fn(async () => hub);
    const current = setup({ status } as Partial<SubagentManager>);

    await current.handler("", current.ctx);

    const output = current.notifications[0]!.message;
    expect(output).toContain("Capacity: slots 0/4 used · 4 free · shared writers 0/1");
    expect(output).toContain("Counts: running 0 · wrapping 0 · blocked 0 · failed 1 · stopped 0");
    expect(output).toContain("lease 0m 10s elapsed · 0m 0s remaining");
    expect(output).toContain("turns 4 used · 0 remaining");
    expect(output).toContain("operation cleanup: transport cleanup");
    expect(output).toContain("termination wall_limit · phase cleanup");
    expect(output).toMatch(
      /request-one · decision · Choose · from reviewer-failed · .+ old · required action: answer in \/agents/,
    );
    expect(output.indexOf("Failure reason: wall_limit")).toBeLessThan(
      output.indexOf("Partial report:"),
    );
  });

  it("emits only the allowlisted redacted trace for trace --json", async () => {
    const trace = {
      schemaVersion: 1,
      generatedAt: "2026-01-01T00:00:10.000Z",
      runs: [
        {
          id: "run-one",
          runner: "native",
          status: "parked",
          leases: [],
          statusTransitions: [],
          turns: 0,
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 },
          task: "FORBIDDEN_TRACE_TASK",
          report: "FORBIDDEN_TRACE_REPORT",
        },
      ],
      capacityTimeline: [],
      requests: [],
      activities: [],
      worktree: "/FORBIDDEN_TRACE_PATH",
    } as unknown as EvaluationTraceV1;
    const current = setup({
      evaluationTrace: () => trace,
      status: async () =>
        ({
          runs: [],
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
        }) as HubSnapshot,
    } as Partial<SubagentManager>);

    await current.handler("trace --json", current.ctx);

    const output = current.notifications[0]!.message;
    expect(JSON.parse(output)).toMatchObject({ schemaVersion: 1, runs: [{ id: "run-one" }] });
    expect(output).not.toMatch(/FORBIDDEN_TRACE_(?:TASK|REPORT|PATH)/);
  });
});
