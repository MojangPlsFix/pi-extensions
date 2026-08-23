import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { events } from "../../../shared/events.js";
import workflowFinalization from "../index.js";

function harness() {
  const piHandlers = new Map<string, Array<(event: any, ctx: any) => any>>();
  const busHandlers = new Map<string, Array<(value: unknown) => void>>();
  let serial = 0;
  const branch: SessionEntry[] = [
    {
      type: "message",
      id: "root",
      parentId: null,
      timestamp: "2026-01-01T00:00:00Z",
      message: { role: "user", content: "implement", timestamp: 1 },
    } as SessionEntry,
  ];
  const notify = vi.fn();
  const sends: Array<{ message: any; options: any }> = [];
  let idle = true;
  const append = (entry: Omit<SessionEntry, "id" | "parentId" | "timestamp">): void => {
    branch.push({
      ...entry,
      id: `e${++serial}`,
      parentId: branch.at(-1)?.id ?? null,
      timestamp: "2026-01-01T00:00:00Z",
    } as SessionEntry);
  };
  const context = {
    mode: "tui",
    hasUI: true,
    isIdle: () => idle,
    sessionManager: {
      getSessionId: () => "session",
      getLeafId: () => branch.at(-1)?.id ?? null,
      getEntries: () => branch,
      getBranch: () => branch,
    },
    ui: { notify },
  };
  const api = {
    on(name: string, handler: (event: any, ctx: any) => any) {
      const handlers = piHandlers.get(name) ?? [];
      handlers.push(handler);
      piHandlers.set(name, handlers);
    },
    appendEntry(customType: string, data: unknown) {
      append({ type: "custom", customType, data } as never);
    },
    sendMessage(message: any, options: any) {
      sends.push({ message, options });
      append({
        type: "custom_message",
        customType: message.customType,
        content: message.content,
        details: message.details,
        display: message.display,
      } as never);
    },
    events: {
      on(name: string, handler: (value: unknown) => void) {
        const handlers = busHandlers.get(name) ?? [];
        handlers.push(handler);
        busHandlers.set(name, handlers);
      },
      emit(name: string, value: unknown) {
        for (const handler of busHandlers.get(name) ?? []) handler(value);
      },
    },
  };
  workflowFinalization(api as never);
  const emit = async (name: string, event: any = {}) => {
    const results = [];
    for (const handler of piHandlers.get(name) ?? []) results.push(await handler(event, context));
    return results;
  };
  const bus = (name: string, value: unknown) => api.events.emit(name, value);
  const assistant = (text: string) =>
    append({
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "text", text }],
        timestamp: Date.now(),
        stopReason: "stop",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      },
    } as never);
  return {
    branch,
    context,
    notify,
    sends,
    emit,
    bus,
    assistant,
    setIdle(value: boolean) {
      idle = value;
    },
  };
}

describe("workflow-finalization extension", () => {
  it("does not arm on reads, arms on successful mutation, and appends the conditional contract", async () => {
    const subject = harness();
    await subject.emit("session_start", { type: "session_start" });
    await subject.emit("tool_result", {
      toolName: "read",
      toolCallId: "r",
      input: {},
      isError: false,
      content: [],
    });
    expect((await subject.emit("before_agent_start", { systemPrompt: "base" }))[0]).toBeUndefined();

    await subject.emit("tool_result", {
      toolName: "edit",
      toolCallId: "w",
      input: {},
      isError: false,
      content: [],
    });
    expect((await subject.emit("before_agent_start", { systemPrompt: "base" }))[0]).toMatchObject({
      systemPrompt: expect.stringContaining("## Risks and blockers"),
    });
  });

  it("queues exactly one correction and warns once after the correction settles invalid", async () => {
    const subject = harness();
    await subject.emit("session_start", {});
    await subject.emit("tool_result", {
      toolName: "write",
      toolCallId: "w",
      input: {},
      isError: false,
      content: [],
    });
    subject.assistant("Implemented without the required report.");
    await subject.emit("agent_settled", {});
    expect(subject.sends).toHaveLength(1);
    expect(subject.sends[0]?.message.content).toContain("Make no more repository changes");

    subject.setIdle(false);
    await subject.emit("agent_start", {});
    subject.assistant("Still not a valid summary.");
    subject.setIdle(true);
    await subject.emit("agent_settled", {});
    expect(subject.sends).toHaveLength(1);
    expect(subject.notify).toHaveBeenCalledTimes(1);

    subject.assistant("Third invalid response.");
    await subject.emit("agent_settled", {});
    expect(subject.sends).toHaveLength(1);
    expect(subject.notify).toHaveBeenCalledTimes(1);
  });

  it("holds correction dispatch behind compaction and relevant Hackler gates", async () => {
    const subject = harness();
    await subject.emit("session_start", {});
    await subject.emit("tool_result", {
      toolName: "apply_patch",
      toolCallId: "w",
      input: {},
      isError: false,
      content: [],
    });
    subject.assistant("invalid");
    await subject.emit("session_before_compact", {});
    await subject.emit("agent_settled", {});
    expect(subject.sends).toHaveLength(0);

    await subject.emit("session_compact", {});
    subject.bus(events.hacklerBatchGate, {
      batchId: "review",
      active: true,
      relevant: true,
      phase: "review",
    });
    await subject.emit("agent_settled", {});
    expect(subject.sends).toHaveLength(0);
    subject.bus(events.hacklerBatchGate, { batchId: "review", active: false });
    await subject.emit("agent_settled", {});
    expect(subject.sends).toHaveLength(1);
  });

  it("does not dispatch while overlapping blocking UI operations remain", async () => {
    const subject = harness();
    await subject.emit("session_start", {});
    subject.bus(events.userInteraction, { active: true, reason: "first" });
    subject.bus(events.userInteraction, { active: true, reason: "second" });
    subject.bus(events.continuationEnqueue, {
      producerId: "test:ui",
      message: { content: "continue" },
    });
    expect(subject.sends).toHaveLength(0);
    subject.bus(events.userInteraction, { active: false, reason: "first" });
    expect(subject.sends).toHaveLength(0);
    subject.bus(events.userInteraction, { active: false, reason: "second" });
    expect(subject.sends).toHaveLength(1);
  });

  it("explicit Hackler advancement arms a new wave", async () => {
    const subject = harness();
    await subject.emit("session_start", {});
    subject.bus(events.implementationWaveAdvance, {
      producerId: "hackler:batch",
      reason: "integrated writer output",
    });
    const result = (await subject.emit("before_agent_start", { systemPrompt: "base" }))[0];
    expect(result.systemPrompt).toContain("Implementation finalization contract");
  });
});
