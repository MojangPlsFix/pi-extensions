import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { events } from "../../../shared/events.js";
import planModeExtension from "../index.js";

type Handler = (...args: any[]) => any;

function harness(
  options: {
    hasUI?: boolean;
    selection?: string;
    selections?: string[];
    allModels?: Array<{
      provider: string;
      id: string;
      reasoning?: boolean;
      thinkingLevelMap?: Record<string, string | null | undefined>;
    }>;
    availableModels?: Array<{
      provider: string;
      id: string;
      reasoning?: boolean;
      thinkingLevelMap?: Record<string, string | null | undefined>;
    }>;
    scopedModels?: Array<{
      model: {
        provider: string;
        id: string;
        reasoning?: boolean;
        thinkingLevelMap?: Record<string, string | null | undefined>;
      };
    }>;
    thinkingLevel?: string;
    reasoning?: boolean;
    thinkingLevelMap?: Record<string, string | null | undefined>;
  } = {},
) {
  const selections = [...(options.selections ?? [])];
  const commands = new Map<string, Handler>();
  const completions = new Map<string, (prefix: string) => unknown>();
  const handlers = new Map<string, Handler[]>();
  const bus = new Map<string, Handler[]>();
  const entries: Array<Record<string, unknown>> = [];
  const sent: string[] = [];
  const sentMessages: Array<{
    customType: string;
    content: string;
    options?: { triggerTurn?: boolean };
  }> = [];
  const replacementMessages: string[] = [];
  const selectCalls: Array<{ title: string; options: string[] }> = [];
  let activeTools = ["read", "bash", "edit", "write", "ask_user_question", "ctx_execute"];
  const api = {
    registerCommand(
      name: string,
      command: { handler: Handler; getArgumentCompletions?: (prefix: string) => unknown },
    ) {
      commands.set(name, command.handler);
      if (command.getArgumentCompletions) completions.set(name, command.getArgumentCompletions);
    },
    on(name: string, handler: Handler) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
    appendEntry(customType: string, data: unknown) {
      entries.push({ type: "custom", customType, data, id: `entry-${entries.length}` });
    },
    getActiveTools: () => [...activeTools],
    setActiveTools(names: string[]) {
      activeTools = [...names];
    },
    getAllTools: () =>
      ["read", "bash", "edit", "write", "ask_user_question", "ctx_execute"].map((name) => ({
        name,
      })),
    sendUserMessage(message: string) {
      sent.push(message);
    },
    sendMessage: (
      message: { customType: string; content: string },
      options?: { triggerTurn?: boolean },
    ) => {
      sentMessages.push({ ...message, options });
      sent.push(`${message.customType}:${message.content}`);
    },
    events: {
      emit(name: string, data: unknown) {
        for (const handler of bus.get(name) ?? []) handler(data);
      },
      on(name: string, handler: Handler) {
        bus.set(name, [...(bus.get(name) ?? []), handler]);
      },
    },
  } as unknown as ExtensionAPI;
  const context = {
    mode: "print",
    hasUI: options.hasUI ?? false,
    isIdle: () => true,
    hasPendingMessages: () => false,
    sessionManager: { getBranch: () => entries, getSessionFile: () => "/tmp/session.jsonl" },
    modelRegistry: {
      refresh: async () => undefined,
      getAll: () =>
        options.allModels ?? [
          {
            provider: "provider",
            id: "model",
            reasoning: options.reasoning ?? false,
            thinkingLevelMap: options.thinkingLevelMap,
          },
        ],
      getAvailable: () =>
        options.availableModels ?? [
          {
            provider: "provider",
            id: "model",
            reasoning: options.reasoning ?? false,
            thinkingLevelMap: options.thinkingLevelMap,
          },
        ],
    },
    scopedModels: options.scopedModels ?? [],
    thinkingLevel: options.thinkingLevel,
    ui: {
      notify: () => undefined,
      select: async (title: string, selectOptions: string[]) => {
        selectCalls.push({ title, options: selectOptions });
        return selections.shift() ?? options.selection;
      },
      setEditorText: () => undefined,
    },
    newSession: async (sessionOptions: {
      setup?: (manager: { appendCustomEntry(type: string, data: unknown): void }) => Promise<void>;
      withSession?: (replacement: {
        sendUserMessage(message: string): Promise<void>;
      }) => Promise<void>;
    }) => {
      await sessionOptions.setup?.({ appendCustomEntry: () => undefined });
      await sessionOptions.withSession?.({
        sendUserMessage: async (message) => {
          replacementMessages.push(message);
        },
      });
    },
  } as unknown as ExtensionCommandContext;
  planModeExtension(api);
  return {
    commands,
    completions,
    handlers,
    entries,
    sent,
    sentMessages,
    replacementMessages,
    selectCalls,
    context,
    activeTools: () => activeTools,
    emitExtensionEvent(name: string, data: unknown) {
      for (const handler of bus.get(name) ?? []) handler(data);
    },
    onExtensionEvent(name: string, handler: Handler) {
      bus.set(name, [...(bus.get(name) ?? []), handler]);
    },
  };
}

