import { describe, expect, it, vi } from "vitest";
import { BUILTIN_PROFILES } from "../agents.js";
import { RunStore } from "../run-store.js";
import { emptyUsage, type RunRecord } from "../types.js";

function run(id: string, status: RunRecord["status"], finishedAt?: string): RunRecord {
  const profile = structuredClone(BUILTIN_PROFILES[0]!);
  return {
    id,
    profile,
    profileSnapshot: structuredClone(profile),
    task: id,
    taskHistory: [id],
    ownership: {
      key: id,
      owns: [`topic:${id}`],
      deliverable: "report",
      acceptance: "verified report",
      stopConditions: ["stop on completion or blocker"],
      workspace: "shared",
    },
    status,
    runner: "native",
    startedAt: finishedAt ?? "2026-01-01T00:00:00.000Z",
    finishedAt,
    originalEffectiveLimits: {
      maxWallSeconds: 600,
      maxTurns: 60,
      wrapUpRatio: 0.8,
    },
    leaseHistory: [],
    statusChangedAt: finishedAt ?? "2026-01-01T00:00:00.000Z",
    statusTransitions: [],
    terminationHistory: [],
    wrappingUp: false,
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
  };
}

describe("RunStore", () => {
  it("publishes immutable snapshots on changes", () => {
    const store = new RunStore();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    const record = run("active", "running");
    record.completionAcknowledgedGeneration = 2;
    store.add(record);
    const snapshot = listener.mock.calls.at(-1)?.[0][0];
    record.ownership.owns.push("topic:later");
    record.completionAcknowledgedGeneration = 3;
    expect(snapshot.ownership.owns).toEqual(["topic:active"]);
    expect(snapshot.completionAcknowledgedGeneration).toBe(2);
    unsubscribe();
  });

  it("retains active runs and prunes terminal history by age and count", () => {
    const store = new RunStore();
    store.add(run("active", "running"));
    store.add(run("new", "parked", "2026-06-10T00:00:00.000Z"));
    store.add(run("middle", "failed", "2026-06-09T00:00:00.000Z"));
    store.add(run("old", "stopped", "2025-01-01T00:00:00.000Z"));
    const quarantined = run("quarantined", "failed", "2025-01-01T00:00:00.000Z");
    quarantined.cleanupFailure = {
      at: "2026-06-10T00:00:00.000Z",
      message: "Safe cleanup cannot be proven.",
    };
    store.add(quarantined);
    store.add(run("validation-quarantine", "parked", "2025-01-01T00:00:00.000Z"));

    const removed = store.prune(
      { days: 30, entries: 1 },
      Date.parse("2026-06-11T00:00:00.000Z"),
      new Set(["validation-quarantine"]),
    );

    expect(removed.map((entry) => entry.id).sort()).toEqual(["middle", "old"]);
    expect(store.all().map((entry) => entry.id)).toEqual([
      "active",
      "new",
      "quarantined",
      "validation-quarantine",
    ]);
  });
});
