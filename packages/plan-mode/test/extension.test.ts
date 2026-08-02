import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import planModeExtension from "../index.js";

type Handler = (...args: any[]) => any;

function harness(options: { hasUI?: boolean; selection?: string } = {}) {
  const commands = new Map<string, Handler>();
  const handlers = new Map<string, Handler[]>();
  const bus = new Map<string, Handler[]>();
  const entries: Array<Record<string, unknown>> = [];
  const sent: string[] = [];
  const replacementMessages: string[] = [];
  let activeTools = ["read", "bash", "edit", "write", "ask_user_question", "ctx_execute"];
  const api = {
    registerCommand(name: string, command: { handler: Handler }) {
      commands.set(name, command.handler);
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
    ui: {
      notify: () => undefined,
      select: async () => options.selection,
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
    handlers,
    entries,
    sent,
    replacementMessages,
    context,
    activeTools: () => activeTools,
    emitExtensionEvent(name: string, data: unknown) {
      for (const handler of bus.get(name) ?? []) handler(data);
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
