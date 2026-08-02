import { describe, expect, it, vi } from "vitest";
import { HerdrBackend } from "../herdr-backend.js";
import type { HerdrClient } from "../herdr-client.js";
import { emptyUsage, type ManagedAgent } from "../types.js";

function agent(id: string): ManagedAgent {
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
    task: "inspect",
    taskHistory: ["inspect"],
    status: "running",
    backend: "herdr",
    startedAt: new Date().toISOString(),
    sessionDir: `/tmp/${id}`,
    stderr: "",
    output: "",
    usage: emptyUsage(),
    completionReported: false,
    activity: [],
  };
}

describe("HerdrBackend startup", () => {
  it("serializes concurrent spawns so pane topology and shell startup cannot race", async () => {
    const calls: string[] = [];
    let releaseFirstStart = () => {};
    const firstStartBlocked = new Promise<void>((resolve) => {
      releaseFirstStart = resolve;
    });
    let firstStartEntered = () => {};
    const firstStartSeen = new Promise<void>((resolve) => {
      firstStartEntered = resolve;
    });
    let paneNumber = 0;
    const client = {
      verify: vi.fn(async () => {}),
      split: vi.fn(async () => {
        paneNumber += 1;
        calls.push(`split-${paneNumber}`);
        return `pane-${paneNumber}`;
      }),
      start: vi.fn(async (_name: string, pane: string) => {
        calls.push(`start-${pane}`);
        if (pane === "pane-1") {
          firstStartEntered();
          await firstStartBlocked;
        }
      }),
      prompt: vi.fn(async (pane: string) => {
        calls.push(`prompt-${pane}`);
      }),
      wait: vi.fn(() => new Promise<void>(() => {})),
    } as unknown as HerdrClient;
    const backend = new HerdrBackend(
      client,
      "parent",
      "/project",
      () => ({}),
      () => [],
      vi.fn(),
      vi.fn(),
    );

    const first = backend.spawn(agent("explorer-a"), "first task");
    const second = backend.spawn(agent("explorer-b"), "second task");
    await firstStartSeen;

    expect(calls).toEqual(["split-1", "start-pane-1"]);
    releaseFirstStart();
    await Promise.all([first, second]);
    expect(calls).toEqual([
      "split-1",
      "start-pane-1",
      "prompt-pane-1",
      "split-2",
      "start-pane-2",
      "prompt-pane-2",
    ]);
  });

  it("closes and forgets an extension-owned pane when startup fails", async () => {
    const close = vi.fn(async () => {});
    const client = {
      verify: vi.fn(async () => {}),
      split: vi.fn(async () => "pane-1"),
      start: vi.fn(async () => {
        throw new Error("startup failed");
      }),
      close,
    } as unknown as HerdrClient;
    const onError = vi.fn();
    const backend = new HerdrBackend(
      client,
      "parent",
      "/project",
      () => ({}),
      () => [],
      vi.fn(),
      onError,
    );
    const subject = agent("explorer-a");

    await expect(backend.spawn(subject, "task")).rejects.toThrow("startup failed");

    expect(close).toHaveBeenCalledWith("pane-1");
    expect(subject.herdrPaneId).toBeUndefined();
    expect(onError).toHaveBeenCalledOnce();
  });
});
