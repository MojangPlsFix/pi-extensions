import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { events } from "../../../shared/events.js";
import { CONTINUATION_STATE_ENTRY, type ContinuationSnapshot } from "../coordinator.js";
import workflowFinalization from "../index.js";

function continuationState(snapshot: ContinuationSnapshot, id = "state"): SessionEntry {
  return {
    type: "custom",
    customType: CONTINUATION_STATE_ENTRY,
    data: snapshot,
    id,
    parentId: "root",
    timestamp: "2026-01-01T00:00:00Z",
  } as SessionEntry;
}

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
  const receipts: unknown[] = [];
  let idle = true;
  let agentStarts = 0;
  let startSynchronouslyOnSend = false;
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
      if (startSynchronouslyOnSend) {
        idle = false;
        agentStarts += 1;
        for (const handler of piHandlers.get("agent_start") ?? []) handler({}, context);
      }
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
  api.events.on(events.continuationReceipt, (value) => receipts.push(value));
  const emit = async (name: string, event: any = {}, handlerContext = context) => {
    if (name === "agent_start") agentStarts += 1;
    const results = [];
    for (const handler of piHandlers.get(name) ?? [])
      results.push(await handler(event, handlerContext));
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
    receipts,
    agentStarts: () => agentStarts,
    emit,
    bus,
    assistant,
    setIdle(value: boolean) {
      idle = value;
    },
    startSynchronouslyOnSend() {
      startSynchronouslyOnSend = true;
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

  it("keeps restored Hackler completions passive without starting a model turn", async () => {
    const subject = harness();
    const requestId = "hackler-batches-v3:restored";
    subject.branch.push(
      continuationState({
        version: 1,
        producerSequences: { "hackler-batches-v3": 1 },
        nextOrdinal: 1,
        requests: [
          {
            version: 1,
            requestId,
            producerId: "hackler-batches-v3",
            sequence: 1,
            ordinal: 1,
            revision: 1,
            message: { customType: "subagent-completion-v3", content: "reports" },
            sessionId: "session",
            originEntryId: "root",
            status: "queued",
          },
        ],
      }),
    );

    await subject.emit("session_start", {});

    expect(subject.sends).toHaveLength(0);
    expect(subject.agentStarts()).toBe(0);
    expect(subject.branch.filter((entry) => entry.type === "custom_message")).toHaveLength(0);
    expect(subject.branch.at(-1)).toMatchObject({ type: "custom" });
  });

  it("retains automatic restore for non-Hackler continuation producers", async () => {
    const subject = harness();
    const requestId = "normal:restored";
    subject.branch.push(
      continuationState({
        version: 1,
        producerSequences: { normal: 1 },
        nextOrdinal: 1,
        requests: [
          {
            version: 1,
            requestId,
            producerId: "normal",
            sequence: 1,
            ordinal: 1,
            revision: 1,
            message: { content: "continue" },
            sessionId: "session",
            originEntryId: "root",
            status: "queued",
          },
        ],
      }),
    );

    await subject.emit("session_start", {});

    expect(subject.sends).toHaveLength(1);
    expect(subject.sends[0]?.options).toEqual({ triggerTurn: true });
  });

  it("does not let a restored passive Hackler delivery block Plan implementation", async () => {
    const subject = harness();
    const requestId = "hackler-batches-v3:restored-delivery";
    subject.branch.push(
      continuationState({
        version: 1,
        producerSequences: { "hackler-batches-v3": 1 },
        nextOrdinal: 1,
        requests: [
          {
            version: 1,
            requestId,
            producerId: "hackler-batches-v3",
            sequence: 1,
            ordinal: 1,
            revision: 1,
            resumeOnRestore: false,
            message: { customType: "subagent-completion-v3", content: "reports" },
            sessionId: "session",
            originEntryId: "root",
            status: "dispatched",
          },
        ],
      }),
      {
        type: "custom_message",
        id: "hackler-delivery",
        parentId: "root",
        timestamp: "2026-01-01T00:00:00Z",
        customType: "subagent-completion-v3",
        content: "reports",
        details: {
          workflowContinuation: {
            version: 1,
            requestId,
            producerId: "hackler-batches-v3",
          },
        },
      } as SessionEntry,
    );

    await subject.emit("session_start", {});
    expect(subject.sends).toHaveLength(0);

    const planRequestId = "plan-mode:implementation:v2:restored";
    subject.bus(events.continuationEnqueue, {
      producerId: "plan-mode:implementation:v2",
      requestId: planRequestId,
      message: {
        customType: "plan-mode-implementation",
        content: "Implement the approved plan.",
      },
    });

    expect(subject.sends).toHaveLength(1);
    expect(subject.sends[0]?.options).toEqual({ triggerTurn: true });
    expect(subject.sends[0]?.message).toMatchObject({
      customType: "plan-mode-implementation",
      content: "Implement the approved plan.",
    });
  });

  it("keeps live Hackler continuations on the automatic trigger-turn path", async () => {
    const subject = harness();
    await subject.emit("session_start", {});

    subject.bus(events.continuationEnqueue, {
      producerId: "hackler-batches-v3",
      requestId: "hackler-batches-v3:live",
      message: { customType: "subagent-completion-v3", content: "live reports" },
    });

    expect(subject.sends).toHaveLength(1);
    expect(subject.sends[0]?.options).toEqual({ triggerTurn: true });
  });

  it("pumps a live continuation after the parent reaches idle after settlement", async () => {
    const subject = harness();
    await subject.emit("session_start", {});
    subject.setIdle(false);
    subject.bus(events.continuationEnqueue, {
      producerId: "hackler-batches-v3",
      requestId: "hackler-batches-v3:late-idle",
      message: { customType: "subagent-completion-v3", content: "late reports" },
    });
    expect(subject.sends).toHaveLength(0);

    await subject.emit("agent_settled", {});
    subject.setIdle(true);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(subject.sends).toHaveLength(1);
    expect(subject.sends[0]?.options).toEqual({ triggerTurn: true });
  });

  it("does not downgrade a live Hackler continuation during tree navigation", async () => {
    const subject = harness();
    await subject.emit("session_start", {});
    subject.setIdle(false);
    subject.bus(events.continuationEnqueue, {
      producerId: "hackler-batches-v3",
      requestId: "hackler-batches-v3:tree-live",
      message: { customType: "subagent-completion-v3", content: "tree reports" },
    });
    expect(subject.sends).toHaveLength(0);

    subject.setIdle(true);
    await subject.emit("session_tree", {});

    expect(subject.sends).toHaveLength(1);
    expect(subject.sends[0]?.options).toEqual({ triggerTurn: true });
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

  it("does not settle a synchronously started continuation with the preceding run", async () => {
    const subject = harness();
    await subject.emit("session_start", {});
    subject.startSynchronouslyOnSend();
    subject.setIdle(false);
    await subject.emit("agent_start", {});
    subject.bus(events.continuationEnqueue, {
      producerId: "race",
      requestId: "race:1",
      message: { content: "continue" },
    });
    expect(subject.sends).toHaveLength(0);

    subject.setIdle(true);
    await subject.emit("agent_settled", {});
    expect(subject.sends).toHaveLength(1);
    expect(subject.receipts).toHaveLength(0);

    subject.assistant("Continuation response.");
    subject.setIdle(true);
    await subject.emit("agent_settled", {});
    expect(subject.receipts).toEqual([
      expect.objectContaining({ requestId: "race:1", status: "settled" }),
    ]);
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

    subject.bus(events.hacklerBatchGate, {
      batchId: "review",
      active: true,
      relevant: true,
      phase: "review",
    });
    await subject.emit("session_compact", {});
    expect(subject.sends).toHaveLength(0);
    subject.bus(events.hacklerBatchGate, { batchId: "review", active: false });
    expect(subject.sends).toHaveLength(1);
  });

  it("does not pump queued work from a compaction failure gate close", async () => {
    const subject = harness();
    await subject.emit("session_start", {});
    await subject.emit("session_before_compact", {});
    subject.bus(events.compactionGate, { active: true, operationId: "native" });
    subject.bus(events.continuationEnqueue, {
      producerId: "test:compaction",
      message: { content: "continue later" },
    });
    expect(subject.sends).toHaveLength(0);

    subject.bus(events.compactionGate, { active: false, operationId: "native" });
    expect(subject.sends).toHaveLength(0);
    await subject.emit("agent_settled", {});
    expect(subject.sends).toHaveLength(1);
  });

  it("resumes queued work after a successful external compaction closes", async () => {
    const subject = harness();
    await subject.emit("session_start", {});
    await subject.emit("session_before_compact", {});
    subject.bus(events.compactionGate, { active: true, operationId: "codex-native" });
    subject.bus(events.continuationEnqueue, {
      producerId: "test:successful-compaction",
      message: { content: "continue after success" },
    });
    expect(subject.sends).toHaveLength(0);

    await subject.emit("session_compact", {});
    expect(subject.sends).toHaveLength(0);
    subject.bus(events.compactionGate, {
      active: false,
      operationId: "codex-native",
      resume: true,
    });
    expect(subject.sends).toHaveLength(1);
  });

  it("closes the native gate on a Pi failure and defers dispatch to agent_settled", async () => {
    const subject = harness();
    await subject.emit("session_start", {});
    await subject.emit("session_before_compact", {});

    let failureIdle = false;
    const failureContext = {
      ...subject.context,
      isIdle: () => failureIdle,
    };
    await subject.emit(
      "session_compact_failed",
      {
        reason: "manual",
        errorMessage: "native compaction failed",
        aborted: false,
        willRetry: false,
        fromExtension: true,
      },
      failureContext,
    );
    subject.bus(events.continuationEnqueue, {
      producerId: "test:native-failure",
      message: { content: "continue after failure" },
    });
    expect(subject.sends).toHaveLength(0);

    failureIdle = true;
    await subject.emit("agent_settled", {}, failureContext);
    expect(subject.sends).toHaveLength(1);
  });

  it("closes an aborted native compaction without re-entrant finalization or duplicate work", async () => {
    const subject = harness();
    await subject.emit("session_start", {});
    await subject.emit("tool_result", {
      toolName: "write",
      toolCallId: "w",
      input: {},
      isError: false,
      content: [],
    });
    subject.assistant("invalid summary");
    await subject.emit("session_before_compact", {});

    const aborted = {
      reason: "threshold",
      aborted: true,
      willRetry: false,
      fromExtension: false,
    };
    await subject.emit("session_compact_failed", aborted);
    await subject.emit("session_compact_failed", aborted);
    expect(subject.sends).toHaveLength(0);
    expect(subject.notify).not.toHaveBeenCalled();

    await subject.emit("agent_settled", {});
    expect(subject.sends).toHaveLength(1);
    expect(subject.sends[0]?.message.content).toContain("Make no more repository changes");
  });

  it("keeps overlapping external, UI, and relevant Hackler gates after native failure", async () => {
    const subject = harness();
    await subject.emit("session_start", {});
    await subject.emit("session_before_compact", {});
    subject.bus(events.compactionGate, { active: true, operationId: "external" });
    subject.bus(events.userInteraction, { active: true, reason: "question" });
    subject.bus(events.hacklerBatchGate, {
      batchId: "review",
      active: true,
      relevant: true,
      phase: "review",
    });
    subject.bus(events.continuationEnqueue, {
      producerId: "test:overlapping-gates",
      message: { content: "continue after all gates" },
    });

    await subject.emit("session_compact_failed", {
      reason: "manual",
      aborted: true,
      willRetry: false,
      fromExtension: false,
    });
    await subject.emit("session_compact_failed", {
      reason: "manual",
      aborted: true,
      willRetry: false,
      fromExtension: false,
    });
    expect(subject.sends).toHaveLength(0);

    subject.bus(events.compactionGate, { active: false, operationId: "external" });
    subject.bus(events.userInteraction, { active: false, reason: "question" });
    expect(subject.sends).toHaveLength(0);
    subject.bus(events.hacklerBatchGate, { batchId: "review", active: false });
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

  it("explicit Hackler advancement arms a new wave and review-only completion is conditional", async () => {
    const subject = harness();
    await subject.emit("session_start", {});
    subject.bus(events.implementationWaveAdvance, {
      producerId: "hackler:review",
      reason: "review completed",
      requiresArmed: true,
    });
    expect((await subject.emit("before_agent_start", { systemPrompt: "base" }))[0]).toBeUndefined();

    subject.bus(events.implementationWaveAdvance, {
      producerId: "hackler:batch",
      reason: "integrated writer output",
    });
    subject.bus(events.implementationWaveAdvance, {
      producerId: "hackler:review",
      reason: "review completed",
      requiresArmed: true,
    });
    const result = (await subject.emit("before_agent_start", { systemPrompt: "base" }))[0];
    expect(result.systemPrompt).toContain("Implementation finalization contract");
    const states = subject.branch.filter(
      (entry) =>
        entry.type === "custom" && entry.customType === "workflow-finalization:implementation-wave",
    );
    expect((states.at(-1) as any).data.wave).toBe(2);
  });
});
