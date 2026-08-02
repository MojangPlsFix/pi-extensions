import { describe, expect, it, vi } from "vitest";
import { boundedDisplayText, HerdrBackend, taskPaneTitle } from "../herdr-backend.js";
import type { HerdrClient, HerdrPaneLayout, HerdrPaneMetadata } from "../herdr-client.js";
import { emptyUsage, type ManagedAgent } from "../types.js";

function agent(id: string, task = "inspect"): ManagedAgent {
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
    task,
    taskHistory: [task],
    status: "running",
    backend: "herdr",
    startedAt: new Date().toISOString(),
    sessionDir: `/tmp/${id}`,
    stderr: "",
    output: "",
    usage: emptyUsage(),
    completionReported: false,
    requestedModel: "provider/a-model-with-a-name",
    activity: [],
  };
}

function layout(panes: Array<[string, number, number]>, tabId = "tab-1"): HerdrPaneLayout {
  return {
    tabId,
    panes: panes.map(([paneId, width, height], index) => ({
      paneId,
      rect: { x: index * 10, y: 0, width, height },
    })),
  };
}

function backendClient(overrides: Partial<HerdrClient> = {}): HerdrClient {
  return {
    verify: vi.fn(async () => {}),
    createTab: vi.fn(async () => ({ tabId: "tab-1", paneId: "pane-1" })),
    layout: vi.fn(async () => layout([["pane-1", 120, 80]])),
    split: vi.fn(async () => "pane-2"),
    start: vi.fn(async () => {}),
    reportMetadata: vi.fn(async () => {}),
    prompt: vi.fn(async () => {}),
    wait: vi.fn(() => new Promise<void>(() => {})),
    waitForWorking: vi.fn(() => new Promise<void>(() => {})),
    interrupt: vi.fn(async () => {}),
    focus: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    closeTab: vi.fn(async () => {}),
    ...overrides,
  } as unknown as HerdrClient;
}

function backend(client: HerdrClient, warning = vi.fn()): HerdrBackend {
  return new HerdrBackend(
    client,
    "parent",
    "/work/alpha",
    () => ({}),
    () => [],
    vi.fn(),
    vi.fn(),
    vi.fn(),
    warning,
  );
}

