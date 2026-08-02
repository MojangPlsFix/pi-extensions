import { describe, expect, it } from "vitest";
import { AgentStore } from "../store.js";
import { emptyUsage, type ManagedAgent } from "../types.js";

function agent(id: string, status: ManagedAgent["status"]): ManagedAgent {
  return {
    id,
    name: "explorer",
    definition: {
      name: "explorer",
      description: "test",
      mode: "explorer",
      prompt: "test",
      source: "builtin",
    },
    task: `${status} task`,
    taskHistory: [`${status} task`],
    status,
    backend: "rpc",
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: status === "running" ? undefined : "2026-01-01T00:01:00.000Z",
    sessionDir: `/tmp/${id}`,
    stderr: "",
    output: "",
    usage: emptyUsage(),
    completionReported: false,
    activity: [],
  };
}

describe("AgentStore inline visibility", () => {
  it("shows recent terminal history only while an open agent exists", () => {
    const store = new AgentStore();
    store.add(agent("closed", "closed"));
    store.add(agent("interrupted", "interrupted"));
    expect(store.inline()).toEqual([]);

    store.add(agent("running", "running"));
    expect(store.inline().map((value) => value.id)).toEqual(["running", "closed", "interrupted"]);
  });

  it("clears the inline block after the final completed agent closes", () => {
    const store = new AgentStore();
    const ready = agent("ready", "completed");
    store.add(ready);
    expect(store.inline()).toEqual([ready]);

    ready.status = "closed";
    expect(store.inline()).toEqual([]);
    expect(store.all()).toEqual([ready]);
  });
});
