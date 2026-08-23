import { describe, expect, it } from "vitest";
import {
  buildEvaluationTraceV1,
  type EvaluationTraceInputV1,
  evaluateTraceV1,
} from "../evaluation.js";

const at = (seconds: number) => new Date(seconds * 1_000).toISOString();

function source(overrides: Partial<EvaluationTraceInputV1> = {}): EvaluationTraceInputV1 {
  return {
    generatedAt: at(10),
    runs: [
      {
        id: "run-a",
        runner: "native",
        status: "failed",
        leaseHistory: [
          {
            id: "lease-a",
            generation: 1,
            startedAt: at(0),
            acceptedAt: at(1),
            wrapAt: at(8),
            deadlineAt: at(10),
            wrapTriggeredAt: at(8),
            wrapCause: "wall",
            endedAt: at(10),
            endReason: "wall_limit",
            effectiveLimits: {
              maxWallSeconds: 10,
              maxTurns: 4,
              wrapUpRatio: 0.8,
            },
          },
        ],
        statusTransitions: [
          { to: "starting", at: at(0), generation: 1, cause: "allocation" },
          { from: "starting", to: "running", at: at(1), generation: 1, cause: "accepted" },
          {
            from: "running",
            to: "blocked",
            at: at(2),
            generation: 1,
            cause: "supervisor_request",
          },
          {
            from: "blocked",
            to: "running",
            at: at(4),
            generation: 1,
            cause: "requests_resolved",
          },
          {
            from: "running",
            to: "failed",
            at: at(10),
            generation: 1,
            cause: "wall_limit",
          },
        ],
        turns: 4,
        usage: {
          input: 10,
          output: 20,
          cacheRead: 3,
          cacheWrite: 2,
          total: 35,
          cost: 0.25,
        },
        terminationReason: {
          code: "wall_limit",
          at: at(10),
          generation: 1,
          phase: "execution",
          limit: { kind: "wall", maximum: 10, observed: 10 },
        },
      },
    ],
    capacityTimeline: [
      {
        at: at(0),
        used: 1,
        limit: 2,
        sharedWritersUsed: 0,
        sharedWritersLimit: 1,
      },
      {
        at: at(5),
        used: 2,
        limit: 2,
        sharedWritersUsed: 1,
        sharedWritersLimit: 1,
      },
    ],
    requests: [
      {
        id: "request-answered",
        fromRunId: "run-a",
        kind: "decision",
        createdAt: at(2),
        resolvedAt: at(3.5),
        status: "answered",
      },
      {
        id: "request-censored",
        fromRunId: "run-a",
        kind: "blocker",
        createdAt: at(6),
        resolvedAt: at(7),
        status: "cancelled",
      },
    ],
    activities: [
      { runId: "run-a", kind: "prompt", at: at(1) },
      { runId: "run-a", kind: "tool", at: at(5) },
    ],
    ...overrides,
  };
}

