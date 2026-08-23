import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { events } from "../../../shared/events.js";
import planModeExtension from "../index.js";

type Handler = (...args: any[]) => any;
const contextMutators = [
  "ctx_execute",
  "ctx_execute_file",
  "ctx_batch_execute",
  "ctx_upgrade",
  "ctx_purge",
] as const;

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
  const replacementEntries: Array<{ id: string; customType: string; data: unknown }> = [];
  const replacementNotifications: Array<{ message: string; level: string }> = [];
  const staleAccesses: string[] = [];
  const extensionEvents: Array<{ name: string; data: unknown }> = [];
  let pendingContinuation:
    | { producerId: string; requestId: string; deliveryEntryId: string }
    | undefined;
  const selectCalls: Array<{ title: string; options: string[] }> = [];
  const notifications: Array<{ message: string; level: string }> = [];
  const execCalls: Array<{ command: string; args: string[]; timeout?: number }> = [];
  const allToolNames = ["read", "bash", "edit", "write", "ask_user_question", ...contextMutators];
  let activeTools = [...allToolNames];
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
    async exec(command: string, args: string[], execOptions?: { timeout?: number }) {
      assertOldRuntimeActive("pi.exec");
      execCalls.push({
        command,
        args: [...args],
        ...(execOptions?.timeout ? { timeout: execOptions.timeout } : {}),
      });
      return { stdout: "", stderr: "", code: 0, killed: false };
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
      return allToolNames.map((name) => ({ name }));
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
        extensionEvents.push({ name, data });
        for (const handler of bus.get(name) ?? []) handler(data);
        if (name === events.continuationEnqueue) {
          const request = data as any;
          const requestId = request.requestId ?? `${request.producerId}:mock`;
          request.respond?.({ accepted: true, requestId });
          const deliveryEntryId = `continuation-${entries.length}`;
          entries.push({
            type: "custom_message",
            id: deliveryEntryId,
            customType: request.message.customType,
            content: request.message.content,
          });
          sentMessages.push({
            customType: request.message.customType,
            content: request.message.content,
            options: { triggerTurn: true },
          });
          sent.push(`${request.message.customType}:${request.message.content}`);
          pendingContinuation = { producerId: request.producerId, requestId, deliveryEntryId };
        }
      },
      on(name: string, handler: Handler) {
        bus.set(name, [...(bus.get(name) ?? []), handler]);
      },
    },
  } as unknown as ExtensionAPI;
  const ui = {
    notify: (message: string, level: string) => notifications.push({ message, level }),
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
    getLeafId: () => entries.at(-1)?.id ?? null,
    getSessionId: () => "session",
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
      setup?: (manager: {
        appendCustomEntry(type: string, data: unknown): string;
      }) => Promise<void>;
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
          const id = `replacement-${replacementEntries.length + 1}`;
          replacementEntries.push({ id, customType, data });
          return id;
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
    notifications,
    execCalls,
    extensionEvents,
    context,
    settlePendingContinuation() {
      if (!pendingContinuation) return;
      const receipt = {
        ...pendingContinuation,
        status: "settled",
        settledEntryId: String(entries.at(-1)?.id ?? pendingContinuation.deliveryEntryId),
      };
      pendingContinuation = undefined;
      for (const handler of bus.get(events.continuationReceipt) ?? []) handler(receipt);
    },
    activeTools: () => activeTools,
    setActiveToolsForTest(names: string[]) {
      activeTools = [...names];
    },
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
  if (name === "agent_settled") subject.settlePendingContinuation();
  return Promise.all(
    (subject.handlers.get(name) ?? []).map((handler) =>
      handler(event, subject.context as ExtensionContext),
    ),
  );
}

function newestPlanState(subject: ReturnType<typeof harness>): any {
  return [...subject.entries]
    .reverse()
    .find((entry) => entry.customType === "pi-extensions:plan-mode-state")?.data;
}

async function emitSequential(
  subject: ReturnType<typeof harness>,
  name: string,
  event: unknown,
): Promise<any[]> {
  const results: any[] = [];
  for (const handler of subject.handlers.get(name) ?? []) {
    const result = await handler(event, subject.context as ExtensionContext);
    results.push(result);
    if (result?.block) break;
  }
  return results;
}

let nextToolCallId = 0;

