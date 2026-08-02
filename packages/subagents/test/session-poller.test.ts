import { describe, expect, it } from "vitest";
import { consumeSessionRecord } from "../session-poller.js";
import { emptyUsage, type ManagedAgent } from "../types.js";

function agent(): ManagedAgent {
  return {
    id: "agent",
    name: "explorer",
    definition: {
      name: "explorer",
      description: "test",
      mode: "explorer",
      prompt: "test",
      source: "builtin",
    },
    task: "test",
    taskHistory: ["test"],
    status: "running",
    backend: "rpc",
    startedAt: new Date().toISOString(),
    sessionDir: "/tmp/session",
    stderr: "",
    output: "",
    usage: emptyUsage(),
    completionReported: false,
    activity: [],
  };
}

describe("subagent usage authorities", () => {
  it("does not add persisted usage when RPC events are authoritative", () => {
    const subject = agent();
    const record = {
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "report" }],
        usage: { input: 10, output: 5, totalTokens: 15 },
      },
    };
    expect(consumeSessionRecord(subject, record, false)).toBe(true);
    expect(subject.usage.total).toBe(0);
    expect(consumeSessionRecord(subject, record, true)).toBe(true);
    expect(subject.usage.total).toBe(15);
  });
});