describe("evaluation trace v1", () => {
  it("calculates status, capacity, request, wrap, limit, and resource metrics", () => {
    const trace = buildEvaluationTraceV1(source());
    const metrics = evaluateTraceV1(trace);

    expect(metrics.makespanMs).toEqual({ available: true, value: 10_000 });
    expect(metrics.slotUtilization).toEqual({ available: true, value: 0.75 });
    expect(metrics.blockedDwell).toEqual({
      available: true,
      value: { count: 1, totalMs: 2_000, meanMs: 2_000, maxMs: 2_000 },
    });
    expect(metrics.answeredSupervisorResponseLatency).toEqual({
      available: true,
      value: { count: 1, totalMs: 1_500, meanMs: 1_500, maxMs: 1_500 },
    });
    expect(metrics.wrapUpLeadTime).toEqual({
      available: true,
      value: { count: 1, totalMs: 2_000, meanMs: 2_000, maxMs: 2_000 },
    });
    expect(metrics.limitHitRate).toEqual({ available: true, value: 1 });
    expect(metrics.childResourceTotals).toEqual({
      available: true,
      value: {
        input: 10,
        output: 20,
        cacheRead: 3,
        cacheWrite: 2,
        total: 35,
        cost: 0.25,
        turns: 4,
        runs: 1,
      },
    });
  });

  it("does not treat rejected or cancelled requests as answered latency", () => {
    const trace = buildEvaluationTraceV1(
      source({
        requests: [
          {
            id: "request-cancelled",
            runId: "run-a",
            kind: "approval",
            createdAt: at(1),
            resolvedAt: at(9),
            status: "cancelled",
          },
        ],
      }),
    );

    expect(evaluateTraceV1(trace).answeredSupervisorResponseLatency).toEqual({
      available: false,
      reason: "No answered request has complete creation and resolution timestamps.",
    });
  });

  it("reports metrics as unavailable when required history is absent", () => {
    const metrics = evaluateTraceV1(buildEvaluationTraceV1({ generatedAt: at(10) }));

    expect(metrics.makespanMs.available).toBe(false);
    expect(metrics.slotUtilization.available).toBe(false);
    expect(metrics.blockedDwell.available).toBe(false);
    expect(metrics.limitHitRate.available).toBe(false);
    expect(metrics.childResourceTotals.available).toBe(false);
    expect(metrics.eligibleCapacityMs.available).toBe(false);
    expect(metrics.schedulableIdleMs.available).toBe(false);
    expect(metrics.criticalPathMs.available).toBe(false);
  });

  it("requires capacity coverage at the start of the measured interval", () => {
    const trace = buildEvaluationTraceV1(
      source({
        capacityTimeline: [
          {
            at: at(1),
            used: 1,
            limit: 2,
            sharedWritersUsed: 0,
            sharedWritersLimit: 1,
          },
        ],
      }),
    );

    expect(evaluateTraceV1(trace).slotUtilization.available).toBe(false);
  });

  it("enables eligible-capacity and critical-path metrics only with an explicit fixture", () => {
    const withoutFixture = evaluateTraceV1(buildEvaluationTraceV1(source()));
    expect(withoutFixture.eligibleCapacityMs.available).toBe(false);
    expect(withoutFixture.schedulableIdleMs.available).toBe(false);
    expect(withoutFixture.criticalPathMs.available).toBe(false);

    const trace = buildEvaluationTraceV1(
      source({
        benchmark: {
          tasks: [
            {
              id: "a",
              dependencies: [],
              readyAt: at(0),
              startedAt: at(0),
              endedAt: at(4),
            },
            {
              id: "b",
              dependencies: ["a"],
              readyAt: at(4),
              startedAt: at(5),
              endedAt: at(10),
            },
          ],
        },
      }),
    );
    const metrics = evaluateTraceV1(trace);

    expect(metrics.eligibleCapacityMs.available).toBe(true);
    expect(metrics.schedulableIdleMs.available).toBe(true);
    expect(metrics.criticalPathMs).toEqual({ available: true, value: 9_000 });
  });

  it("uses an allowlist and removes every forbidden text and path canary", () => {
    const canaries = {
      task: "FORBIDDEN_TASK",
      report: "FORBIDDEN_REPORT",
      error: "FORBIDDEN_ERROR",
      cleanupFailure: { at: at(9), message: "FORBIDDEN_CLEANUP_PATH" },
      owns: ["FORBIDDEN_OWNERSHIP"],
      sessionDir: "FORBIDDEN_SESSION_PATH",
      sessionFile: "FORBIDDEN_SESSION_FILE",
      profile: { path: "FORBIDDEN_PROFILE_PATH" },
      worktree: { root: "FORBIDDEN_WORKTREE_PATH" },
      candidate: { files: ["FORBIDDEN_CANDIDATE_FILE"] },
    };
    const requestCanaries = {
      title: "FORBIDDEN_REQUEST_TITLE",
      detail: "FORBIDDEN_REQUEST_DETAIL",
      answer: "FORBIDDEN_REQUEST_ANSWER",
      choices: [{ value: "FORBIDDEN_REQUEST_CHOICE" }],
    };
    const activityCanary = { text: "FORBIDDEN_ACTIVITY_TEXT" };
    const input = source();
    input.runs = input.runs?.map((run) => ({
      ...run,
      ...canaries,
      statusTransitions: [
        {
          to: "running",
          at: at(1),
          generation: 1,
          cause: "FORBIDDEN_TRANSITION_TEXT",
        },
      ],
      terminationReason: {
        code: "completed",
        at: at(10),
        generation: 1,
        phase: "FORBIDDEN_REASON_PHASE" as never,
        limit: {
          kind: "FORBIDDEN_LIMIT_KIND" as never,
          maximum: 1,
          observed: 1,
        },
      },
    }));
    input.requests = input.requests?.map((request) => ({ ...request, ...requestCanaries }));
    input.activities = input.activities?.map((activity) => ({ ...activity, ...activityCanary }));

    const trace = buildEvaluationTraceV1(input);
    const serialized = JSON.stringify(trace);
    expect(trace.runs[0]?.statusTransitions[0]?.cause).toBe("legacy_unknown");
    for (const value of [
      "FORBIDDEN_TASK",
      "FORBIDDEN_REPORT",
      "FORBIDDEN_ERROR",
      "FORBIDDEN_CLEANUP_PATH",
      "FORBIDDEN_OWNERSHIP",
      "FORBIDDEN_SESSION_PATH",
      "FORBIDDEN_SESSION_FILE",
      "FORBIDDEN_PROFILE_PATH",
      "FORBIDDEN_WORKTREE_PATH",
      "FORBIDDEN_CANDIDATE_FILE",
      "FORBIDDEN_REQUEST_TITLE",
      "FORBIDDEN_REQUEST_DETAIL",
      "FORBIDDEN_REQUEST_ANSWER",
      "FORBIDDEN_REQUEST_CHOICE",
      "FORBIDDEN_ACTIVITY_TEXT",
      "FORBIDDEN_TRANSITION_TEXT",
      "FORBIDDEN_REASON_PHASE",
      "FORBIDDEN_LIMIT_KIND",
    ])
      expect(serialized).not.toContain(value);
  });

  it("sorts allowlisted records deterministically", () => {
    const input = source({
      activities: [
        { runId: "z", kind: "tool", at: at(2) },
        { runId: "a", kind: "prompt", at: at(1) },
      ],
    });
    const first = buildEvaluationTraceV1(input);
    const second = buildEvaluationTraceV1({
      ...input,
      activities: [...(input.activities ?? [])].reverse(),
    });

    expect(first).toEqual(second);
    expect(first.activities.map((activity) => activity.runId)).toEqual(["a", "z"]);
  });
});