describe("HerdrBackend dedicated tab topology", () => {
  it("creates a non-focused project tab, uses its root pane, and serializes spawns", async () => {
    const calls: string[] = [];
    let releaseFirstStart = () => {};
    const firstStartBlocked = new Promise<void>((resolve) => {
      releaseFirstStart = resolve;
    });
    let firstStartEntered = () => {};
    const firstStartSeen = new Promise<void>((resolve) => {
      firstStartEntered = resolve;
    });
    const client = backendClient({
      createTab: vi.fn(async (label: string) => {
        calls.push(`tab-${label}`);
        return { tabId: "tab-1", paneId: "pane-1" };
      }),
      layout: vi.fn(async () => {
        calls.push("layout");
        return layout([["pane-1", 200, 60]]);
      }),
      split: vi.fn(async (_pane: string, direction: string) => {
        calls.push(`split-${direction}`);
        return "pane-2";
      }),
      start: vi.fn(async (_name: string, pane: string) => {
        calls.push(`start-${pane}`);
        if (pane === "pane-1") {
          firstStartEntered();
          await firstStartBlocked;
        }
      }),
      reportMetadata: vi.fn(async (pane: string) => {
        calls.push(`metadata-${pane}`);
      }),
      prompt: vi.fn(async (pane: string) => {
        calls.push(`prompt-${pane}`);
      }),
    });
    const subject = backend(client);

    const first = subject.spawn(agent("explorer-a"), "first task");
    const second = subject.spawn(agent("explorer-b"), "second task");
    await firstStartSeen;

    expect(calls).toEqual(["tab-Subagents · alpha", "start-pane-1"]);
    releaseFirstStart();
    await Promise.all([first, second]);
    expect(calls).toEqual([
      "tab-Subagents · alpha",
      "start-pane-1",
      "metadata-pane-1",
      "prompt-pane-1",
      "layout",
      "split-right",
      "start-pane-2",
      "metadata-pane-2",
      "prompt-pane-2",
    ]);
  });

  it("queries fresh geometry before every later split and chooses the largest owned pane", async () => {
    let nextPane = 2;
    const layouts = [
      layout([["pane-1", 200, 60]]),
      layout([
        ["pane-1", 80, 80],
        ["pane-2", 100, 120],
      ]),
    ];
    const client = backendClient({
      layout: vi.fn(async () => layouts.shift()!),
      split: vi.fn(async () => `pane-${nextPane++}`),
    });
    const subject = backend(client);

    await subject.spawn(agent("a"), "one");
    await subject.spawn(agent("b"), "two");
    await subject.spawn(agent("c"), "three");

    expect(client.layout).toHaveBeenCalledTimes(2);
    expect(client.split).toHaveBeenNthCalledWith(1, "pane-1", "right", "/work/alpha", {});
    expect(client.split).toHaveBeenNthCalledWith(2, "pane-2", "down", "/work/alpha", {});
  });

  it("refuses to own more than four panes", async () => {
    let nextPane = 2;
    const client = backendClient({
      layout: vi.fn(async () =>
        layout(Array.from({ length: nextPane - 1 }, (_, index) => [`pane-${index + 1}`, 100, 100])),
      ),
      split: vi.fn(async () => `pane-${nextPane++}`),
    });
    const subject = backend(client);
    for (let index = 0; index < 4; index++)
      await subject.spawn(agent(`agent-${index}`), `task ${index}`);

    await expect(subject.spawn(agent("agent-5"), "too many")).rejects.toThrow(
      "At most 4 Herdr subagent panes",
    );
    expect(client.split).toHaveBeenCalledTimes(3);
  });

  it("falls back to an adjacent split and emits one visible capability warning", async () => {
    const warning = vi.fn();
    const client = backendClient({
      layout: vi.fn(async () => {
        throw new Error("unknown command pane layout");
      }),
    });
    const subject = backend(client, warning);

    await subject.spawn(agent("a"), "one");
    await subject.spawn(agent("b"), "two");

    expect(client.split).toHaveBeenCalledWith("pane-1", "down", "/work/alpha", {});
    expect(warning).toHaveBeenCalledOnce();
    expect(warning.mock.calls[0]![0].message).toContain("adjacent fallback splits");
  });

  it("closes the tab, rather than its root pane, when startup leaves no pane", async () => {
    const client = backendClient({
      start: vi.fn(async () => {
        throw new Error("startup failed");
      }),
    });
    const onError = vi.fn();
    const subject = new HerdrBackend(
      client,
      "parent",
      "/project",
      () => ({}),
      () => [],
      vi.fn(),
      onError,
    );
    const child = agent("explorer-a");

    await expect(subject.spawn(child, "task")).rejects.toThrow("startup failed");

    expect(client.closeTab).toHaveBeenCalledWith("tab-1");
    expect(client.close).not.toHaveBeenCalled();
    expect(child.herdrPaneId).toBeUndefined();
    expect(onError).toHaveBeenCalledOnce();
  });

  it("requeries after a pane closure and closes the tab after the final pane", async () => {
    const client = backendClient({
      layout: vi
        .fn()
        .mockResolvedValueOnce(layout([["pane-1", 100, 100]]))
        .mockResolvedValueOnce(layout([["pane-2", 100, 100]])),
    });
    const subject = backend(client);
    const first = agent("a");
    const second = agent("b");
    await subject.spawn(first, "one");
    await subject.spawn(second, "two");

    await subject.shutdown(first);
    expect(client.close).toHaveBeenCalledWith("pane-1");
    expect(client.layout).toHaveBeenCalledTimes(2);

    await subject.shutdown(second);
    expect(client.closeTab).toHaveBeenCalledWith("tab-1");
  });

  it("retains pane ownership and retries when a non-missing close fails", async () => {
    const close = vi
      .fn()
      .mockRejectedValueOnce(new Error("control plane temporarily unavailable"))
      .mockResolvedValueOnce(undefined);
    const client = backendClient({ close });
    const subject = backend(client);
    const first = agent("a");
    const second = agent("b");
    await subject.spawn(first, "one");
    await subject.spawn(second, "two");

    await expect(subject.shutdown(first)).rejects.toThrow("temporarily unavailable");
    expect(first.herdrPaneId).toBe("pane-1");
    await expect(subject.shutdown(first)).resolves.toBeUndefined();
    expect(first.herdrPaneId).toBeUndefined();
    expect(close).toHaveBeenCalledTimes(2);
  });

  it("releases an externally deleted pane without retrying its watcher forever", async () => {
    vi.useFakeTimers();
    try {
      const wait = vi.fn(async () => {
        throw new Error("pane_not_found: pane-1");
      });
      const createTab = vi
        .fn()
        .mockResolvedValueOnce({ tabId: "tab-1", paneId: "pane-1" })
        .mockResolvedValueOnce({ tabId: "tab-2", paneId: "pane-2" });
      const client = backendClient({ createTab, wait });
      const subject = backend(client);
      const first = agent("a");
      await subject.spawn(first, "one");
      await vi.advanceTimersByTimeAsync(5_000);

      expect(wait).toHaveBeenCalledOnce();
      expect(first.herdrPaneId).toBeUndefined();
      await subject.spawn(agent("b"), "two");
      expect(createTab).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("Herdr pane metadata", () => {
  it("uses the first meaningful sanitized line and display-width bounds it", () => {
    const prompt = `\n\t\x1b[31m  Inspect\u0000   the API  \x1b[0m\n${"do not leak ".repeat(20)}`;
    expect(taskPaneTitle(prompt)).toBe("Inspect the API");
    expect(boundedDisplayText("界".repeat(30), 48)).toBe(`${"界".repeat(23)}…`);
  });

  it("reports role/model metadata with monotonically increasing sequence numbers", async () => {
    const reportMetadata = vi.fn(async (_pane: string, _metadata: HerdrPaneMetadata) => {});
    const client = backendClient({ reportMetadata });
    const subject = backend(client);
    const child = agent("internal-agent", "initial");
    await subject.spawn(child, child.task);
    child.task = "\n next task\nfull prompt must not appear";
    await subject.updateMetadata(child);

    expect(reportMetadata).toHaveBeenCalledTimes(2);
    expect(reportMetadata.mock.calls[0]![1]).toMatchObject({
      agent: "internal-agent",
      title: "Explorer · initial",
      displayRole: "Explorer",
      stateLabels: {
        working: "investigating",
        blocked: "blocked",
        idle: "ready",
        done: "ready",
      },
      tokens: { role: "Explorer", model: "provider/a-model-with-a-name" },
      seq: 1,
    });
    expect(reportMetadata.mock.calls[1]![1]).toMatchObject({
      title: "Explorer · next task",
      seq: 2,
    });
    expect(JSON.stringify(reportMetadata.mock.calls[1]![1])).not.toContain("full prompt");
  });

  it("treats unsupported display metadata as a visible best-effort capability", async () => {
    const warning = vi.fn();
    const prompt = vi.fn(async () => {});
    const client = backendClient({
      reportMetadata: vi.fn(async () => {
        throw new Error("unknown command report-metadata");
      }),
      prompt,
    });
    const subject = backend(client, warning);

    await expect(subject.spawn(agent("a"), "inspect")).resolves.toBeUndefined();
    expect(prompt).toHaveBeenCalledWith("pane-1", "inspect");
    expect(warning).toHaveBeenCalledOnce();
  });

  it("focuses by canonical pane id, not display role or task title", async () => {
    const client = backendClient();
    const subject = backend(client);
    const child = agent("internal-agent", "human title");
    await subject.spawn(child, child.task);

    await subject.focus(child);

    expect(client.focus).toHaveBeenCalledWith("pane-1");
  });
});