/** Models Pi 0.84's start → cloned mutable call → end lifecycle. */
async function runToolCall(
  subject: ReturnType<typeof harness>,
  toolName: string,
  args: unknown,
  toolCallId = `tool-call-${++nextToolCallId}`,
): Promise<{
  event: { type: string; toolCallId: string; toolName: string; input: any };
  results: any[];
}> {
  await emit(subject, "tool_execution_start", {
    type: "tool_execution_start",
    toolCallId,
    toolName,
    args,
  });
  let results: any[] = [];
  try {
    const event = {
      type: "tool_call",
      toolCallId,
      toolName,
      input: structuredClone(args),
    };
    results = await emitSequential(subject, "tool_call", event);
    return { event, results };
  } finally {
    await emit(subject, "tool_execution_end", {
      type: "tool_execution_end",
      toolCallId,
      toolName,
      result: {},
      isError: results.some((result) => result?.block),
    });
  }
}

function runBash(
  subject: ReturnType<typeof harness>,
  command: unknown,
  toolCallId?: string,
): ReturnType<typeof runToolCall> {
  return runToolCall(subject, "bash", { command }, toolCallId);
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
    expect(subject.activeTools()).toContain("read");
    for (const tool of ["edit", ...contextMutators])
      expect(subject.activeTools(), tool).not.toContain(tool);
    expect((await emit(subject, "tool_call", { toolName: "edit", input: {} }))[0]).toMatchObject({
      block: true,
    });
    await subject.commands.get("plan")?.("off", subject.context);
    expect(subject.activeTools()).toEqual(expect.arrayContaining(["edit", "write"]));
  });

  it("restores persisted Plan state across tree changes and restores tools on shutdown", async () => {
    const subject = harness();
    subject.entries.push({
      type: "custom",
      customType: "pi-extensions:plan-mode-state",
      data: {
        version: 1,
        mode: "plan",
        disabledTools: ["edit", "write", ...contextMutators],
      },
    });
    await emit(subject, "session_start", {});
    expect(subject.activeTools()).toContain("read");
    for (const tool of ["edit", "write", ...contextMutators])
      expect(subject.activeTools(), tool).not.toContain(tool);

    subject.entries.push({
      type: "custom",
      customType: "pi-extensions:plan-mode-state",
      data: { version: 1, mode: "default", disabledTools: [] },
    });
    await emit(subject, "session_tree", {});
    expect(subject.activeTools()).toEqual(
      expect.arrayContaining(["edit", "write", ...contextMutators]),
    );

    subject.entries.push({
      type: "custom",
      customType: "pi-extensions:plan-mode-state",
      data: {
        version: 1,
        mode: "plan",
        disabledTools: ["edit", ...contextMutators],
      },
    });
    await emit(subject, "session_tree", {});
    expect(subject.activeTools()).not.toContain("edit");
    await emit(subject, "session_shutdown", {});
    expect(subject.activeTools()).toEqual(expect.arrayContaining(["edit", ...contextMutators]));
  });

  it("never probes RTK while loading or changing policy", async () => {
    const root = await mkdtemp(join(tmpdir(), "plan-mode-extension-"));
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = root;
    try {
      const subject = harness({
        hasUI: true,
        selections: ["Global", "CLI program", "Global", "Remove approval", "command:git:status"],
        inputs: ["git", "status"],
        confirmations: [true],
      });
      await emit(subject, "session_start", {});
      await emit(subject, "session_tree", {});
      expect(subject.execCalls).toEqual([]);

      await subject.commands.get("plan-tools")?.("", subject.context);
      expect(subject.execCalls).toEqual([]);
      await subject.commands.get("plan-tools")?.("", subject.context);
      expect(subject.execCalls).toEqual([]);
    } finally {
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("authorizes a safe original Bash command without persisting its snapshot", async () => {
    const subject = harness();
    await emit(subject, "session_start", {});
    await subject.commands.get("plan")?.("", subject.context);
    const entryCount = subject.entries.length;

    const { event, results } = await runBash(subject, "rg unique-transient-command README.md");

    expect(results).not.toContainEqual(expect.objectContaining({ block: true }));
    expect(event.input.command).toBe("rg unique-transient-command README.md");
    expect(Object.getOwnPropertyDescriptor(event.input, "command")).toMatchObject({
      enumerable: true,
      configurable: false,
      get: expect.any(Function),
      set: expect.any(Function),
    });
    expect(subject.entries).toHaveLength(entryCount);
    expect(JSON.stringify(subject.entries)).not.toContain("unique-transient-command");
  });

  it("keeps a pending Bash snapshot out of durable Plan state", async () => {
    const subject = harness();
    await emit(subject, "session_start", {});
    await subject.commands.get("plan")?.("", subject.context);
    await emit(subject, "tool_execution_start", {
      type: "tool_execution_start",
      toolCallId: "pending-persistence-check",
      toolName: "bash",
      args: { command: "rg pending-snapshot-secret README.md" },
    });

    subject.setActiveToolsForTest([...subject.activeTools(), "edit"]);
    await emit(subject, "before_agent_start", { systemPrompt: "base" });
    expect(newestPlanState(subject)).toMatchObject({ version: 2, mode: "plan" });
    expect(JSON.stringify(subject.entries)).not.toContain("pending-snapshot-secret");

    await emit(subject, "tool_execution_end", {
      type: "tool_execution_end",
      toolCallId: "pending-persistence-check",
      toolName: "bash",
      result: {},
      isError: true,
    });
  });

  it("accepts safe Bash rewrites before and after the Plan Mode handler", async () => {
    const before = harness();
    await emit(before, "session_start", {});
    await before.commands.get("plan")?.("", before.context);
    before.handlers.get("tool_call")?.unshift(async (event: any) => {
      await Promise.resolve();
      event.input.command =
        "rtk rg -n -i -S 'working indicator|working status|session summary' README.md docs packages";
    });
    const beforeRun = await runBash(before, "rg original README.md");
    expect(beforeRun.results).not.toContainEqual(expect.objectContaining({ block: true }));
    expect(beforeRun.event.input.command).toContain("rtk rg -n -i -S");

    const after = harness();
    await emit(after, "session_start", {});
    await after.commands.get("plan")?.("", after.context);
    after.handlers.get("tool_call")?.push((event: any) => {
      event.input.command = "rtk rg safe README.md";
    });
    const afterRun = await runBash(after, "rg original README.md");
    expect(afterRun.results).not.toContainEqual(expect.objectContaining({ block: true }));
    expect(afterRun.event.input.command).toBe("rtk rg safe README.md");
  });

  it("blocks an unsafe original even when an earlier handler rewrites it safely", async () => {
    const subject = harness();
    await emit(subject, "session_start", {});
    await subject.commands.get("plan")?.("", subject.context);
    subject.handlers.get("tool_call")?.unshift((event: any) => {
      event.input.command = "git status";
    });

    const { results } = await runBash(subject, "git status && git clean -fd");
    expect(results.at(-1)).toMatchObject({ block: true });
  });

  it("restores the original after an unsafe or non-string earlier rewrite", async () => {
    for (const candidate of ["find . -delete", 42]) {
      const subject = harness();
      await emit(subject, "session_start", {});
      await subject.commands.get("plan")?.("", subject.context);
      subject.handlers.get("tool_call")?.unshift((event: any) => {
        event.input.command = candidate;
      });

      const { event, results } = await runBash(subject, "git status");
      expect(results, String(candidate)).not.toContainEqual(
        expect.objectContaining({ block: true }),
      );
      expect(event.input.command, String(candidate)).toBe("git status");
    }
  });

  it("uses the safe earlier rewrite that survives transient assignments", async () => {
    const subject = harness();
    await emit(subject, "session_start", {});
    await subject.commands.get("plan")?.("", subject.context);
    subject.handlers.get("tool_call")?.unshift(
      (event: any) => {
        event.input.command = "git status && git clean -fd";
      },
      (event: any) => {
        event.input.command = "rtk git status --short";
      },
    );

    const { event, results } = await runBash(subject, "git status");
    expect(results).not.toContainEqual(expect.objectContaining({ block: true }));
    expect(event.input.command).toBe("rtk git status --short");
  });

  it("silently restores the original after unsafe or non-string later rewrites", async () => {
    for (const candidate of ["cat README.md > generated.txt", 42]) {
      const subject = harness();
      await emit(subject, "session_start", {});
      await subject.commands.get("plan")?.("", subject.context);
      subject.handlers.get("tool_call")?.push((event: any) => {
        event.input.command = candidate;
      });

      const { event, results } = await runBash(subject, "rg original README.md");
      expect(results, String(candidate)).not.toContainEqual(
        expect.objectContaining({ block: true }),
      );
      expect(event.input.command, String(candidate)).toBe("rg original README.md");
    }
  });

  it("returns to the original after a safe then unsafe rewrite", async () => {
    const subject = harness();
    await emit(subject, "session_start", {});
    await subject.commands.get("plan")?.("", subject.context);
    subject.handlers.get("tool_call")?.push((event: any) => {
      event.input.command = "rtk rg rewritten README.md";
      event.input.command = "find . -delete";
    });

    const { event, results } = await runBash(subject, "rg original README.md");
    expect(results).not.toContainEqual(expect.objectContaining({ block: true }));
    expect(event.input.command).toBe("rg original README.md");
  });

  it("allows a later safe rewrite after an unsafe rewrite restores the original", async () => {
    const subject = harness();
    await emit(subject, "session_start", {});
    await subject.commands.get("plan")?.("", subject.context);
    subject.handlers.get("tool_call")?.push((event: any) => {
      event.input.command = "find . -delete";
      event.input.command = "rtk rg recovered README.md";
    });

    const { event, results } = await runBash(subject, "rg original README.md");
    expect(results).not.toContainEqual(expect.objectContaining({ block: true }));
    expect(event.input.command).toBe("rtk rg recovered README.md");
  });

  it("restores the original after multiline or compound RTK rewrite output", async () => {
    for (const candidate of [
      "rtk rg rewritten README.md\nRTK summary: 1 file",
      "rtk rg rewritten README.md && rtk gain",
    ]) {
      const subject = harness();
      await emit(subject, "session_start", {});
      await subject.commands.get("plan")?.("", subject.context);
      subject.handlers.get("tool_call")?.push((event: any) => {
        event.input.command = candidate;
      });

      const { event, results } = await runBash(subject, "rg original README.md");
      expect(results, candidate).not.toContainEqual(expect.objectContaining({ block: true }));
      expect(event.input.command, candidate).toBe("rg original README.md");
    }
  });

  it("fails closed when an earlier handler installs a non-configurable command", async () => {
    const subject = harness();
    await emit(subject, "session_start", {});
    await subject.commands.get("plan")?.("", subject.context);
    subject.handlers.get("tool_call")?.unshift((event: any) => {
      Object.defineProperty(event.input, "command", {
        value: "rg safe README.md",
        enumerable: true,
        configurable: false,
        writable: true,
      });
    });

    const { results } = await runBash(subject, "rg safe README.md");
    expect(results.at(-1)).toMatchObject({ block: true });
  });

  it("fails closed when the guarded accessor cannot be installed", async () => {
    const subject = harness();
    await emit(subject, "session_start", {});
    await subject.commands.get("plan")?.("", subject.context);
    subject.handlers.get("tool_call")?.unshift((event: any) => {
      delete event.input.command;
      Object.preventExtensions(event.input);
    });

    const { results } = await runBash(subject, "rg safe README.md");
    expect(results.at(-1)).toMatchObject({ block: true });
  });

  it("fails closed for missing and invalid original-command snapshots", async () => {
    const missing = harness();
    await emit(missing, "session_start", {});
    await missing.commands.get("plan")?.("", missing.context);
    const missingResults = await emitSequential(missing, "tool_call", {
      type: "tool_call",
      toolCallId: "missing-snapshot",
      toolName: "bash",
      input: { command: "git status" },
    });
    expect(missingResults.at(-1)).toMatchObject({ block: true });
    await emit(missing, "tool_execution_end", {
      type: "tool_execution_end",
      toolCallId: "missing-snapshot",
      toolName: "bash",
      result: {},
      isError: true,
    });

    const invalid = harness();
    await emit(invalid, "session_start", {});
    await invalid.commands.get("plan")?.("", invalid.context);
    invalid.handlers.get("tool_call")?.unshift((event: any) => {
      event.input.command = "git status";
    });
    const invalidRun = await runBash(invalid, 42, "invalid-snapshot");
    expect(invalidRun.results.at(-1)).toMatchObject({ block: true });
  });

  it("cleans up a start that ends without a tool_call", async () => {
    const subject = harness();
    await emit(subject, "session_start", {});
    await subject.commands.get("plan")?.("", subject.context);
    await emit(subject, "tool_execution_start", {
      type: "tool_execution_start",
      toolCallId: "truncated-call",
      toolName: "bash",
      args: { command: "git status" },
    });
    for (let index = 0; index < 2; index += 1) {
      await emit(subject, "tool_execution_end", {
        type: "tool_execution_end",
        toolCallId: "truncated-call",
        toolName: "bash",
        result: {},
        isError: true,
      });
    }

    const results = await emitSequential(subject, "tool_call", {
      type: "tool_call",
      toolCallId: "truncated-call",
      toolName: "bash",
      input: { command: "git status" },
    });
    expect(results.at(-1)).toMatchObject({ block: true });
  });

  it("invalidates in-flight snapshots on session, tree, and shutdown transitions", async () => {
    for (const transition of ["session_start", "session_tree", "session_shutdown"]) {
      const subject = harness();
      await emit(subject, "session_start", {});
      await subject.commands.get("plan")?.("", subject.context);
      const toolCallId = `transition-${transition}`;
      await emit(subject, "tool_execution_start", {
        type: "tool_execution_start",
        toolCallId,
        toolName: "bash",
        args: { command: "git status" },
      });

      const transitioning = emit(subject, transition, {});
      const results = await emitSequential(subject, "tool_call", {
        type: "tool_call",
        toolCallId,
        toolName: "bash",
        input: { command: "git status" },
      });
      await transitioning;
      expect(results.at(-1), transition).toMatchObject({ block: true });
    }
  });

  it("keeps parallel snapshots separate and consumes each snapshot once", async () => {
    const subject = harness();
    await emit(subject, "session_start", {});
    await subject.commands.get("plan")?.("", subject.context);
    for (const [toolCallId, command] of [
      ["parallel-a", "git status"],
      ["parallel-b", "rtk rg pattern README.md"],
    ]) {
      await emit(subject, "tool_execution_start", {
        type: "tool_execution_start",
        toolCallId,
        toolName: "bash",
        args: { command },
      });
    }

    for (const [toolCallId, command] of [
      ["parallel-a", "git status"],
      ["parallel-b", "rtk rg pattern README.md"],
    ]) {
      const results = await emitSequential(subject, "tool_call", {
        type: "tool_call",
        toolCallId,
        toolName: "bash",
        input: structuredClone({ command }),
      });
      expect(results, toolCallId).not.toContainEqual(expect.objectContaining({ block: true }));
      const replay = await emitSequential(subject, "tool_call", {
        type: "tool_call",
        toolCallId,
        toolName: "bash",
        input: { command },
      });
      expect(replay.at(-1), toolCallId).toMatchObject({ block: true });
    }
    for (const toolCallId of ["parallel-b", "parallel-a"]) {
      await emit(subject, "tool_execution_end", {
        type: "tool_execution_end",
        toolCallId,
        toolName: "bash",
        result: {},
        isError: false,
      });
    }
  });

  it("supports sequential reuse of a completed tool-call ID", async () => {
    const subject = harness();
    await emit(subject, "session_start", {});
    await subject.commands.get("plan")?.("", subject.context);

    const first = await runBash(subject, "git status", "reused-call");
    const second = await runBash(subject, "rtk rg pattern README.md", "reused-call");
    expect(first.results).not.toContainEqual(expect.objectContaining({ block: true }));
    expect(second.results).not.toContainEqual(expect.objectContaining({ block: true }));
    expect(first.event.input.command).toBe("git status");
    expect(second.event.input.command).toBe("rtk rg pattern README.md");
  });

  it("removes reactivated Context execution tools before each agent turn", async () => {
    const subject = harness();
    await emit(subject, "session_start", {});
    await subject.commands.get("plan")?.("", subject.context);
    subject.setActiveToolsForTest([...subject.activeTools(), ...contextMutators]);
    for (const tool of contextMutators) expect(subject.activeTools(), tool).toContain(tool);
    await emit(subject, "before_agent_start", { systemPrompt: "base" });
    expect(subject.activeTools()).toContain("read");
    for (const tool of contextMutators) expect(subject.activeTools(), tool).not.toContain(tool);
    expect(
      (
        await emitSequential(subject, "tool_call", {
          toolName: "ctx_execute_file",
          input: { path: "README.md", code: "FILE_CONTENT" },
        })
      ).at(-1),
    ).toMatchObject({ block: true });
  });

  it("allows an active read profile but blocks Plan Mode for an active writer", async () => {
    const reader = harness();
    await emit(reader, "session_start", {});
    reader.emitExtensionEvent("pi-extensions:subagents-status", {
      active: 1,
      writers: 0,
    });
    await reader.commands.get("plan")?.("", reader.context);
    expect(reader.activeTools()).not.toContain("edit");

    const writer = harness();
    await emit(writer, "session_start", {});
    writer.emitExtensionEvent("pi-extensions:subagents-status", {
      active: 1,
      writers: 1,
    });
    await writer.commands.get("plan")?.("", writer.context);
    expect(writer.activeTools()).toContain("edit");
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
    expect(subject.sentMessages.at(-1)?.content).toContain(
      "one complete final <proposed_plan> block",
    );
    expect(subject.sentMessages.at(-1)?.content).toContain("even when the plan is unchanged");
    expect(subject.sentMessages.at(-1)?.content).toContain("Do not approve or implement");
    expect(
      [...subject.entries]
        .reverse()
        .find((entry) => entry.customType === "pi-extensions:plan-mode-state")?.data,
    ).toMatchObject({
      version: 2,
      lastReview: {
        planSourceEntryId: "assistant-review",
        reviewerId: "plan-reviewer-1",
        thinking: "high",
      },
      revisionExpectation: {
        phase: "awaiting",
        reviewedPlan: { sourceEntryId: "assistant-review", markdown: "# Review me" },
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

  it("defers restored receipts until destination-branch Plan state is synchronized", async () => {
    const subject = harness({ hasUI: true });
    await emit(subject, "session_start", {});
    subject.emitExtensionEvent(events.continuationReceipt, {
      producerId: "plan-mode:review-revision:v2",
      requestId: "review-destination",
      status: "settled",
      sessionId: "session",
      originEntryId: "origin-destination",
      deliveryEntryId: "delivery-destination",
    });
    expect(subject.entries).toHaveLength(0);

    subject.entries.push(
      {
        type: "message",
        id: "origin-destination",
        message: { role: "user", content: [{ type: "text", text: "destination" }] },
      },
      {
        type: "custom",
        id: "state-destination",
        customType: "pi-extensions:plan-mode-state",
        data: {
          version: 2,
          mode: "plan",
          disabledTools: ["edit", "write"],
          latestPlan: { markdown: "# Destination", sourceEntryId: "plan-destination" },
          revisionExpectation: {
            reviewedPlan: { markdown: "# Destination", sourceEntryId: "plan-destination" },
            phase: "awaiting",
            retryCount: 0,
            reviewContinuationId: "review-destination",
            responseBoundary: {
              requestId: "review-destination",
              originEntryId: "origin-destination",
            },
          },
        },
      },
      {
        type: "custom_message",
        id: "delivery-destination",
        customType: "plan-review-response",
        content: "review",
      },
    );
    await emit(subject, "session_tree", {});

    expect(newestPlanState(subject)).toMatchObject({
      latestPlan: { sourceEntryId: "plan-destination" },
      revisionExpectation: {
        responseBoundary: {
          requestId: "review-destination",
          originEntryId: "origin-destination",
          deliveryEntryId: "delivery-destination",
        },
      },
    });
  });

  it("turns a sibling-only settled review boundary into the one allowed correction", async () => {
    const subject = harness({ hasUI: true });
    subject.entries.push(
      {
        type: "message",
        id: "shared-origin",
        message: { role: "user", content: [{ type: "text", text: "shared" }] },
      },
      {
        type: "custom",
        id: "plan-state-stale-boundary",
        customType: "pi-extensions:plan-mode-state",
        data: {
          version: 2,
          mode: "plan",
          disabledTools: ["edit", "write"],
          latestPlan: { markdown: "# Shared", sourceEntryId: "shared-plan" },
          revisionExpectation: {
            reviewedPlan: { markdown: "# Shared", sourceEntryId: "shared-plan" },
            phase: "awaiting",
            retryCount: 0,
            reviewContinuationId: "review-sibling",
            responseBoundary: {
              requestId: "review-sibling",
              originEntryId: "shared-origin",
              deliveryEntryId: "sibling-delivery",
              settledEntryId: "sibling-settled",
            },
          },
        },
      },
      {
        type: "custom",
        id: "coordinator-stale-boundary",
        customType: "workflow-finalization:continuation-state",
        data: {
          version: 1,
          producerSequences: { "plan-mode:review-revision:v2": 1 },
          nextOrdinal: 1,
          requests: [
            {
              version: 1,
              requestId: "review-sibling",
              producerId: "plan-mode:review-revision:v2",
              sequence: 1,
              ordinal: 1,
              revision: 1,
              message: { content: "review" },
              sessionId: "session",
              originEntryId: "shared-origin",
              deliveryEntryId: "sibling-delivery",
              settledEntryId: "sibling-settled",
              status: "settled",
            },
          ],
        },
      },
    );
    await emit(subject, "session_start", {});
    expect(newestPlanState(subject).revisionExpectation).toMatchObject({
      phase: "correction-requested",
      retryCount: 1,
      parseFailure: "missing",
    });
    expect(
      subject.sentMessages.filter((message) => message.customType === "plan-review-correction"),
    ).toHaveLength(1);
  });

  it("accepts an immediate reviewed proposal and skips a newer marker-free acknowledgement", async () => {
    const subject = harness({
      hasUI: true,
      selections: ["No, stay in Plan mode", "provider/model", "off", "No, stay in Plan mode"],
    });
    await emit(subject, "session_start", {});
    await subject.commands.get("plan")?.("", subject.context);
    subject.entries.push({
      type: "message",
      id: "review-source-immediate",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "<proposed_plan>\n# Original\n</proposed_plan>" }],
      },
    });
    await emit(subject, "agent_settled", {});
    subject.onExtensionEvent(events.planReview, (request: any) => {
      request.accept();
      request.respond({ reviewerId: "reviewer", model: request.model, report: "No changes." });
    });
    await subject.commands.get("plan-review")?.("", subject.context);
    await subject.commands.get("plan-implement")?.("", subject.context);
    expect(subject.notifications.at(-1)?.message).toContain("active plan revision");
    expect(
      subject.sentMessages.filter((message) => message.customType === "plan-mode-implementation"),
    ).toHaveLength(0);
    subject.entries.push(
      {
        type: "message",
        id: "review-valid-immediate",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "<proposed_plan>\n# Original\n</proposed_plan>" }],
        },
      },
      {
        type: "message",
        id: "review-ack",
        message: { role: "assistant", content: [{ type: "text", text: "Done." }] },
      },
    );
    await emit(subject, "agent_settled", {});

    expect(newestPlanState(subject)).toMatchObject({
      latestPlan: { sourceEntryId: "review-valid-immediate", markdown: "# Original" },
      lastOfferedEntryId: "review-valid-immediate",
    });
    expect(newestPlanState(subject).revisionExpectation).toBeUndefined();
    expect(
      subject.sentMessages.filter((message) => message.customType === "plan-review-correction"),
    ).toHaveLength(0);
  });

  it("persists one correction across tree reloads and accepts the corrected proposal without replay", async () => {
    const subject = harness({
      hasUI: true,
      selections: ["No, stay in Plan mode", "provider/model", "off", "No, stay in Plan mode"],
    });
    await emit(subject, "session_start", {});
    await subject.commands.get("plan")?.("", subject.context);
    subject.entries.push({
      type: "message",
      id: "review-source-correction",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "<proposed_plan>\n# Keep me\n</proposed_plan>" }],
      },
    });
    await emit(subject, "agent_settled", {});
    subject.onExtensionEvent(events.planReview, (request: any) => {
      request.accept();
      request.respond({ reviewerId: "reviewer", model: request.model, report: "Revise tests." });
    });
    await subject.commands.get("plan-review")?.("", subject.context);
    subject.entries.push({
      type: "message",
      id: "review-malformed-first",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "<proposed_plan>\n# Broken" }],
      },
    });
    await emit(subject, "agent_settled", {});

    expect(newestPlanState(subject)).toMatchObject({
      latestPlan: { sourceEntryId: "review-source-correction", markdown: "# Keep me" },
      revisionExpectation: {
        phase: "correction-requested",
        retryCount: 1,
        parseFailure: "unterminated",
        correctionContinuationId: expect.any(String),
      },
    });
    expect(
      subject.sentMessages.filter((message) => message.customType === "plan-review-correction"),
    ).toHaveLength(1);

    await emit(subject, "session_tree", {});
    await emit(subject, "session_tree", {});
    await subject.commands.get("plan-review")?.("", subject.context);
    expect(
      subject.sentMessages.filter((message) => message.customType === "plan-review-correction"),
    ).toHaveLength(1);
    expect(subject.notifications.at(-1)?.message).toContain("still awaiting");

    subject.entries.push({
      type: "message",
      id: "review-corrected-success",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "<proposed_plan>\n# Corrected\n</proposed_plan>" }],
      },
    });
    await emit(subject, "agent_settled", {});
    expect(newestPlanState(subject)).toMatchObject({
      latestPlan: { sourceEntryId: "review-corrected-success", markdown: "# Corrected" },
    });
    expect(newestPlanState(subject).revisionExpectation).toBeUndefined();
  });

  it("lets a newer malformed proposal supersede an older valid one and warns once after retry", async () => {
    const subject = harness({
      hasUI: true,
      selections: ["No, stay in Plan mode", "provider/model", "off", "provider/model", "off"],
    });
    await emit(subject, "session_start", {});
    await subject.commands.get("plan")?.("", subject.context);
    subject.entries.push({
      type: "message",
      id: "review-source-warning",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "<proposed_plan>\n# Preserved\n</proposed_plan>" }],
      },
    });
    await emit(subject, "agent_settled", {});
    subject.onExtensionEvent(events.planReview, (request: any) => {
      request.accept();
      request.respond({ reviewerId: "reviewer", model: request.model, report: "Review." });
    });
    await subject.commands.get("plan-review")?.("", subject.context);
    subject.entries.push(
      {
        type: "message",
        id: "review-older-valid",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "<proposed_plan>\n# Should not win\n</proposed_plan>" }],
        },
      },
      {
        type: "message",
        id: "review-newer-malformed",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "<proposed_plan>\n# New bad" }],
        },
      },
    );
    await emit(subject, "agent_settled", {});
    expect(newestPlanState(subject).revisionExpectation.phase).toBe("correction-requested");

    subject.entries.push({
      type: "message",
      id: "review-second-malformed",
      message: { role: "assistant", content: [{ type: "text", text: "No proposal here." }] },
    });
    await emit(subject, "agent_settled", {});
    expect(newestPlanState(subject)).toMatchObject({
      mode: "plan",
      latestPlan: { sourceEntryId: "review-source-warning", markdown: "# Preserved" },
      revisionExpectation: { phase: "warned", retryCount: 1, parseFailure: "missing" },
    });
    expect(
      subject.sentMessages.filter((message) => message.customType === "plan-review-correction"),
    ).toHaveLength(1);
    const warnings = subject.notifications.filter((notification) =>
      notification.message.includes("still invalid after one correction"),
    );
    expect(warnings).toHaveLength(1);
    await emit(subject, "agent_settled", {});
    expect(
      subject.notifications.filter((notification) =>
        notification.message.includes("still invalid after one correction"),
      ),
    ).toHaveLength(1);

    const warnedReviewId = newestPlanState(subject).revisionExpectation.reviewContinuationId;
    await subject.commands.get("plan-review")?.("", subject.context);
    expect(newestPlanState(subject).revisionExpectation).toMatchObject({
      phase: "awaiting",
      retryCount: 0,
    });
    expect(newestPlanState(subject).revisionExpectation.reviewContinuationId).not.toBe(
      warnedReviewId,
    );
    expect(
      subject.sentMessages.filter((message) => message.customType === "plan-review"),
    ).toHaveLength(2);
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
    expect(subject.sent.at(-1)).toBe("plan-mode-implementation:Implement the approved plan.");
    const waveIndex = subject.extensionEvents.findIndex(
      (event) => event.name === events.implementationWaveAdvance,
    );
    const enqueueIndex = subject.extensionEvents.findIndex(
      (event) => event.name === events.continuationEnqueue,
    );
    expect(waveIndex).toBeGreaterThanOrEqual(0);
    expect(enqueueIndex).toBeGreaterThan(waveIndex);
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
    expect(
      subject.replacementEntries.find(
        (entry) => entry.customType === "pi-extensions:plan-mode-state",
      )?.data,
    ).toMatchObject({
      version: 2,
      mode: "default",
      implementedPlanSourceEntryId: "assistant-fresh",
    });
    const replacementPlanState = subject.replacementEntries.find(
      (entry) => entry.customType === "pi-extensions:plan-mode-state",
    );
    expect(
      subject.replacementEntries.find(
        (entry) => entry.customType === "workflow-finalization:implementation-wave",
      )?.data,
    ).toMatchObject({ armed: true, wave: 1, anchorEntryId: replacementPlanState?.id });
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
    expect(
      subject.replacementEntries.find(
        (entry) => entry.customType === "pi-extensions:plan-mode-state",
      )?.data,
    ).toMatchObject({
      version: 2,
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
    expect(
      subject.replacementEntries.find(
        (entry) => entry.customType === "pi-extensions:plan-mode-state",
      )?.data,
    ).toMatchObject({
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
