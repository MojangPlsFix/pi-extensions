import { beforeEach, describe, expect, it, vi } from "vitest";

const fakes = vi.hoisted(() => {
  const listeners = new Set<(event: any) => void>();
  let resolvePrompt: () => void = () => {};
  const promptPromise = () =>
    new Promise<void>((resolve) => {
      resolvePrompt = resolve;
    });
  const session = {
    sessionFile: "/tmp/session/run.jsonl",
    isStreaming: true,
    isIdle: true,
    prompt: vi.fn((_text: string, options?: { preflightResult?: (success: boolean) => void }) => {
      options?.preflightResult?.(true);
      return promptPromise();
    }),
    waitForIdle: vi.fn(async () => {}),
    bindExtensions: vi.fn(async () => {}),
    getAllTools: vi.fn(() => [{ name: "read" }, { name: "write" }, { name: "contact_supervisor" }]),
    setActiveToolsByName: vi.fn(),
    subscribe: vi.fn((listener: (event: any) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
    steer: vi.fn(async () => {}),
    followUp: vi.fn(async () => {}),
    abort: vi.fn(async () => {}),
    dispose: vi.fn(),
    setSessionName: vi.fn(),
  };
  return {
    listeners,
    session,
    resolvePrompt: () => resolvePrompt(),
    loaderReload: vi.fn(async () => {}),
    createAgentSession: vi.fn(async () => ({
      session,
      extensionsResult: { extensions: [], errors: [] },
    })),
  };
});

vi.mock("@earendil-works/pi-coding-agent", () => ({
  createAgentSession: fakes.createAgentSession,
  DefaultResourceLoader: class {
    reload = fakes.loaderReload;
    getExtensions() {
      return { extensions: [], errors: [] };
    }
  },
  SessionManager: {
    create: vi.fn(() => ({ kind: "created" })),
    open: vi.fn(() => ({ kind: "opened" })),
  },
  SettingsManager: {
    inMemory: vi.fn(() => ({ kind: "settings" })),
  },
}));

import { NativeBackend, type NativeRunEvent } from "../native-backend.js";

beforeEach(() => {
  fakes.listeners.clear();
  for (const value of Object.values(fakes.session))
    if (typeof value === "function" && "mockClear" in value) value.mockClear();
  fakes.loaderReload.mockClear();
  fakes.createAgentSession.mockClear();
  fakes.session.bindExtensions.mockResolvedValue(undefined);
  fakes.session.isStreaming = true;
  fakes.session.isIdle = true;
});

function spec() {
  return {
    id: "run-1",
    cwd: process.cwd(),
    agentDir: "/tmp/agent",
    sessionDir: "/tmp/session",
    task: "Inspect the parser.",
    systemPrompt: "You are Scout.",
    tools: ["read"],
  };
}

describe("NativeBackend", () => {
  it("rejects an already-cancelled startup before it creates a session", async () => {
    const controller = new AbortController();
    controller.abort(new Error("parent closed"));
    const backend = new NativeBackend();
    await expect(backend.start({ ...spec(), signal: controller.signal }, () => {})).rejects.toThrow(
      "parent closed",
    );
    expect(fakes.createAgentSession).not.toHaveBeenCalled();
    expect(backend.has("run-1")).toBe(false);
  });

  it("submits the initial prompt through AgentSession without a terminal transport", async () => {
    const events: NativeRunEvent[] = [];
    const backend = new NativeBackend();
    await backend.start(spec(), (event) => events.push(event));
    expect(fakes.session.prompt).toHaveBeenCalledWith(
      "Inspect the parser.",
      expect.objectContaining({ source: "rpc", preflightResult: expect.any(Function) }),
    );
    expect(events[0]).toEqual({ type: "accepted", sessionFile: "/tmp/session/run.jsonl" });
    expect(fakes.createAgentSession).toHaveBeenCalledWith(
      expect.objectContaining({ noTools: "builtin" }),
    );
    expect(fakes.session.setActiveToolsByName).toHaveBeenCalledWith(["read"]);
    expect(backend.has("run-1")).toBe(true);
    fakes.resolvePrompt();
    await vi.waitFor(() => expect(events.some((event) => event.type === "settled")).toBe(true));
  });

  it("settles startup when a session is parked before prompt acceptance", async () => {
    fakes.session.prompt.mockImplementationOnce(async () => {
      await new Promise<void>(() => {});
    });
    const backend = new NativeBackend();
    const startResult = backend
      .start(spec(), () => {})
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    await vi.waitFor(() => expect(backend.has("run-1")).toBe(true));
    await backend.park("run-1");
    await expect(startResult).resolves.toEqual(
      expect.objectContaining({ message: expect.stringContaining("parked during startup") }),
    );
    expect(fakes.session.dispose).toHaveBeenCalledOnce();
  });

  it("forwards text and tool events and disposes a parked session", async () => {
    const events: NativeRunEvent[] = [];
    const backend = new NativeBackend();
    await backend.start(spec(), (event) => events.push(event));
    for (const listener of fakes.listeners) {
      listener({ type: "message_start", message: { role: "assistant" } });
      listener({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "Evidence" },
      });
      listener({ type: "tool_execution_start", toolName: "read" });
      listener({ type: "tool_execution_end", toolName: "read", isError: false });
    }
    expect(events).toContainEqual({ type: "text", delta: "Evidence", text: "Evidence" });
    expect(events).toContainEqual({ type: "tool_start", toolName: "read" });
    await backend.park("run-1");
    expect(fakes.session.dispose).toHaveBeenCalledOnce();
    expect(backend.has("run-1")).toBe(false);
    fakes.resolvePrompt();
  });

  it("forwards the total from Pi's nested usage cost object", async () => {
    const events: NativeRunEvent[] = [];
    const backend = new NativeBackend();
    await backend.start(spec(), (event) => events.push(event));
    for (const listener of fakes.listeners) {
      listener({
        type: "message_end",
        message: {
          role: "assistant",
          usage: {
            input: 100,
            output: 25,
            cacheRead: 10,
            cacheWrite: 5,
            cost: { input: 0.01, output: 0.02, cacheRead: 0.001, cacheWrite: 0.002, total: 0.033 },
          },
        },
      });
    }
    expect(events).toContainEqual({
      type: "usage",
      input: 100,
      output: 25,
      cacheRead: 10,
      cacheWrite: 5,
      cost: 0.033,
    });
    await backend.park("run-1");
    fakes.resolvePrompt();
  });

  it("activates manager-owned custom tools without exposing unselected built-ins", async () => {
    const backend = new NativeBackend();
    await backend.start(
      {
        ...spec(),
        customTools: [{ name: "contact_supervisor" } as never],
      },
      () => {},
    );
    expect(fakes.session.setActiveToolsByName).toHaveBeenCalledWith(["read", "contact_supervisor"]);
    fakes.resolvePrompt();
    await backend.park("run-1");
  });

  it("disposes a session when extension binding fails before prompt acceptance", async () => {
    fakes.session.bindExtensions.mockRejectedValueOnce(new Error("binding failed"));
    const backend = new NativeBackend();
    await expect(backend.start(spec(), () => {})).rejects.toThrow("binding failed");
    expect(fakes.session.abort).toHaveBeenCalledOnce();
    expect(fakes.session.dispose).toHaveBeenCalledOnce();
    expect(backend.has("run-1")).toBe(false);
  });

  it("uses steer and follow-up APIs instead of terminal keystrokes", async () => {
    const backend = new NativeBackend();
    await backend.start(spec(), () => {});
    await backend.steer("run-1", "Check the other parser.");
    await backend.followUp("run-1", "Summarize the result.");
    expect(fakes.session.steer).toHaveBeenCalledWith("Check the other parser.");
    expect(fakes.session.followUp).toHaveBeenCalledWith("Summarize the result.");
    fakes.resolvePrompt();
    await backend.park("run-1");
  });

  it("disposes an accepted session when its parent cancellation signal fires", async () => {
    const controller = new AbortController();
    const backend = new NativeBackend();
    await backend.start({ ...spec(), signal: controller.signal }, () => {});
    controller.abort(new Error("parent closed"));
    await vi.waitFor(() => expect(backend.has("run-1")).toBe(false));
    expect(fakes.session.dispose).toHaveBeenCalledOnce();
  });
});