async function emit(
  subject: ReturnType<typeof harness>,
  name: string,
  event: unknown,
): Promise<any[]> {
  return Promise.all(
    (subject.handlers.get(name) ?? []).map((handler) =>
      handler(event, subject.context as ExtensionContext),
    ),
  );
}

describe("Plan Mode lifecycle", () => {
  it("offers only the active /plan off completion and fresh implementation completion", async () => {
    const subject = harness();
    await emit(subject, "session_start", {});
    expect(subject.completions.get("plan")?.("o")).toBeNull();
    await subject.commands.get("plan")?.("", subject.context);
    expect(subject.completions.get("plan")?.("o")).toEqual([
      { value: "off", label: "off", description: "Leave Plan Mode" },
    ]);
    expect(subject.completions.get("plan-implement")?.("f")).toEqual([
      { value: "fresh", label: "fresh", description: "Use a new session" },
    ]);
  });

  it("transitions through /plan and restores direct mutation tools with /plan off", async () => {
    const subject = harness();
    await emit(subject, "session_start", {});
    await subject.commands.get("plan")?.("review auth", subject.context);
    expect(subject.sent).toEqual(["review auth"]);
    expect(subject.activeTools()).not.toContain("edit");
    expect((await emit(subject, "tool_call", { toolName: "edit", input: {} }))[0]).toMatchObject({
      block: true,
    });
    await subject.commands.get("plan")?.("off", subject.context);
    expect(subject.activeTools()).toEqual(expect.arrayContaining(["edit", "write"]));
  });

  it("allows an active explorer but blocks Plan Mode for an active worker", async () => {
    const explorer = harness();
    await emit(explorer, "session_start", {});
    explorer.emitExtensionEvent("pi-extensions:subagents-status", {
      active: 1,
      explorers: 1,
      workers: 0,
    });
    await explorer.commands.get("plan")?.("", explorer.context);
    expect(explorer.activeTools()).not.toContain("edit");

    const worker = harness();
    await emit(worker, "session_start", {});
    worker.emitExtensionEvent("pi-extensions:subagents-status", {
      active: 1,
      explorers: 0,
      workers: 1,
    });
    await worker.commands.get("plan")?.("", worker.context);
    expect(worker.activeTools()).toContain("edit");
  });

  it("uses the reviewer bridge without approving or implementing the plan", async () => {
    const subject = harness({
      hasUI: true,
      selections: ["No, stay in Plan mode", "provider/model", "high"],
      thinkingLevel: "high",
      reasoning: true,
      thinkingLevelMap: { xhigh: "xhigh", max: "max" },
    });
    await emit(subject, "session_start", {});
    await subject.commands.get("plan")?.("", subject.context);
    const interactions: Array<{ active: boolean; reason: string }> = [];
    subject.onExtensionEvent(events.userInteraction, (event: any) => interactions.push(event));
    subject.onExtensionEvent("pi-extensions:plan-review", (request: any) => {
      request.accept();
      request.respond({
        reviewerId: "plan-reviewer-1",
        model: request.model,
        thinking: request.thinking,
        report: "Add an integration test.",
      });
    });
    subject.entries.push({
      type: "message",
      id: "assistant-review",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "<proposed_plan>\n# Review me\n</proposed_plan>" }],
      },
    });
    await emit(subject, "agent_settled", {});
    await subject.commands.get("plan-review")?.("", subject.context);
    expect(subject.selectCalls.at(-1)?.options).toEqual([
      "high",
      "off",
      "minimal",
      "low",
      "medium",
      "xhigh",
      "max",
    ]);
    expect(interactions).toEqual([
      { active: true, reason: "Plan Mode proposal approval" },
      { active: false, reason: "Plan Mode proposal approval" },
      { active: true, reason: "Plan Mode reviewer model selection" },
      { active: false, reason: "Plan Mode reviewer model selection" },
      { active: true, reason: "Plan Mode reviewer effort selection" },
      { active: false, reason: "Plan Mode reviewer effort selection" },
    ]);
    expect(subject.sent.some((message) => message.startsWith("plan-review:"))).toBe(true);
    expect(subject.sent).not.toContain("Implement the approved plan.");
    expect(subject.sentMessages.at(-1)).toMatchObject({
      options: { triggerTurn: true },
    });
    expect(subject.sentMessages.at(-1)?.content).toContain(
      "Plan Mode revision instruction: Treat this report as advisory.",
    );
    expect(subject.sentMessages.at(-1)?.content).toContain("thinking: high");
    expect(subject.sentMessages.at(-1)?.content).toContain("revise the proposed plan if needed");
    expect(subject.sentMessages.at(-1)?.content).toContain("Do not approve or implement");
    expect(subject.entries.at(-1)?.data).toMatchObject({
      lastReview: {
        planSourceEntryId: "assistant-review",
        reviewerId: "plan-reviewer-1",
        thinking: "high",
      },
    });
  });

  it("uses only available models and intersects scoped models", async () => {
    const subject = harness({
      hasUI: true,
      selections: ["No, stay in Plan mode", "provider/available", "off"],
      allModels: [{ provider: "provider", id: "stale" }],
      availableModels: [
        { provider: "provider", id: "available" },
        { provider: "provider", id: "unscoped" },
      ],
      scopedModels: [
        { model: { provider: "provider", id: "available" } },
        { model: { provider: "provider", id: "missing" } },
      ],
    });
    await emit(subject, "session_start", {});
    await subject.commands.get("plan")?.("", subject.context);
    subject.entries.push({
      type: "message",
      id: "assistant-review-filter",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "<proposed_plan>\n# Filter me\n</proposed_plan>" }],
      },
    });
    await emit(subject, "agent_settled", {});
    subject.onExtensionEvent("pi-extensions:plan-review", (request: any) => {
      request.accept();
      request.respond({ reviewerId: "reviewer", model: request.model, report: "Looks good." });
    });

    await subject.commands.get("plan-review")?.("", subject.context);

    expect(subject.selectCalls.at(-2)?.options).toEqual(["provider/available"]);
    expect(subject.selectCalls.at(-1)?.options).toEqual(["off"]);
  });

  it("implements an approved plan in current or fresh context", async () => {
    const current = harness({ hasUI: true, selection: "Yes, implement this plan" });
    await emit(current, "session_start", {});
    await current.commands.get("plan")?.("", current.context);
    current.entries.push({
      type: "message",
      id: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "<proposed_plan>\n# Current\n</proposed_plan>" }],
      },
    });
    await emit(current, "agent_settled", {});
    expect(current.sent.at(-1)).toBe("Implement the approved plan.");

    const fresh = harness({ hasUI: true, selection: "Yes, clear context and implement" });
    await emit(fresh, "session_start", {});
    await fresh.commands.get("plan")?.("", fresh.context);
    fresh.entries.push({
      type: "message",
      id: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "<proposed_plan>\n# Fresh\n</proposed_plan>" }],
      },
    });
    await emit(fresh, "agent_settled", {});
    await new Promise((resolve) => setImmediate(resolve));
    expect(fresh.replacementMessages[0]).toContain("fresh context");
  });
});
