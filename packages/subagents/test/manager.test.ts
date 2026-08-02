import { describe, expect, it, vi } from "vitest";
import { events } from "../../../shared/events.js";
import { SubagentManager } from "../manager.js";
import { RpcBackend } from "../rpc-backend.js";
import { consumeSessionRecord } from "../session-poller.js";
import { emptyUsage, type ManagedAgent } from "../types.js";

function agent(status: ManagedAgent["status"] = "completed"): ManagedAgent {
  return {
    id: "agent-1",
    name: "explorer",
    definition: {
      name: "explorer",
      description: "test",
      mode: "explorer",
      prompt: "test",
      source: "builtin",
    },
    task: "initial",
    taskHistory: ["initial"],
    status,
    backend: "rpc",
    startedAt: new Date().toISOString(),
    ...(status === "completed" ? { finishedAt: "2026-01-01T00:00:00.000Z" } : {}),
    sessionDir: "/tmp/session",
    stderr: "",
    output: "report",
    usage: emptyUsage(),
    completionReported: true,
    activity: [],
  };
}

function managerHarness() {
  const eventHandlers = new Map<string, (data: unknown) => void>();
  const pi = {
    events: {
      on(name: string, handler: (data: unknown) => void) {
        eventHandlers.set(name, handler);
      },
      emit: vi.fn(),
    },
    sendMessage: vi.fn(),
  } as never;
  return {
    manager: new SubagentManager(pi),
    emitEvent(name: string, data: unknown) {
      eventHandlers.get(name)?.(data);
    },
  };
}

describe("SubagentManager follow-up lifecycle", () => {
  it("restarts a completed agent poller before a successful follow-up", async () => {
    const { manager } = managerHarness();
    const subject = agent();
    manager.store.add(subject);
    const poller = { resetPromptBoundary: vi.fn(), start: vi.fn(), stop: vi.fn() };
    const internals = manager as unknown as { pollers: Map<string, typeof poller>; rpc: object };
    internals.pollers.set(subject.id, poller);
    internals.rpc = { send: vi.fn() };

    await manager.send(subject.id, "next task");

    expect(poller.resetPromptBoundary).toHaveBeenCalledOnce();
    expect(poller.start).toHaveBeenCalledOnce();
    expect(subject.status).toBe("running");
    expect(subject.taskHistory).toEqual(["initial", "next task"]);
  });

  it("stops a restarted poller and restores state when follow-up delivery fails", async () => {
    const { manager } = managerHarness();
    const subject = agent();
    manager.store.add(subject);
    const poller = { resetPromptBoundary: vi.fn(), start: vi.fn(), stop: vi.fn() };
    const internals = manager as unknown as { pollers: Map<string, typeof poller>; rpc: object };
    internals.pollers.set(subject.id, poller);
    internals.rpc = {
      send: vi.fn(() => {
        throw new Error("closed child");
      }),
    };

    await expect(manager.send(subject.id, "next task")).rejects.toThrow("closed child");

    expect(poller.stop).toHaveBeenCalledOnce();
    expect(subject.status).toBe("completed");
    expect(subject.finishedAt).toBe("2026-01-01T00:00:00.000Z");
    expect(subject.taskHistory).toEqual(["initial"]);
    expect(subject.task).toBe("initial");
  });

  it("rejects a real closed RPC client with an actionable follow-up error", async () => {
    const { manager } = managerHarness();
    const subject = agent();
    manager.store.add(subject);
    const poller = { resetPromptBoundary: vi.fn(), start: vi.fn(), stop: vi.fn() };
    const internals = manager as unknown as { pollers: Map<string, typeof poller>; rpc: object };
    internals.pollers.set(subject.id, poller);
    internals.rpc = new RpcBackend(vi.fn(), vi.fn());

    await expect(manager.send(subject.id, "next task")).rejects.toThrow("RPC child is closed");
    expect(poller.stop).toHaveBeenCalledOnce();
  });

  it("resolves wait promptly when the signal aborts after waiting begins", async () => {
    const { manager } = managerHarness();
    const subject = agent("running");
    manager.store.add(subject);
    const controller = new AbortController();
    const waiting = manager.wait(subject.id, false, controller.signal);
    controller.abort();
    await expect(waiting).resolves.toEqual([subject]);
  });

  it("uses RPC by default and rejects incomplete or broken explicit Herdr", async () => {
    const { manager } = managerHarness();
    const internals = manager as unknown as { selectBackend(): Promise<"rpc" | "herdr"> };
    const original = {
      HERDR_ENV: process.env.HERDR_ENV,
      HERDR_PANE_ID: process.env.HERDR_PANE_ID,
      HERDR_SOCKET_PATH: process.env.HERDR_SOCKET_PATH,
    };
    delete process.env.HERDR_ENV;
    delete process.env.HERDR_PANE_ID;
    delete process.env.HERDR_SOCKET_PATH;
    await expect(internals.selectBackend()).resolves.toBe("rpc");
    process.env.HERDR_ENV = "1";
    await expect(internals.selectBackend()).rejects.toThrow("incomplete");
    process.env.HERDR_PANE_ID = "pane";
    process.env.HERDR_SOCKET_PATH = "/definitely-missing-herdr-control";
    await expect(internals.selectBackend()).rejects.toThrow("control plane is unavailable");
    for (const [key, value] of Object.entries(original))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
  });

  it("does not double-count RPC usage when the same JSONL record is observed", () => {
    const { manager } = managerHarness();
    const subject = agent("running");
    const internals = manager as unknown as {
      onRpcEvent(agent: ManagedAgent, event: unknown): void;
    };
    internals.onRpcEvent(subject, {
      type: "message_end",
      message: { role: "assistant", content: [], usage: { input: 7, totalTokens: 7 } },
    });
    consumeSessionRecord(
      subject,
      { type: "message", message: { role: "assistant", usage: { input: 7, totalTokens: 7 } } },
      false,
    );
    expect(subject.usage.total).toBe(7);
  });

  it("shuts down completed persistent children and blocks worker resumption in Plan Mode", async () => {
    const { manager, emitEvent } = managerHarness();
    const explorer = agent();
    const worker = agent();
    worker.id = "worker-1";
    worker.definition = { ...worker.definition, name: "worker", mode: "worker" };
    manager.store.add(explorer);
    manager.store.add(worker);
    const explorerPoller = { resetPromptBoundary: vi.fn(), start: vi.fn(), stop: vi.fn() };
    const workerPoller = { resetPromptBoundary: vi.fn(), start: vi.fn(), stop: vi.fn() };
    const shutdown = vi.fn();
    const internals = manager as unknown as {
      pollers: Map<string, typeof explorerPoller>;
      rpc: object;
    };
    internals.pollers.set(explorer.id, explorerPoller);
    internals.pollers.set(worker.id, workerPoller);
    internals.rpc = { send: vi.fn(), shutdown };

    emitEvent(events.planMode, { enabled: true });
    await expect(manager.send(explorer.id, "read only task")).resolves.toBe(explorer);
    await expect(manager.send(worker.id, "write task")).rejects.toThrow("Workers cannot resume");

    manager.shutdown();
    expect(shutdown).toHaveBeenCalledTimes(2);
    expect(explorerPoller.stop).toHaveBeenCalled();
    expect(workerPoller.stop).toHaveBeenCalled();
  });
});
