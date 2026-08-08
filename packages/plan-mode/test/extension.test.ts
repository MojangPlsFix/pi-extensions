import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { events } from "../../../shared/events.js";
import planModeExtension from "../index.js";

type Handler = (...args: any[]) => any;

function harness(
  options: {
    hasUI?: boolean;
    selection?: string;
    selections?: string[];
    inputs?: Array<string | undefined>;
    confirmations?: boolean[];
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
    replacementSendError?: Error;
    newSessionErrorAfterInvalidation?: Error;
    replacementHasUI?: boolean;
  } = {},
) {
  const selections = [...(options.selections ?? [])];
  const inputs = [...(options.inputs ?? [])];
  const confirmations = [...(options.confirmations ?? [])];
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
  const replacementEntries: Array<{ customType: string; data: unknown }> = [];
  const replacementNotifications: Array<{ message: string; level: string }> = [];
  const staleAccesses: string[] = [];
  const selectCalls: Array<{ title: string; options: string[] }> = [];
  let activeTools = ["read", "bash", "edit", "write", "ask_user_question", "ctx_execute"];
  let oldRuntimeActive = true;
  const assertOldRuntimeActive = (operation: string): void => {
    if (oldRuntimeActive) return;
    staleAccesses.push(operation);
    throw new Error("stale old extension runtime");
  };
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
      assertOldRuntimeActive("pi.appendEntry");
      entries.push({ type: "custom", customType, data, id: `entry-${entries.length}` });
    },
    getActiveTools: () => {
      assertOldRuntimeActive("pi.getActiveTools");
      return [...activeTools];
    },
    setActiveTools(names: string[]) {
      assertOldRuntimeActive("pi.setActiveTools");
      activeTools = [...names];
    },
    getAllTools: () => {
      assertOldRuntimeActive("pi.getAllTools");
      return ["read", "bash", "edit", "write", "ask_user_question", "ctx_execute"].map((name) => ({
        name,
      }));
    },
    sendUserMessage(message: string) {
      assertOldRuntimeActive("pi.sendUserMessage");
      sent.push(message);
    },
    sendMessage: (
      message: { customType: string; content: string },
      options?: { triggerTurn?: boolean },
    ) => {
      assertOldRuntimeActive("pi.sendMessage");
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
  const ui = {
    notify: () => undefined,
    select: async (title: string, selectOptions: string[]) => {
      selectCalls.push({ title, options: selectOptions });
      return selections.shift() ?? options.selection;
    },
    input: async () => inputs.shift(),
    confirm: async () => confirmations.shift() ?? false,
    setEditorText: () => undefined,
  };
  const sessionManager = {
    getBranch: () => entries,
    getSessionFile: () => "/tmp/session.jsonl",
  };
  const context = {
    get mode() {
      assertOldRuntimeActive("ctx.mode");
      return "print" as const;
    },
    get hasUI() {
      assertOldRuntimeActive("ctx.hasUI");
      return options.hasUI ?? false;
    },
    isIdle: () => {
      assertOldRuntimeActive("ctx.isIdle");
      return true;
    },
    hasPendingMessages: () => {
      assertOldRuntimeActive("ctx.hasPendingMessages");
      return false;
    },
    get sessionManager() {
      assertOldRuntimeActive("ctx.sessionManager");
      return sessionManager;
    },
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
    get ui() {
      assertOldRuntimeActive("ctx.ui");
      return ui;
    },
    newSession: async (sessionOptions: {
      setup?: (manager: { appendCustomEntry(type: string, data: unknown): void }) => Promise<void>;
      withSession?: (replacement: {
        hasUI: boolean;
        ui: { notify(message: string, level: string): void };
        sendUserMessage(message: string): Promise<void>;
      }) => Promise<void>;
    }) => {
      assertOldRuntimeActive("ctx.newSession");
      for (const handler of handlers.get("session_shutdown") ?? []) {
        await handler({ type: "session_shutdown", reason: "new" }, context);
      }
      oldRuntimeActive = false;
      if (options.newSessionErrorAfterInvalidation) {
        throw options.newSessionErrorAfterInvalidation;
      }
      await sessionOptions.setup?.({
        appendCustomEntry: (customType, data) => {
          replacementEntries.push({ customType, data });
        },
      });
      await sessionOptions.withSession?.({
        hasUI: options.replacementHasUI ?? true,
        ui: {
          notify: (message, level) => replacementNotifications.push({ message, level }),
        },
        sendUserMessage: async (message) => {
          if (options.replacementSendError) throw options.replacementSendError;
          replacementMessages.push(message);
        },
      });
      return { cancelled: false };
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
    replacementEntries,
    replacementNotifications,
    staleAccesses,
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
    const herdrBlocking: Array<{ active: boolean; label?: string }> = [];
    subject.onExtensionEvent(events.userInteraction, (event: any) => interactions.push(event));
    subject.onExtensionEvent(events.herdrBlocked, (event: any) => herdrBlocking.push(event));
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
    expect(herdrBlocking).toEqual([
      { active: true, label: "Plan Mode proposal approval" },
      { active: false },
      { active: true, label: "Plan Mode reviewer model selection" },
      { active: false },
      { active: true, label: "Plan Mode reviewer effort selection" },
      { active: false },
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

  it("reports /plan-tools selections, inputs, and confirmations to both event streams", async () => {
    const subject = harness({
      hasUI: true,
      selections: ["Global", "CLI program"],
      inputs: ["example-cli", "help, inspect"],
      confirmations: [false],
    });
    await emit(subject, "session_start", {});
    const interactions: Array<{ active: boolean; reason: string }> = [];
    const herdrBlocking: Array<{ active: boolean; label?: string }> = [];
    subject.onExtensionEvent(events.userInteraction, (event: any) => interactions.push(event));
    subject.onExtensionEvent(events.herdrBlocked, (event: any) => herdrBlocking.push(event));

    await subject.commands.get("plan-tools")?.("", subject.context);

    const reasons = [
      "Plan Mode approval scope selection",
      "Plan Mode approval type selection",
      "Plan Mode command approval program input",
      "Plan Mode command approval details input",
      "Plan Mode command approval confirmation",
    ];
    expect(interactions).toEqual(
      reasons.flatMap((reason) => [
        { active: true, reason },
        { active: false, reason },
      ]),
    );
    expect(herdrBlocking).toEqual(
      reasons.flatMap((label) => [{ active: true, label }, { active: false }]),
    );
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

  it("implements an approved plan in the current context", async () => {
    const subject = harness({ hasUI: true, selection: "Yes, implement this plan" });
    await emit(subject, "session_start", {});
    await subject.commands.get("plan")?.("", subject.context);
    subject.entries.push({
      type: "message",
      id: "assistant-current",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "<proposed_plan>\n# Current\n</proposed_plan>" }],
      },
    });
    await emit(subject, "agent_settled", {});
    expect(subject.sent.at(-1)).toBe("Implement the approved plan.");
  });

  it("implements an approved plan through only the replacement runtime", async () => {
    const subject = harness({ hasUI: true, selection: "Yes, clear context and implement" });
    await emit(subject, "session_start", {});
    await subject.commands.get("plan")?.("", subject.context);
    subject.entries.push({
      type: "message",
      id: "assistant-fresh",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "<proposed_plan>\n# Fresh\n</proposed_plan>" }],
      },
    });
    await emit(subject, "agent_settled", {});
    await new Promise((resolve) => setImmediate(resolve));

    expect(subject.replacementMessages[0]).toContain("fresh context");
    expect(subject.replacementEntries.at(-1)?.data).toMatchObject({
      mode: "default",
      implementedPlanSourceEntryId: "assistant-fresh",
    });
    expect(subject.staleAccesses).toEqual([]);
  });

  it("supports /plan-implement fresh without using the replaced runtime", async () => {
    const subject = harness({ hasUI: true, selection: "No, stay in Plan mode" });
    await emit(subject, "session_start", {});
    await subject.commands.get("plan")?.("", subject.context);
    subject.entries.push({
      type: "message",
      id: "assistant-command-fresh",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "<proposed_plan>\n# Command Fresh\n</proposed_plan>" }],
      },
    });
    await emit(subject, "agent_settled", {});

    await subject.commands.get("plan-implement")?.("fresh", subject.context);

    expect(subject.replacementMessages[0]).toContain("# Command Fresh");
    expect(subject.replacementEntries.at(-1)?.data).toMatchObject({
      implementedPlanSourceEntryId: "assistant-command-fresh",
    });
    expect(subject.staleAccesses).toEqual([]);
  });

  it("reports replacement send failures through the replacement UI", async () => {
    const subject = harness({
      hasUI: true,
      selection: "Yes, clear context and implement",
      replacementSendError: new Error("replacement send failed"),
    });
    await emit(subject, "session_start", {});
    await subject.commands.get("plan")?.("", subject.context);
    subject.entries.push({
      type: "message",
      id: "assistant-send-failure",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "<proposed_plan>\n# Failure\n</proposed_plan>" }],
      },
    });
    await emit(subject, "agent_settled", {});
    await new Promise((resolve) => setImmediate(resolve));

    expect(subject.replacementNotifications).toEqual([
      {
        message: "Could not start fresh implementation: replacement send failed",
        level: "error",
      },
    ]);
    expect(subject.replacementEntries.at(-1)?.data).toMatchObject({
      implementedPlanSourceEntryId: "assistant-send-failure",
    });
    expect(subject.staleAccesses).toEqual([]);
  });

  it("logs replacement failures when no valid UI context exists", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const subject = harness({
        hasUI: true,
        selection: "Yes, clear context and implement",
        newSessionErrorAfterInvalidation: new Error("replacement setup failed"),
      });
      await emit(subject, "session_start", {});
      await subject.commands.get("plan")?.("", subject.context);
      subject.entries.push({
        type: "message",
        id: "assistant-setup-failure",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "<proposed_plan>\n# Failure\n</proposed_plan>" }],
        },
      });
      await emit(subject, "agent_settled", {});
      await new Promise((resolve) => setImmediate(resolve));

      expect(errorSpy).toHaveBeenCalledWith(
        "[plan-mode] Could not start fresh implementation: replacement setup failed",
      );
      expect(subject.staleAccesses).toEqual([]);
    } finally {
      errorSpy.mockRestore();
    }
  });
});
