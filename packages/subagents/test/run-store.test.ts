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
    ownership: { key: id, owns: [`topic:${id}`], deliverable: "report", workspace: "shared" },
    status,
    runner: "native",
    startedAt: finishedAt ?? "2026-01-01T00:00:00.000Z",
    finishedAt,
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
    store.add(record);
    const snapshot = listener.mock.calls.at(-1)?.[0][0];
    record.ownership.owns.push("topic:later");
    expect(snapshot.ownership.owns).toEqual(["topic:active"]);
    unsubscribe();
  });

  it("retains active runs and prunes terminal history by age and count", () => {
    const store = new RunStore();
    store.add(run("active", "running"));
    store.add(run("new", "parked", "2026-06-10T00:00:00.000Z"));
    store.add(run("middle", "failed", "2026-06-09T00:00:00.000Z"));
    store.add(run("old", "stopped", "2025-01-01T00:00:00.000Z"));

    const removed = store.prune({ days: 30, entries: 1 }, Date.parse("2026-06-11T00:00:00.000Z"));

    expect(removed.map((entry) => entry.id).sort()).toEqual(["middle", "old"]);
    expect(store.all().map((entry) => entry.id)).toEqual(["active", "new"]);
  });
});
