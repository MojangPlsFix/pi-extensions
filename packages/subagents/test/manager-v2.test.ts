import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { events, type SubagentsStatusEvent } from "../../../shared/events.js";
import { BUILTIN_PROFILES } from "../agents.js";
import { selectEffectiveCapabilities } from "../capabilities.js";
import { DEFAULT_SUBAGENT_CONFIG, type SubagentConfig } from "../config.js";
import type { HerdrInspectorManager } from "../herdr-inspector.js";
import { SubagentManager } from "../manager.js";
import type {
  NativeBackend,
  NativeRunEvent,
  NativeRunListener,
  NativeRunSpec,
} from "../native-backend.js";
import { type AgentDefinition, emptyUsage } from "../types.js";

const temporary: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

class FakeNativeBackend {
  readonly starts: NativeRunSpec[] = [];
  readonly listeners = new Map<string, NativeRunListener>();
  readonly aborted: string[] = [];
  readonly parked: string[] = [];
  readonly steered: Array<{ id: string; message: string }> = [];

  async start(spec: NativeRunSpec, listener: NativeRunListener): Promise<void> {
    this.starts.push(spec);
    this.listeners.set(spec.id, listener);
    listener({ type: "accepted", sessionFile: join(spec.sessionDir, `${spec.id}.jsonl`) });
  }

  emit(id: string, event: NativeRunEvent): void {
    this.listeners.get(id)?.(event);
  }

  async steer(id: string, message: string): Promise<void> {
    this.steered.push({ id, message });
  }
  async followUp(id: string, message: string): Promise<void> {
    this.steered.push({ id, message });
    this.listeners.get(id)?.({ type: "accepted", sessionFile: `${id}.jsonl` });
    this.listeners.get(id)?.({ type: "settled", report: message });
  }
  async abort(id: string): Promise<void> {
    this.aborted.push(id);
  }
  async park(id: string): Promise<void> {
    this.parked.push(id);
    this.listeners.delete(id);
  }
  async shutdown(): Promise<void> {}
}

function config(): SubagentConfig {
  return structuredClone(DEFAULT_SUBAGENT_CONFIG);
}

async function cleanRepository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "subagent-manager-repo-"));
  temporary.push(root);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
  git("init", "-q");
  git("config", "user.name", "Hackler Test");
  git("config", "user.email", "hackler@example.invalid");
  await writeFile(join(root, "file.txt"), "base\n");
  git("add", "file.txt");
  git("commit", "-q", "-m", "base");
  return root;
}

function boundedTask(key: string, agent = "scout", owns = `topic:${key}`) {
  return {
    key,
    agent,
    task: `Inspect ${key}.`,
    owns: [owns],
    deliverable: `${key} report.`,
    acceptance: `${key} is verified.`,
    stopConditions: ["Stop on completion or report a blocker."],
  };
}

function harness(
  sessionRoot: string,
  options: {
    config?: SubagentConfig;
    profiles?: AgentDefinition[];
    inspectors?: {
      open: (...args: unknown[]) => Promise<unknown>;
      close: (runId: string) => Promise<void>;
      shutdown: () => Promise<void>;
    };
  } = {},
) {
  const bus = new Map<string, Array<(data: unknown) => void>>();
  const sent: unknown[] = [];
  const emitted: Array<{ name: string; data: unknown }> = [];
  const entries: Array<{ customType: string; data: unknown }> = [];
  const notifications: Array<{ message: string; level: string }> = [];
  const sentMessages: Array<{
    message: unknown;
    options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" };
  }> = [];
  const pi = {
    events: {
      on(name: string, listener: (data: unknown) => void) {
        bus.set(name, [...(bus.get(name) ?? []), listener]);
        return () =>
          bus.set(
            name,
            (bus.get(name) ?? []).filter((entry) => entry !== listener),
          );
      },
      emit(name: string, data: unknown) {
        emitted.push({ name, data });
        for (const listener of bus.get(name) ?? []) listener(data);
        if (name === events.continuationEnqueue)
          (
            data as {
              requestId?: string;
              respond?: (result: { accepted: boolean; requestId?: string }) => void;
            }
          ).respond?.({
            accepted: true,
            requestId: (data as { requestId?: string }).requestId,
          });
      },
    },
    sendMessage(
      message: unknown,
      options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
    ) {
      sent.push(message);
      sentMessages.push({ message, options });
    },
    appendEntry(customType: string, data: unknown) {
      entries.push({ customType, data });
    },
  } as unknown as ExtensionAPI;
  const native = new FakeNativeBackend();
  const manager = new SubagentManager(pi, {
    native: native as unknown as NativeBackend,
    inspectors: options.inspectors as unknown as HerdrInspectorManager,
    loadConfig: async () => structuredClone(options.config ?? config()),
    discoverProfiles: async () => ({
      profiles: (options.profiles ?? BUILTIN_PROFILES).map((profile) => structuredClone(profile)),
      diagnostics: [],
    }),
    sessionRoot,
  });
  let sessionId = "parent-session";
  const ctx = {
    cwd: process.cwd(),
    model: undefined,
    thinkingLevel: "low",
    ui: {
      theme: { name: "dark" },
      notify(message: string, level: string) {
        notifications.push({ message, level });
      },
    },
    modelRegistry: {
      refresh: vi.fn(),
      find: vi.fn(),
      getAll: vi.fn(() => []),
      getApiKeyAndHeaders: vi.fn(),
    },
    sessionManager: {
      getSessionId: () => sessionId,
      getSessionFile: () => join(sessionRoot, `${sessionId}.jsonl`),
      buildSessionContext: () => ({ messages: [] }),
    },
    isProjectTrusted: () => false,
  } as unknown as ExtensionContext;
  return {
    manager,
    native,
    ctx,
    sent,
    sentMessages,
    emitted,
    entries,
    notifications,
    setSessionId(id: string) {
      sessionId = id;
    },
    emit(name: string, data: unknown) {
      pi.events.emit(name, data);
    },
  };
}

describe("SubagentManager v2", () => {
  it("dispatches disjoint native sessions and auto-parks completed runs", async () => {
    const root = await mkdtemp(join(tmpdir(), "subagent-manager-"));
    temporary.push(root);
    const subject = harness(root);

    const runs = await subject.manager.dispatch(
      [
        {
          key: "map-auth",
          agent: "scout",
          task: "Map authentication.",
          owns: ["path:src/auth"],
          deliverable: "Architecture report.",
          acceptance: "The authentication map is complete.",
          stopConditions: ["Stop on completion or report a blocker."],
        },
        {
          key: "review-tests",
          agent: "reviewer",
          task: "Review authentication tests.",
          owns: ["path:test/auth"],
          deliverable: "Review findings.",
          acceptance: "The findings are evidence-backed and complete.",
          stopConditions: ["Stop on completion or report a blocker."],
        },
      ],
      subject.ctx,
    );

    expect(subject.native.starts).toHaveLength(2);
    expect(runs.map((run) => run.status)).toEqual(["running", "running"]);
    expect(subject.native.starts[0]?.task).toContain("Owned scope: path:src/auth");
    expect(subject.native.starts[0]?.customTools?.map((tool) => tool.name)).toContain(
      "contact_supervisor",
    );
    expect(subject.manager.guardParentTool("edit", { path: "src/auth/handler.ts" })).toMatchObject({
      block: true,
    });
    expect(subject.manager.guardParentTool("edit", { path: "src/unowned.ts" })).toBeUndefined();

    subject.native.emit(runs[0]!.id, { type: "settled", report: "Auth mapped." });
    await vi.waitFor(() => expect(subject.manager.store.get(runs[0]!.id)?.status).toBe("parked"));
    expect(subject.native.parked).toContain(runs[0]!.id);
    expect(subject.manager.claims.forRun(runs[0]!.id)).toBeUndefined();

    await subject.manager.shutdown();
    expect(subject.native.aborted).toContain(runs[1]!.id);
    expect(subject.manager.store.get(runs[1]!.id)?.status).toBe("parked");
  });

  it("projects only safe foreground activity with current and distinct previous tools", async () => {
    const root = await mkdtemp(join(tmpdir(), "subagent-manager-activity-"));
    temporary.push(root);
    const subject = harness(root);
    const [run] = await subject.manager.dispatch([boundedTask("api-contract-review")], subject.ctx);

    subject.native.emit(run!.id, { type: "tool_start", toolName: "grep" });
    subject.native.emit(run!.id, { type: "tool_end", toolName: "grep", isError: false });
    subject.native.emit(run!.id, { type: "tool_start", toolName: "read" });

    const status = [...subject.emitted]
      .reverse()
      .find((event) => event.name === events.subagentsStatus)?.data as SubagentsStatusEvent;
    expect(status).toMatchObject({ active: 1, foreground: 1, history: 0 });
    expect(status.agents).toEqual([
      expect.objectContaining({
        id: run!.id,
        taskKey: "api-contract-review",
        currentTool: "read",
        lastAction: "grep finished",
        group: "Active",
      }),
    ]);
    expect(status.agents[0]).not.toHaveProperty("task");
    expect(status.agents[0]).not.toHaveProperty("profileClass");
    expect(status.agents[0]).not.toHaveProperty("effectiveModel");
    expect(status.agents[0]).not.toHaveProperty("leaseHistory");
    expect(status.agents[0]).not.toHaveProperty("turns");
    expect(status.agents[0]).not.toHaveProperty("report");

    await subject.manager.shutdown();
  });

  it("redacts steering guidance from projected activity", async () => {
    const root = await mkdtemp(join(tmpdir(), "subagent-manager-steer-activity-"));
    temporary.push(root);
    const subject = harness(root);
    const [run] = await subject.manager.dispatch([boundedTask("safe-steering")], subject.ctx);

    await subject.manager.steer(run!.id, "FORBIDDEN follow-up instruction");

    const status = [...subject.emitted]
      .reverse()
      .find((event) => event.name === events.subagentsStatus)?.data as SubagentsStatusEvent;
    expect(status.agents[0]?.lastAction).toBe("steering guidance sent");
    expect(JSON.stringify(status)).not.toContain("FORBIDDEN");
    await subject.manager.shutdown();
  });

  it("omits hidden runs from the live projection", async () => {
    const root = await mkdtemp(join(tmpdir(), "subagent-manager-hidden-"));
    temporary.push(root);
    const subject = harness(root);
    await subject.manager.dispatch(
      [boundedTask("hidden-plan-review", "plan-reviewer")],
      subject.ctx,
    );

    const status = [...subject.emitted]
      .reverse()
      .find((event) => event.name === events.subagentsStatus)?.data as SubagentsStatusEvent;
    expect(status).toMatchObject({ active: 0, foreground: 0, history: 0, agents: [] });
    await subject.manager.shutdown();
  });

  it("queues one aggregate continuation without a direct top-level send once a batch parks", async () => {
    const root = await mkdtemp(join(tmpdir(), "subagent-manager-"));
    temporary.push(root);
    const subject = harness(root);
    const [run] = await subject.manager.dispatch(
      [
        {
          key: "wake-parent",
          agent: "scout",
          task: "Inspect parked completion wake-up.",
          owns: ["topic:parent-wakeup"],
          deliverable: "Completion wake-up report.",
          acceptance: "The completion behavior is verified.",
          stopConditions: ["Stop on completion or report a blocker."],
        },
      ],
      subject.ctx,
    );

    subject.native.emit(run!.id, { type: "settled", report: "Wake-up report." });

    await vi.waitFor(() => expect(subject.manager.store.get(run!.id)?.status).toBe("parked"));
    await vi.waitFor(() =>
      expect(
        subject.emitted.filter((event) => event.name === events.continuationEnqueue),
      ).toHaveLength(1),
    );

    expect(subject.sentMessages).toEqual([]);
    const completion = subject.emitted.find((event) => event.name === events.continuationEnqueue)
      ?.data as { message?: { customType?: string; content?: string; details?: unknown } };
    expect(completion.message).toMatchObject({
      customType: "subagent-completion-v3",
      content: expect.stringContaining("scout · parked"),
      details: {
        schemaVersion: 3,
        runs: [expect.objectContaining({ id: run!.id, status: "parked" })],
      },
    });
    expect(completion.message?.content).toContain("Wake-up report.");

    await subject.manager.shutdown();
  });

  it("forwards cwd and active theme name when opening a transcript inspector", async () => {
    const root = await mkdtemp(join(tmpdir(), "subagent-manager-"));
    temporary.push(root);
    const configWithInspector = config();
    configWithInspector.herdr.enabled = true;
    const inspectors = {
      open: vi.fn(async () => ({
        runId: "run-id",
        paneId: "pane-id",
        sessionFile: "session.jsonl",
        openedAt: new Date().toISOString(),
      })),
      close: vi.fn(async () => {}),
      shutdown: vi.fn(async () => {}),
    };
    const subject = harness(root, { config: configWithInspector, inspectors });
    subject.ctx.cwd = "/tmp/inspector-cwd";
    (subject.ctx as unknown as { ui: { theme: { name: string } } }).ui.theme.name = "light";

    const [run] = await subject.manager.dispatch(
      [
        {
          key: "open-inspector",
          agent: "scout",
          task: "Inspect transcript view wiring.",
          owns: ["topic:inspector"],
          deliverable: "Inspector wiring report.",
          acceptance: "The inspector wiring is verified.",
          stopConditions: ["Stop on completion or report a blocker."],
        },
      ],
      subject.ctx,
    );

    await subject.manager.openInspector(run!.id);

    expect(inspectors.open).toHaveBeenCalledWith(
      run!.id,
      expect.stringContaining(`${run!.id}.jsonl`),
      "/tmp/inspector-cwd",
      expect.objectContaining({ themeName: "light" }),
    );

    await subject.manager.shutdown();
  });

  it("returns child usage deltas once for parent-session accounting", async () => {
    const root = await mkdtemp(join(tmpdir(), "subagent-manager-"));
    temporary.push(root);
    const subject = harness(root);
    const [run] = await subject.manager.dispatch(
      [
        {
          key: "account-usage",
          agent: "scout",
          task: "Inspect usage accounting.",
          owns: ["topic:usage-accounting"],
          deliverable: "Usage accounting report.",
          acceptance: "Usage accounting is verified.",
          stopConditions: ["Stop on completion or report a blocker."],
        },
      ],
      subject.ctx,
    );

    subject.native.emit(run!.id, {
      type: "usage",
      input: 100,
      output: 25,
      cacheRead: 10,
      cacheWrite: 5,
      cost: 0.033,
    });
    expect(subject.manager.takeUnreportedUsage([run!.id])).toEqual({
      input: 100,
      output: 25,
      cacheRead: 10,
      cacheWrite: 5,
      total: 140,
      cost: 0.033,
    });
    expect(subject.manager.takeUnreportedUsage([run!.id])).toEqual(emptyUsage());

    subject.native.emit(run!.id, {
      type: "usage",
      input: 20,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0.01,
    });
    const secondDelta = subject.manager.takeUnreportedUsage([run!.id]);
    expect(secondDelta).toMatchObject({
      input: 20,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      total: 25,
    });
    expect(secondDelta.cost).toBeCloseTo(0.01);
    await subject.manager.shutdown();
  });

  it("stops an active run, releases its claim, and retains its report record", async () => {
    const root = await mkdtemp(join(tmpdir(), "subagent-manager-"));
    temporary.push(root);
    const subject = harness(root);
    const [run] = await subject.manager.dispatch(
      [
        {
          key: "stop-me",
          agent: "scout",
          task: "Inspect a temporary question.",
          owns: ["topic:temporary-question"],
          deliverable: "Short report.",
          acceptance: "The requested report is complete.",
          stopConditions: ["Stop on completion or report a blocker."],
        },
      ],
      subject.ctx,
    );
    subject.native.emit(run!.id, { type: "text", delta: "Partial", text: "Partial report" });

    const stopped = await subject.manager.stop(run!.id);
    expect(stopped.status).toBe("stopped");
    expect(stopped.report).toBe("Partial report");
    expect(subject.native.aborted).toContain(run!.id);
    expect(subject.native.parked).toContain(run!.id);
    expect(subject.manager.claims.forRun(run!.id)).toBeUndefined();
    await subject.manager.shutdown();
  });

  it("keeps streamed assistant text out of activity while retaining the full report", async () => {
    const root = await mkdtemp(join(tmpdir(), "subagent-manager-"));
    temporary.push(root);
    const subject = harness(root);
    const [run] = await subject.manager.dispatch(
      [
        {
          key: "safe-activity",
          agent: "scout",
          task: "Inspect streamed activity handling.",
          owns: ["topic:activity-sanitization"],
          deliverable: "Activity sanitization report.",
          acceptance: "Activity sanitization is verified.",
          stopConditions: ["Stop on completion or report a blocker."],
        },
      ],
      subject.ctx,
    );

    subject.native.emit(run!.id, { type: "tool_start", toolName: "bash" });
    subject.native.emit(run!.id, { type: "tool_end", toolName: "bash", isError: false });
    expect(
      subject.manager.snapshots().find((candidate) => candidate.id === run!.id)?.latestActivity,
    ).toBe("bash finished");

    const firstText = "I'm beginning to feel like a Rap God, Rap God.";
    const fullReport = `${firstText} This complete answer stays in the report.`;
    subject.native.emit(run!.id, { type: "text", delta: firstText, text: firstText });
    subject.native.emit(run!.id, {
      type: "text",
      delta: " This complete answer stays in the report.",
      text: fullReport,
    });

    const snapshot = subject.manager.snapshots().find((candidate) => candidate.id === run!.id);
    expect(snapshot?.report).toBe(fullReport);
    expect(snapshot?.latestActivity).toBe("writing response");
    expect(snapshot?.activity.map((entry) => entry.text).join("\n")).not.toContain("Rap God");
    expect(snapshot?.activity.filter((entry) => entry.text === "writing response")).toHaveLength(1);

    await subject.manager.shutdown();
  });

  it("passes explicitly requested filtered context from SessionManager entries", async () => {
    const root = await mkdtemp(join(tmpdir(), "subagent-manager-"));
    temporary.push(root);
    const subject = harness(root);
    const sessionManager = {
      ...(subject.ctx.sessionManager as unknown as Record<string, unknown>),
      buildSessionContext: undefined,
      buildContextEntries: () => [
        {
          type: "message",
          message: { role: "user", content: [{ type: "text", text: "Decision: use JSONL." }] },
        },
      ],
    };
    const context = { ...subject.ctx, sessionManager } as unknown as ExtensionContext;
    await subject.manager.dispatch(
      [
        {
          key: "map-context",
          agent: "scout",
          task: "Inspect transport.",
          owns: ["topic:transport"],
          deliverable: "Transport report.",
          acceptance: "The transport behavior is verified.",
          stopConditions: ["Stop on completion or report a blocker."],
          context: "decisions",
        },
      ],
      context,
    );
    expect(subject.native.starts[0]?.task).toContain("Decision: use JSONL.");
    await subject.manager.shutdown();
  });

  it("parks, persists, and restores runs across parent session switches", async () => {
    const root = await mkdtemp(join(tmpdir(), "subagent-manager-"));
    temporary.push(root);
    const subject = harness(root);
    const [run] = await subject.manager.dispatch(
      [
        {
          key: "map-auth",
          agent: "scout",
          task: "Map authentication.",
          owns: ["path:src/auth"],
          deliverable: "Architecture report.",
          acceptance: "The authentication map is complete.",
          stopConditions: ["Stop on completion or report a blocker."],
        },
      ],
      subject.ctx,
    );
    expect(run).toBeDefined();

    subject.setSessionId("second-parent");
    await subject.manager.status(subject.ctx);
    expect(subject.native.aborted).toContain(run!.id);
    expect(subject.manager.snapshots()).toEqual([]);

    subject.setSessionId("parent-session");
    await subject.manager.status(subject.ctx);
    expect(subject.manager.store.get(run!.id)?.status).toBe("parked");
    await subject.manager.shutdown();
  });

  it("clears stale persisted tool activity before revival", async () => {
    const root = await mkdtemp(join(tmpdir(), "subagent-manager-stale-tool-"));
    temporary.push(root);
    const subject = harness(root);
    const [run] = await subject.manager.dispatch([boundedTask("stale-tool")], subject.ctx);
    subject.native.emit(run!.id, { type: "tool_start", toolName: "read" });

    subject.setSessionId("second-parent");
    await subject.manager.status(subject.ctx);
    const statePath = join(root, "parent-session", "runs.json");
    const persisted = JSON.parse(await readFile(statePath, "utf8")) as {
      runs: Array<Record<string, unknown>>;
    };
    const persistedRun = persisted.runs.find((candidate) => candidate.id === run!.id)!;
    persistedRun.currentTool = "read";
    persistedRun.currentOperation = {
      kind: "tool",
      name: "read",
      startedAt: new Date().toISOString(),
      generation: 1,
    };
    await writeFile(statePath, `${JSON.stringify(persisted, null, 2)}\n`);

    subject.setSessionId("parent-session");
    await subject.manager.status(subject.ctx);
    const restored = subject.manager.store.get(run!.id)!;
    expect(restored).toMatchObject({ status: "parked" });
    expect(restored.currentTool).toBeUndefined();
    expect(restored.currentOperation).toBeUndefined();

    await subject.manager.steer(run!.id, "Continue without stale tool state.");
    expect(restored.currentTool).toBeUndefined();
    await subject.manager.shutdown();
  });

  it("parks legacy active records with unknown limits and rejects revival", async () => {
    const root = await mkdtemp(join(tmpdir(), "subagent-manager-"));
    temporary.push(root);
    const subject = harness(root);
    const [run] = await subject.manager.dispatch([boundedTask("legacy-active")], subject.ctx);
    await subject.manager.shutdown();

    const statePath = join(root, "parent-session", "runs.json");
    const persisted = JSON.parse(await readFile(statePath, "utf8")) as {
      runs: Array<Record<string, unknown>>;
    };
    const legacy = persisted.runs.find((candidate) => candidate.id === run!.id)!;
    legacy.status = "running";
    delete legacy.finishedAt;
    delete legacy.originalEffectiveLimits;
    delete legacy.leaseHistory;
    delete legacy.activeLeaseGeneration;
    delete legacy.statusChangedAt;
    delete legacy.statusTransitions;
    delete legacy.lastEventAt;
    delete legacy.currentOperation;
    delete legacy.terminationReason;
    delete legacy.terminationHistory;
    delete legacy.wrappingUp;
    delete legacy.blockedSince;
    await writeFile(statePath, `${JSON.stringify(persisted, null, 2)}\n`);

    const restored = harness(root);
    await restored.manager.status(restored.ctx);
    const legacyRun = restored.manager.store.get(run!.id)!;
    expect(legacyRun.status).toBe("parked");
    expect(legacyRun.terminationReason?.code).toBe("legacy_unknown");
    await expect(restored.manager.steer(run!.id, "Continue the legacy run.")).rejects.toThrow(
      /no trustworthy captured limits/,
    );
    expect(restored.manager.claims.forRun(run!.id)).toBeUndefined();
    await restored.manager.shutdown();
  });

  it("recreates an actionable run-candidate handoff after shutdown and restore", async () => {
    const root = await mkdtemp(join(tmpdir(), "subagent-manager-"));
    temporary.push(root);
    const repository = await cleanRepository();
    const subject = harness(root);
    subject.ctx.cwd = repository;
    const [run] = await subject.manager.dispatch(
      [
        {
          ...boundedTask("restore-run-candidate", "worker", "path:file.txt"),
          workspace: "worktree",
        },
      ],
      subject.ctx,
    );
    expect(run!.worktree).toBeDefined();
    await writeFile(join(run!.worktree!.cwd, "file.txt"), "run candidate\n");
    subject.native.emit(run!.id, { type: "settled", report: "Candidate ready." });
    await vi.waitFor(() => expect(run!.status).toBe("parked"));
    const originalRequest = subject.manager.pendingRequests()[0];
    expect(originalRequest?.kind).toBe("integration-ready");
    await subject.manager.shutdown();

    const restored = harness(root);
    restored.ctx.cwd = repository;
    await restored.manager.status(restored.ctx);
    const request = restored.manager.pendingRequests()[0];
    expect(request).toMatchObject({ kind: "integration-ready", fromRunId: run!.id });
    expect(request!.id).not.toBe(originalRequest!.id);
    const latestActivity = restored.emitted
      .filter((event) => event.name === events.hacklerActivity)
      .at(-1)?.data as { integrating?: number } | undefined;
    expect(latestActivity?.integrating ?? 0).toBeGreaterThan(0);
    await restored.manager.respondRequest(request!.id, "integrate");
    expect(await readFile(join(repository, "file.txt"), "utf8")).toBe("run candidate\n");
    expect(
      restored.emitted.some(
        (event) =>
          event.name === events.implementationWaveAdvance &&
          (event.data as { reason?: string }).reason?.includes(run!.id),
      ),
    ).toBe(true);
    await restored.manager.shutdown();
  });

  it("retains invalid partial worktree metadata after restore", async () => {
    const root = await mkdtemp(join(tmpdir(), "subagent-manager-"));
    temporary.push(root);
    const repository = await cleanRepository();
    const subject = harness(root);
    subject.ctx.cwd = repository;
    const [run] = await subject.manager.dispatch(
      [
        {
          ...boundedTask("restore-partial-worktree", "worker", "path:file.txt"),
          workspace: "worktree",
        },
      ],
      subject.ctx,
    );
    const worktree = { ...run!.worktree! };
    await subject.manager.shutdown();
    execFileSync("git", ["worktree", "remove", "--force", worktree.root], {
      cwd: repository,
      stdio: "ignore",
    });

    const partialBase = await mkdtemp(join(tmpdir(), "subagent-partial-worktree-"));
    temporary.push(partialBase);
    const partialRoot = join(partialBase, "pi-mission-retained-partial");
    await mkdir(partialRoot);
    await writeFile(join(partialRoot, "sentinel.txt"), "retain\n");
    const statePath = join(root, "parent-session", "runs.json");
    const persisted = JSON.parse(await readFile(statePath, "utf8")) as {
      runs: Array<{ id: string; finishedAt?: string; worktree?: typeof worktree }>;
    };
    const persistedRun = persisted.runs.find((candidate) => candidate.id === run!.id)!;
    persistedRun.finishedAt = "2020-01-01T00:00:00.000Z";
    persistedRun.worktree = { ...worktree, root: partialRoot, cwd: partialRoot };
    await writeFile(statePath, `${JSON.stringify(persisted, null, 2)}\n`);

    const restored = harness(root);
    restored.ctx.cwd = repository;
    const hub = await restored.manager.status(restored.ctx);
    const restoredRun = restored.manager.store.get(run!.id);
    expect(restoredRun).toMatchObject({
      status: "failed",
      worktree: { root: partialRoot },
      cleanupFailure: { message: expect.stringMatching(/Safe cleanup cannot be proven/) },
    });
    expect(hub.diagnostics.some((entry) => entry.message.includes("no longer registered"))).toBe(
      true,
    );
    expect(await readFile(join(partialRoot, "sentinel.txt"), "utf8")).toBe("retain\n");
    await restored.manager.shutdown();
  });

  it("recreates an actionable mission-candidate handoff after shutdown and restore", async () => {
    const root = await mkdtemp(join(tmpdir(), "subagent-manager-"));
    temporary.push(root);
    const repository = await cleanRepository();
    const subject = harness(root);
    subject.ctx.cwd = repository;
    const mission = await subject.manager.startMission(
      "Prepare the mission candidate.",
      ["path:file.txt"],
      subject.ctx,
      "worktree",
    );
    expect(mission.worktree).toBeDefined();
    await writeFile(join(mission.worktree!.cwd, "file.txt"), "mission candidate\n");
    subject.native.emit(mission.orchestratorId, {
      type: "settled",
      report: "Mission candidate ready.",
    });
    await vi.waitFor(() => expect(subject.manager.missionSnapshots()[0]?.status).toBe("parked"));
    const originalRequest = subject.manager.pendingRequests()[0];
    expect(originalRequest?.kind).toBe("integration-ready");
    await subject.manager.shutdown();

    const restored = harness(root);
    restored.ctx.cwd = repository;
    await restored.manager.status(restored.ctx);
    const request = restored.manager.pendingRequests()[0];
    expect(request).toMatchObject({ kind: "integration-ready", missionId: mission.id });
    expect(request!.id).not.toBe(originalRequest!.id);
    await restored.manager.respondRequest(request!.id, "integrate");
    expect(await readFile(join(repository, "file.txt"), "utf8")).toBe("mission candidate\n");
    expect(
      restored.emitted.some(
        (event) =>
          event.name === events.implementationWaveAdvance &&
          (event.data as { reason?: string }).reason?.includes(mission.id),
      ),
    ).toBe(true);
    await restored.manager.shutdown();
  });

  it("keeps the orchestrator lease open through child settlement and candidate capture", async () => {
    const root = await mkdtemp(join(tmpdir(), "subagent-manager-"));
    temporary.push(root);
    const repository = await cleanRepository();
    const subject = harness(root);
    subject.ctx.cwd = repository;
    const mission = await subject.manager.startMission(
      "Coordinate a bounded mission candidate.",
      ["path:file.txt"],
      subject.ctx,
      "worktree",
    );
    const orchestrator = subject.manager.store.get(mission.orchestratorId)!;
    const orchestratorTools = subject.native.starts.find(
      (start) => start.id === orchestrator.id,
    )?.customTools;
    const statusTool = orchestratorTools?.find((tool) => tool.name === "subagent_status");
    const dispatchTool = orchestratorTools?.find((tool) => tool.name === "subagent_dispatch");
    expect(statusTool).toBeDefined();
    const statusResult = await statusTool!.execute(
      "child-status",
      {},
      new AbortController().signal,
      () => {},
      {} as never,
    );
    expect(statusResult.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("Capacity: slots 1/4 used · 3 free · shared writers 0/1"),
    });
    expect(dispatchTool).toBeDefined();
    await dispatchTool!.execute(
      "child-dispatch",
      {
        tasks: [
          {
            ...boundedTask("mission-child", "worker", "path:file.txt"),
            task: "Write the bounded mission candidate.",
          },
        ],
      },
      new AbortController().signal,
      () => {},
      {} as never,
    );
    const child = subject.manager.store.children(orchestrator.id)[0]!;
    await writeFile(join(mission.worktree!.cwd, "file.txt"), "mission child candidate\n");

    subject.native.emit(orchestrator.id, { type: "settled", report: "Child dispatched." });
    expect(subject.native.parked).not.toContain(orchestrator.id);
    expect(orchestrator.status).toBe("running");
    expect(orchestrator.activeLeaseGeneration).toBe(1);
    expect(subject.manager.missionSnapshots()[0]?.status).toBe("running");

    subject.native.emit(child.id, { type: "settled", report: "Child patch complete." });
    await vi.waitFor(() => expect(orchestrator.status).toBe("parked"));
    await vi.waitFor(() => expect(subject.manager.missionSnapshots()[0]?.status).toBe("parked"));
    expect(subject.manager.missionSnapshots()[0]?.candidate).toMatchObject({
      files: ["file.txt"],
      hasChanges: true,
    });
    await expect(
      subject.manager.steer(child.id, "Mutate after candidate capture."),
    ).rejects.toThrow(/already produced or disposed its integration candidate/);
    expect(subject.manager.claims.forRun(child.id)).toBeUndefined();
    const request = subject.manager
      .pendingRequests()
      .find((candidate) => candidate.missionId === mission.id);
    expect(request?.kind).toBe("integration-ready");
    await subject.manager.respondRequest(request!.id, "integrate");
    expect(await readFile(join(repository, "file.txt"), "utf8")).toBe("mission child candidate\n");
    await subject.manager.shutdown();
  });

  it("waits for terminal child cleanup before capturing a mission candidate", async () => {
    const root = await mkdtemp(join(tmpdir(), "subagent-manager-"));
    temporary.push(root);
    const repository = await cleanRepository();
    const subject = harness(root);
    subject.ctx.cwd = repository;
    const mission = await subject.manager.startMission(
      "Wait for child cleanup before capture.",
      ["path:file.txt"],
      subject.ctx,
      "worktree",
    );
    const orchestrator = subject.manager.store.get(mission.orchestratorId)!;
    const dispatchTool = subject.native.starts
      .find((start) => start.id === orchestrator.id)
      ?.customTools?.find((tool) => tool.name === "subagent_dispatch");
    await dispatchTool!.execute(
      "cleanup-child-dispatch",
      {
        tasks: [
          {
            ...boundedTask("cleanup-child", "worker", "path:file.txt"),
            task: "Prepare a candidate until cleanup completes.",
          },
        ],
      },
      new AbortController().signal,
      () => {},
      {} as never,
    );
    const child = subject.manager.store.children(orchestrator.id)[0]!;
    let releaseCleanup!: () => void;
    const cleanupPending = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    const originalPark = subject.native.park.bind(subject.native);
    vi.spyOn(subject.native, "park").mockImplementation(async (id) => {
      if (id !== child.id) return originalPark(id);
      subject.native.parked.push(id);
      await cleanupPending;
      subject.native.listeners.delete(id);
    });

    subject.native.emit(orchestrator.id, { type: "settled", report: "Child is finishing." });
    expect(subject.native.parked).not.toContain(orchestrator.id);
    const stopping = subject.manager.stop(child.id);
    await vi.waitFor(() => expect(child.status).toBe("stopped"));
    await writeFile(join(mission.worktree!.cwd, "file.txt"), "late cleanup mutation\n");
    expect(orchestrator.status).toBe("running");
    expect(subject.manager.missionSnapshots()[0]?.candidate).toBeUndefined();
    expect(
      subject.manager.pendingRequests().some((request) => request.missionId === mission.id),
    ).toBe(false);

    releaseCleanup();
    await stopping;
    await vi.waitFor(() => expect(orchestrator.status).toBe("parked"));
    await vi.waitFor(() => expect(subject.manager.missionSnapshots()[0]?.status).toBe("parked"));
    expect(subject.manager.missionSnapshots()[0]?.candidate).toMatchObject({
      files: ["file.txt"],
      hasChanges: true,
    });
    const request = subject.manager
      .pendingRequests()
      .find((candidate) => candidate.missionId === mission.id);
    await subject.manager.respondRequest(request!.id, "integrate");
    expect(await readFile(join(repository, "file.txt"), "utf8")).toBe("late cleanup mutation\n");
    await subject.manager.shutdown();
  });

  it("retains a mission worktree when terminal child cleanup cannot be proven", async () => {
    const root = await mkdtemp(join(tmpdir(), "subagent-manager-"));
    temporary.push(root);
    const repository = await cleanRepository();
    const subject = harness(root);
    subject.ctx.cwd = repository;
    const mission = await subject.manager.startMission(
      "Retain the candidate after unsafe cleanup.",
      ["path:file.txt"],
      subject.ctx,
      "worktree",
    );
    const orchestrator = subject.manager.store.get(mission.orchestratorId)!;
    const dispatchTool = subject.native.starts
      .find((start) => start.id === orchestrator.id)
      ?.customTools?.find((tool) => tool.name === "subagent_dispatch");
    await dispatchTool!.execute(
      "unsafe-cleanup-dispatch",
      { tasks: [boundedTask("unsafe-cleanup-child", "worker", "path:file.txt")] },
      new AbortController().signal,
      () => {},
      {} as never,
    );
    const child = subject.manager.store.children(orchestrator.id)[0]!;
    const originalPark = subject.native.park.bind(subject.native);
    vi.spyOn(subject.native, "park").mockImplementation(async (id) => {
      if (id === child.id) throw new Error("child process group still alive");
      await originalPark(id);
    });

    subject.native.emit(orchestrator.id, { type: "settled", report: "Child is finishing." });
    await subject.manager.stop(child.id);
    await vi.waitFor(() => expect(orchestrator.status).toBe("failed"));
    await vi.waitFor(() => expect(subject.manager.missionSnapshots()[0]?.status).toBe("failed"));
    expect(child.cleanupFailure?.message).toContain("child process group still alive");
    expect(subject.manager.missionSnapshots()[0]).toMatchObject({
      status: "failed",
      worktree: { root: mission.worktree!.root },
    });
    expect(subject.manager.missionSnapshots()[0]?.candidate).toBeUndefined();
    expect(
      subject.manager
        .pendingRequests()
        .some(
          (request) => request.kind === "integration-ready" && request.missionId === mission.id,
        ),
    ).toBe(false);

    execFileSync("git", ["worktree", "remove", "--force", mission.worktree!.root], {
      cwd: repository,
      stdio: "ignore",
    });
    await subject.manager.shutdown();
  });

  it("releases claims and active capacity when a runner fails during startup", async () => {
    const root = await mkdtemp(join(tmpdir(), "subagent-manager-"));
    temporary.push(root);
    const subject = harness(root);
    vi.spyOn(subject.native, "start").mockRejectedValueOnce(new Error("startup failed"));
    await expect(
      subject.manager.dispatch(
        [
          {
            key: "startup",
            agent: "scout",
            task: "Inspect startup.",
            owns: ["topic:startup"],
            deliverable: "Startup report.",
            acceptance: "Startup behavior is verified.",
            stopConditions: ["Stop on completion or report a blocker."],
          },
        ],
        subject.ctx,
      ),
    ).rejects.toThrow("startup failed");
    expect(subject.manager.store.active()).toEqual([]);
    expect(subject.manager.claims.all()).toEqual([]);
    expect(subject.manager.snapshots()[0]?.status).toBe("failed");
    await subject.manager.shutdown();
  });

  it("cancels an in-flight startup before shutdown waits for the dispatch queue", async () => {
    const root = await mkdtemp(join(tmpdir(), "subagent-manager-"));
    temporary.push(root);
    const subject = harness(root);
    vi.spyOn(subject.native, "start").mockImplementation(async (spec) => {
      subject.native.starts.push(spec);
      await new Promise<void>((_resolve, reject) => {
        const cancel = () =>
          reject(
            spec.signal?.reason instanceof Error
              ? spec.signal.reason
              : new Error("startup cancelled"),
          );
        if (spec.signal?.aborted) cancel();
        else spec.signal?.addEventListener("abort", cancel, { once: true });
      });
    });
    const dispatch = subject.manager.dispatch(
      [
        {
          key: "slow-start",
          agent: "scout",
          task: "Wait during startup.",
          owns: ["topic:slow-start"],
          deliverable: "Startup report.",
          acceptance: "Startup cancellation is verified.",
          stopConditions: ["Stop on completion or report a blocker."],
        },
      ],
      subject.ctx,
    );
    const dispatchResult = dispatch.then(
      () => "resolved",
      () => "rejected",
    );
    await vi.waitFor(() => expect(subject.native.starts).toHaveLength(1));
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const shutdownResult = await Promise.race([
      subject.manager.shutdown().then(() => "closed"),
      new Promise<string>((resolve) => {
        timeout = setTimeout(() => resolve("timed-out"), 1_000);
      }),
    ]);
    if (timeout) clearTimeout(timeout);
    expect(shutdownResult).toBe("closed");
    expect(await dispatchResult).toBe("rejected");
    expect(subject.manager.store.active()).toEqual([]);
  });

  it("serializes concurrent dispatches before it applies the active-session ceiling", async () => {
    const root = await mkdtemp(join(tmpdir(), "subagent-manager-"));
    temporary.push(root);
    const limited = config();
    limited.runtime.maxActive = 1;
    const subject = harness(root, { config: limited });
    const dispatch = (key: string) =>
      subject.manager.dispatch(
        [
          {
            key,
            agent: "scout",
            task: `Inspect ${key}.`,
            owns: [`topic:${key}`],
            deliverable: `${key} report.`,
            acceptance: `${key} is verified.`,
            stopConditions: ["Stop on completion or report a blocker."],
          },
        ],
        subject.ctx,
      );
    const results = await Promise.allSettled([dispatch("first"), dispatch("second")]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(subject.native.starts).toHaveLength(1);
    await subject.manager.shutdown();
  });

  it("rejects duplicate ownership work before allocating a session", async () => {
    const root = await mkdtemp(join(tmpdir(), "subagent-manager-"));
    temporary.push(root);
    const subject = harness(root);

    await expect(
      subject.manager.dispatch(
        [
          {
            key: "one",
            agent: "scout",
            task: "Inspect auth flow.",
            owns: ["path:src/auth"],
            deliverable: "Report.",
            acceptance: "The requested report is complete.",
            stopConditions: ["Stop on completion or report a blocker."],
          },
          {
            key: "two",
            agent: "reviewer",
            task: "Inspect auth flow!",
            owns: ["path:src/auth"],
            deliverable: "Findings.",
            acceptance: "The findings are complete.",
            stopConditions: ["Stop on completion or report a blocker."],
          },
        ],
        subject.ctx,
      ),
    ).rejects.toThrow(/same normalized work/);
    expect(subject.native.starts).toHaveLength(0);
    await subject.manager.shutdown();
  });

  it("revives with the captured capability policy and immutable timeout", async () => {
    const root = await mkdtemp(join(tmpdir(), "subagent-manager-"));
    temporary.push(root);
    const subject = harness(root);
    const [run] = await subject.manager.dispatch(
      [
        {
          key: "write",
          agent: "worker",
          task: "Change auth.",
          owns: ["path:src/auth"],
          deliverable: "Patch.",
          acceptance: "The patch is validated.",
          stopConditions: ["Stop on completion or report a blocker."],
        },
      ],
      subject.ctx,
    );
    expect(run).toBeDefined();
    subject.native.emit(run!.id, { type: "settled", report: "Initial patch complete." });
    await vi.waitFor(() => expect(subject.manager.store.get(run!.id)?.status).toBe("parked"));
    run!.profileSnapshot.timeout = 9;
    run!.capabilityNames = ["captured"];
    run!.capabilityPolicy = selectEffectiveCapabilities(["captured"], {
      captured: {
        name: "captured",
        extensionPath: "/trusted/captured-extension.ts",
        state: "isolated",
        approval: "allow",
      },
    });
    subject.manager.claims.release(run!.id);

    await subject.manager.steer(run!.id, "Continue with the captured policy.");
    expect(subject.native.starts[1]).toMatchObject({
      cwd: subject.ctx.cwd,
      extensionPaths: ["/trusted/captured-extension.ts"],
      timeoutMs: 1_800_000,
    });
    await subject.manager.shutdown();
  });

  it("rejects a stale second revival after a concurrent revival makes the run active", async () => {
    const root = await mkdtemp(join(tmpdir(), "subagent-manager-"));
    temporary.push(root);
    const subject = harness(root);
    const [run] = await subject.manager.dispatch([boundedTask("concurrent-revival")], subject.ctx);
    subject.native.emit(run!.id, { type: "settled", report: "First lease complete." });
    await vi.waitFor(() => expect(run!.status).toBe("parked"));

    const first = subject.manager.steer(run!.id, "First revival.");
    const second = subject.manager.steer(run!.id, "Stale second revival.");
    await expect(first).resolves.toBe(run);
    await expect(second).rejects.toThrow(/Stale revival rejected/);
    expect(run!.status).toBe("running");
    expect(run!.leaseHistory).toHaveLength(2);
    expect(subject.native.starts).toHaveLength(2);
    await subject.manager.shutdown();
  });

  it("revalidates active capacity before reserving a revival claim", async () => {
    const root = await mkdtemp(join(tmpdir(), "subagent-manager-"));
    temporary.push(root);
    const limited = config();
    limited.runtime.maxActive = 1;
    const subject = harness(root, { config: limited });
    const [parked] = await subject.manager.dispatch([boundedTask("parked-capacity")], subject.ctx);
    subject.native.emit(parked!.id, { type: "settled", report: "First lease complete." });
    await vi.waitFor(() => expect(parked!.status).toBe("parked"));
    const [active] = await subject.manager.dispatch([boundedTask("active-capacity")], subject.ctx);

    await expect(
      subject.manager.steer(parked!.id, "Continue after capacity frees."),
    ).rejects.toThrow(/No active Hackler capacity/);
    expect(subject.manager.claims.forRun(parked!.id)).toBeUndefined();
    expect(subject.manager.claims.forRun(active!.id)).toBeDefined();
    expect(parked!.leaseHistory).toHaveLength(1);
    await subject.manager.shutdown();
  });

  it("revalidates writer ownership before reserving a revival claim", async () => {
    const root = await mkdtemp(join(tmpdir(), "subagent-manager-"));
    temporary.push(root);
    const subject = harness(root);
    const [parked] = await subject.manager.dispatch(
      [boundedTask("parked-writer", "worker", "path:src/shared")],
      subject.ctx,
    );
    subject.native.emit(parked!.id, { type: "settled", report: "First patch complete." });
    await vi.waitFor(() => expect(parked!.status).toBe("parked"));
    const [active] = await subject.manager.dispatch(
      [boundedTask("active-writer", "worker", "path:src/shared")],
      subject.ctx,
    );

    await expect(subject.manager.steer(parked!.id, "Continue the parked patch.")).rejects.toThrow(
      /Writer scope overlap/,
    );
    expect(subject.manager.claims.forRun(parked!.id)).toBeUndefined();
    expect(subject.manager.claims.forRun(active!.id)).toBeDefined();
    expect(parked!.leaseHistory).toHaveLength(1);
    await subject.manager.shutdown();
  });

  it("revalidates duplicate work before reserving a revival claim", async () => {
    const root = await mkdtemp(join(tmpdir(), "subagent-manager-"));
    temporary.push(root);
    const subject = harness(root);
    const [parked] = await subject.manager.dispatch([boundedTask("parked-duplicate")], subject.ctx);
    subject.native.emit(parked!.id, { type: "settled", report: "First report complete." });
    await vi.waitFor(() => expect(parked!.status).toBe("parked"));
    const duplicateMessage = "Continue the same bounded analysis.";
    const [active] = await subject.manager.dispatch(
      [
        {
          ...boundedTask("active-duplicate", "scout", "topic:other-duplicate"),
          task: duplicateMessage,
        },
      ],
      subject.ctx,
    );

    await expect(subject.manager.steer(parked!.id, duplicateMessage)).rejects.toThrow(
      /duplicates work already owned/,
    );
    expect(subject.manager.claims.forRun(parked!.id)).toBeUndefined();
    expect(subject.manager.claims.forRun(active!.id)).toBeDefined();
    expect(parked!.leaseHistory).toHaveLength(1);
    await subject.manager.shutdown();
  });

  it("does not resurrect a blocked child when shutdown cancels its request", async () => {
    const root = await mkdtemp(join(tmpdir(), "subagent-manager-"));
    temporary.push(root);
    const subject = harness(root);
    const [run] = await subject.manager.dispatch(
      [
        {
          key: "blocked",
          agent: "scout",
          task: "Inspect a decision.",
          owns: ["topic:decision"],
          deliverable: "Decision report.",
          acceptance: "The decision is reported.",
          stopConditions: ["Stop on completion or report a blocker."],
        },
      ],
      subject.ctx,
    );
    const contact = subject.native.starts[0]?.customTools?.find(
      (tool) => tool.name === "contact_supervisor",
    );
    expect(contact).toBeDefined();
    const response = contact!.execute(
      "tool-call",
      {
        kind: "decision",
        title: "Need a choice",
        detail: "The task cannot continue without a choice.",
      },
      new AbortController().signal,
      () => {},
      {} as never,
    );
    await vi.waitFor(() => expect(subject.manager.store.get(run!.id)?.status).toBe("blocked"));
    await subject.manager.shutdown();
    await response;
    expect(subject.manager.store.get(run!.id)?.status).toBe("parked");
    expect(subject.manager.evaluationTrace().requests[0]?.status).toBe("cancelled");
  });

  it("returns from collect when a child blocks so the parent can answer", async () => {
    const root = await mkdtemp(join(tmpdir(), "subagent-manager-"));
    temporary.push(root);
    const subject = harness(root);
    const [run] = await subject.manager.dispatch(
      [
        {
          key: "needs-answer",
          agent: "scout",
          task: "Inspect a decision.",
          owns: ["topic:decision"],
          deliverable: "Decision report.",
          acceptance: "The decision is reported.",
          stopConditions: ["Stop on completion or report a blocker."],
        },
      ],
      subject.ctx,
    );
    const contact = subject.native.starts[0]?.customTools?.find(
      (tool) => tool.name === "contact_supervisor",
    );
    const response = contact!.execute(
      "tool-call",
      {
        kind: "decision",
        title: "Need a choice",
        detail: "The task cannot continue without a choice.",
        choices: [{ value: "continue", label: "Continue" }],
      },
      new AbortController().signal,
      () => {},
      {} as never,
    );
    await vi.waitFor(() => expect(subject.manager.store.get(run!.id)?.status).toBe("blocked"));
    const live = [...subject.emitted]
      .reverse()
      .find((event) => event.name === events.subagentsStatus)?.data as SubagentsStatusEvent;
    expect(live.agents[0]).toMatchObject({
      group: "Attention",
      attentionReason: "Need a choice",
      lastAction: "requested Need a choice",
    });

    const collected = await subject.manager.collect([run!.id], "all");
    expect(collected.waitReason).toBe("blocked");
    expect(collected.runs[0]?.status).toBe("blocked");
    const request = subject.manager.pendingRequests()[0];
    expect(request).toMatchObject({ kind: "decision", fromRunId: run!.id });
    await subject.manager.respondRequest(request!.id, "continue");
    await response;
    await subject.manager.shutdown();
  });

  it("rejects supervisor requests created after terminalization starts", async () => {
    const root = await mkdtemp(join(tmpdir(), "subagent-manager-"));
    temporary.push(root);
    const subject = harness(root);
    const [run] = await subject.manager.dispatch([boundedTask("late-request")], subject.ctx);
    const contact = subject.native.starts[0]?.customTools?.find(
      (tool) => tool.name === "contact_supervisor",
    );
    await subject.manager.stop(run!.id);

    await expect(
      contact!.execute(
        "late-request",
        { kind: "decision", title: "Too late", detail: "This must not remain pending." },
        new AbortController().signal,
        () => {},
        {} as never,
      ),
    ).rejects.toThrow(/cannot create a supervisor request/);
    expect(subject.manager.pendingRequests()).toEqual([]);
    await subject.manager.shutdown();
  });

  it("cancels a blocking supervisor request when its child tool signal aborts", async () => {
    const root = await mkdtemp(join(tmpdir(), "subagent-manager-"));
    temporary.push(root);
    const subject = harness(root);
    const [run] = await subject.manager.dispatch([boundedTask("aborted-request")], subject.ctx);
    const contact = subject.native.starts[0]?.customTools?.find(
      (tool) => tool.name === "contact_supervisor",
    );
    const controller = new AbortController();
    const result = contact!.execute(
      "aborted-request",
      { kind: "blocker", title: "Wait", detail: "This request will be cancelled." },
      controller.signal,
      () => {},
      {} as never,
    );
    await vi.waitFor(() => expect(run!.status).toBe("blocked"));
    controller.abort(new Error("tool cancelled"));
    await expect(result).resolves.toMatchObject({ isError: true });
    expect(subject.manager.inbox.all()[0]?.status).toBe("cancelled");
    expect(run!.status).toBe("running");
    await subject.manager.shutdown();
  });

  it("does not block read-only children on integration-ready handoffs", async () => {
    const root = await mkdtemp(join(tmpdir(), "subagent-manager-"));
    temporary.push(root);
    const subject = harness(root);
    const [run] = await subject.manager.dispatch(
      [
        {
          key: "read-only-handoff",
          agent: "scout",
          task: "Inspect the report.",
          owns: ["topic:report"],
          deliverable: "Read-only report.",
          acceptance: "The read-only report is complete.",
          stopConditions: ["Stop on completion or report a blocker."],
        },
      ],
      subject.ctx,
    );
    const contact = subject.native.starts[0]?.customTools?.find(
      (tool) => tool.name === "contact_supervisor",
    );
    await contact!.execute(
      "tool-call",
      {
        kind: "integration-ready",
        title: "Report ready",
        detail: "The read-only report is ready.",
        choices: [{ value: "accepted", label: "Use report" }],
      },
      new AbortController().signal,
      () => {},
      {} as never,
    );
    expect(subject.manager.pendingRequests()).toEqual([]);
    expect(subject.manager.store.get(run!.id)?.status).toBe("running");
    await subject.manager.shutdown();
  });

  it("coalesces concurrent supervisor responses", async () => {
    const root = await mkdtemp(join(tmpdir(), "subagent-manager-"));
    temporary.push(root);
    const subject = harness(root);
    await subject.manager.attachUi(subject.ctx);
    const { request } = subject.manager.request({
      fromRunId: "manual-check",
      kind: "decision",
      title: "Choose",
      detail: "Choose one response.",
      choices: [{ value: "yes", label: "Yes" }],
    });
    const first = subject.manager.respondRequest(request.id, "yes");
    const second = subject.manager.respondRequest(request.id, "yes");
    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ status: "answered", answer: "yes" }),
      expect.objectContaining({ status: "answered", answer: "yes" }),
    ]);
    await subject.manager.shutdown();
  });

  it("requires an executable capability prefix for external profiles", async () => {
    const root = await mkdtemp(join(tmpdir(), "subagent-manager-"));
    temporary.push(root);
    const externalProfile: AgentDefinition = {
      ...structuredClone(BUILTIN_PROFILES.find((profile) => profile.name === "reviewer")!),
      name: "company-reviewer",
      runner: "external",
      source: "user",
      path: "/profiles/company-reviewer.md",
    };
    const externalConfig = config();
    externalConfig.runners[externalProfile.name] = {
      command: "company-review",
      args: ["run"],
      envAllowlist: [],
      timeoutMs: 1_000,
      maxOutputBytes: 1_024,
    };
    const subject = harness(root, {
      config: externalConfig,
      profiles: [...BUILTIN_PROFILES, externalProfile],
    });
    await expect(
      subject.manager.dispatch(
        [
          {
            key: "external",
            agent: externalProfile.name,
            task: "Review the change.",
            owns: ["topic:external-review"],
            deliverable: "Review report.",
            acceptance: "The review is complete.",
            stopConditions: ["Stop on completion or report a blocker."],
          },
        ],
        subject.ctx,
      ),
    ).rejects.toThrow(/executable argv-prefix/);
    await subject.manager.shutdown();
  });

  it("routes Plan Mode review requests through the hidden plan-reviewer profile", async () => {
    const root = await mkdtemp(join(tmpdir(), "subagent-manager-"));
    temporary.push(root);
    const subject = harness(root);
    subject.emit(events.planMode, { enabled: true });
    let accepted = false;
    const response = new Promise<{ reviewerId?: string; report?: string; error?: string }>(
      (resolve) => {
        subject.emit(events.planReview, {
          task: "Review the proposed auth plan.",
          ctx: subject.ctx,
          accept: () => {
            accepted = true;
          },
          respond: resolve,
        });
      },
    );
    await vi.waitFor(() =>
      expect(subject.native.starts.some((start) => start.id.startsWith("plan-reviewer-"))).toBe(
        true,
      ),
    );
    const reviewer = subject.native.starts.find((start) => start.id.startsWith("plan-reviewer-"))!;
    subject.native.emit(reviewer.id, { type: "settled", report: "Plan review evidence." });
    await expect(response).resolves.toMatchObject({
      reviewerId: reviewer.id,
      report: "Plan review evidence.",
    });
    expect(accepted).toBe(true);
    expect(subject.sent).toEqual([]);
    expect(subject.emitted.filter((event) => event.name === events.continuationEnqueue)).toEqual(
      [],
    );
    expect(subject.manager.batchSnapshots()[0]).toMatchObject({
      route: "silent",
      phase: "delivered",
    });
    await subject.manager.shutdown();
  });

  it("allows read work but blocks write dispatch and revival in Plan Mode", async () => {
    const root = await mkdtemp(join(tmpdir(), "subagent-manager-"));
    temporary.push(root);
    const subject = harness(root);
    const [parkedWorker] = await subject.manager.dispatch(
      [
        {
          key: "initial-write",
          agent: "worker",
          task: "Prepare an auth change.",
          owns: ["path:src/auth"],
          deliverable: "Patch.",
          acceptance: "The patch is validated.",
          stopConditions: ["Stop on completion or report a blocker."],
        },
      ],
      subject.ctx,
    );
    subject.native.emit(parkedWorker!.id, { type: "settled", report: "Prepared." });
    await vi.waitFor(() =>
      expect(subject.manager.store.get(parkedWorker!.id)?.status).toBe("parked"),
    );
    subject.emit(events.planMode, { enabled: true });

    const [reader] = await subject.manager.dispatch(
      [
        {
          key: "read",
          agent: "scout",
          task: "Inspect the auth design.",
          owns: ["topic:auth-design"],
          deliverable: "Design report.",
          acceptance: "The design report is complete.",
          stopConditions: ["Stop on completion or report a blocker."],
        },
      ],
      subject.ctx,
    );
    expect(reader?.status).toBe("running");
    await expect(
      subject.manager.steer(parkedWorker!.id, "Continue the auth change."),
    ).rejects.toThrow(/Plan Mode/);
    await expect(
      subject.manager.dispatch(
        [
          {
            key: "write",
            agent: "worker",
            task: "Change auth.",
            owns: ["path:src/auth"],
            deliverable: "Patch.",
            acceptance: "The patch is validated.",
            stopConditions: ["Stop on completion or report a blocker."],
          },
        ],
        subject.ctx,
      ),
    ).rejects.toThrow(/Plan Mode/);
    expect(subject.native.starts).toHaveLength(2);
    await subject.manager.shutdown();
  });

  it("wraps and fails at the exact wall boundaries with the wall reason latched", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const root = await mkdtemp(join(tmpdir(), "subagent-manager-"));
    temporary.push(root);
    const limits = config();
    limits.runtime.maxWallSeconds = 1;
    limits.runtime.wrapUpRatio = 0.8;
    const subject = harness(root, { config: limits });
    const [run] = await subject.manager.dispatch([boundedTask("wall-boundary")], subject.ctx);

    await vi.advanceTimersByTimeAsync(799);
    expect(run!.wrappingUp).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(run!.wrappingUp).toBe(true);
    expect(run!.leaseHistory[0]).toMatchObject({ wrapCause: "wall" });
    expect(subject.native.steered).toHaveLength(1);
    expect(subject.sentMessages).toEqual([]);
    expect(subject.entries).toContainEqual({
      customType: "subagent-wrap-v1",
      data: expect.objectContaining({ schemaVersion: 1, runId: run!.id, cause: "wall" }),
    });
    expect(subject.notifications[0]).toMatchObject({ level: "warning" });

    await vi.advanceTimersByTimeAsync(200);
    expect(run!.status).toBe("failed");
    expect(run!.terminationReason?.code).toBe("wall_limit");
    expect(subject.manager.claims.forRun(run!.id)).toBeUndefined();
    vi.useRealTimers();
    await subject.manager.shutdown();
  });

  it("keeps every valid near-one wrap ratio strictly before the wall deadline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const root = await mkdtemp(join(tmpdir(), "subagent-manager-"));
    temporary.push(root);
    const limits = config();
    limits.runtime.maxWallSeconds = 1;
    limits.runtime.wrapUpRatio = 0.9999;
    const subject = harness(root, { config: limits });
    const [run] = await subject.manager.dispatch([boundedTask("near-deadline-wrap")], subject.ctx);

    await vi.advanceTimersByTimeAsync(998);
    expect(run!.wrappingUp).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(run!.wrappingUp).toBe(true);
    expect(run!.leaseHistory[0]?.wrapTriggeredAt).toBe("2026-01-01T00:00:00.999Z");
    await vi.advanceTimersByTimeAsync(1);
    expect(run!.terminationReason?.code).toBe("wall_limit");
    vi.useRealTimers();
    await subject.manager.shutdown();
  });

  it("allows natural completion on the final turn and rejects the next model request", async () => {
    const root = await mkdtemp(join(tmpdir(), "subagent-manager-"));
    temporary.push(root);
    const limits = config();
    limits.runtime.maxTurns = 2;
    const subject = harness(root, { config: limits });
    const [completed] = await subject.manager.dispatch([boundedTask("final-turn")], subject.ctx);
    subject.native.emit(completed!.id, { type: "turn_end" });
    subject.native.emit(completed!.id, { type: "turn_end" });
    expect(completed!.turns).toBe(2);
    expect(completed!.wrappingUp).toBe(true);
    subject.native.emit(completed!.id, { type: "settled", report: "Done on turn two." });
    await vi.waitFor(() => expect(completed!.status).toBe("parked"));
    expect(completed!.terminationReason?.code).toBe("completed");

    const [limited] = await subject.manager.dispatch([boundedTask("next-turn")], subject.ctx);
    subject.native.emit(limited!.id, { type: "turn_end" });
    subject.native.emit(limited!.id, { type: "turn_end" });
    expect(await subject.native.starts.at(-1)!.beforeModelRequest?.()).toBe(false);
    await vi.waitFor(() => expect(limited!.status).toBe("failed"));
    expect(limited!.terminationReason?.code).toBe("turn_limit");
    expect(limited!.turns).toBe(2);
    await subject.manager.shutdown();
  });

  it("gives wall priority when wall and turn limits become eligible together", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const root = await mkdtemp(join(tmpdir(), "subagent-manager-"));
    temporary.push(root);
    const limits = config();
    limits.runtime.maxWallSeconds = 1;
    limits.runtime.maxTurns = 1;
    const subject = harness(root, { config: limits });
    const [run] = await subject.manager.dispatch([boundedTask("wall-turn-tie")], subject.ctx);
    subject.native.emit(run!.id, { type: "turn_end" });
    vi.setSystemTime(new Date("2026-01-01T00:00:01.000Z"));

    expect(await subject.native.starts[0]!.beforeModelRequest?.()).toBe(false);
    expect(run!.terminationReason?.code).toBe("wall_limit");
    vi.useRealTimers();
    await subject.manager.shutdown();
  });

  it("latches token and cost limits at equality and rejects exhausted revival", async () => {
    const root = await mkdtemp(join(tmpdir(), "subagent-manager-"));
    temporary.push(root);
    const tokenProfile: AgentDefinition = {
      ...structuredClone(BUILTIN_PROFILES.find((profile) => profile.name === "scout")!),
      name: "token-scout",
      tokenBudget: 10,
    };
    const costProfile: AgentDefinition = {
      ...structuredClone(BUILTIN_PROFILES.find((profile) => profile.name === "reviewer")!),
      name: "cost-reviewer",
      costBudget: 0.25,
    };
    const subject = harness(root, { profiles: [tokenProfile, costProfile] });

    const [tokenRun] = await subject.manager.dispatch(
      [boundedTask("token-equality", tokenProfile.name)],
      subject.ctx,
    );
    subject.native.emit(tokenRun!.id, {
      type: "usage",
      input: 10,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
    });
    await vi.waitFor(() => expect(tokenRun!.status).toBe("failed"));
    expect(tokenRun!.terminationReason).toMatchObject({
      code: "token_limit",
      limit: { maximum: 10, observed: 10 },
    });

    const [costRun] = await subject.manager.dispatch(
      [boundedTask("cost-equality", costProfile.name)],
      subject.ctx,
    );
    subject.native.emit(costRun!.id, {
      type: "usage",
      input: 1,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0.25,
    });
    await vi.waitFor(() => expect(costRun!.status).toBe("failed"));
    expect(costRun!.terminationReason).toMatchObject({
      code: "cost_limit",
      limit: { maximum: 0.25, observed: 0.25 },
    });

    const [revival] = await subject.manager.dispatch(
      [boundedTask("token-revival", tokenProfile.name)],
      subject.ctx,
    );
    subject.native.emit(revival!.id, { type: "settled", report: "Completed below budget." });
    await vi.waitFor(() => expect(revival!.status).toBe("parked"));
    revival!.usage.total = 10;
    await expect(subject.manager.steer(revival!.id, "Continue.")).rejects.toThrow(
      /exhausted its cumulative token limit/,
    );
    expect(subject.manager.claims.forRun(revival!.id)).toBeUndefined();
    await subject.manager.shutdown();
  });

  it("gives an exact-deadline settlement to the wall limit while preserving its report", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const root = await mkdtemp(join(tmpdir(), "subagent-manager-"));
    temporary.push(root);
    const limits = config();
    limits.runtime.maxWallSeconds = 1;
    const subject = harness(root, { config: limits });
    const [run] = await subject.manager.dispatch([boundedTask("deadline-tie")], subject.ctx);
    vi.setSystemTime(new Date("2026-01-01T00:00:01.000Z"));
    subject.native.emit(run!.id, { type: "settled", report: "Final partial evidence." });
    await vi.runAllTicks();
    expect(run!.status).toBe("failed");
    expect(run!.terminationReason?.code).toBe("wall_limit");
    expect(run!.report).toBe("Final partial evidence.");
    await vi.waitFor(() =>
      expect(
        subject.emitted.filter((event) => event.name === events.continuationEnqueue),
      ).toHaveLength(1),
    );
    expect(subject.sentMessages).toEqual([]);
    const completionEvent = subject.emitted.find(
      (event) => event.name === events.continuationEnqueue,
    );
    expect(completionEvent).toBeDefined();
    const content = (completionEvent!.data as { message?: { content?: string } }).message?.content;
    expect(content).toContain("Failure reason: wall_limit");
    expect(content!.indexOf("Failure reason: wall_limit")).toBeLessThan(
      content!.indexOf("Partial report:"),
    );
    vi.useRealTimers();
    await subject.manager.shutdown();
  });

  it("keeps a run blocked until every linked request resolves", async () => {
    const root = await mkdtemp(join(tmpdir(), "subagent-manager-"));
    temporary.push(root);
    const subject = harness(root);
    const [run] = await subject.manager.dispatch([boundedTask("multi-block")], subject.ctx);
    const contact = subject.native.starts[0]!.customTools!.find(
      (tool) => tool.name === "contact_supervisor",
    )!;
    const first = contact.execute(
      "first",
      { kind: "decision", title: "First", detail: "First decision." },
      new AbortController().signal,
      () => {},
      {} as never,
    );
    const second = contact.execute(
      "second",
      { kind: "blocker", title: "Second", detail: "Second decision." },
      new AbortController().signal,
      () => {},
      {} as never,
    );
    await vi.waitFor(() => expect(subject.manager.pendingRequests()).toHaveLength(2));
    const [firstRequest, secondRequest] = subject.manager.pendingRequests();
    expect(run!.blockedSince).toBe(firstRequest!.createdAt);
    await subject.manager.respondRequest(firstRequest!.id, "continue");
    await first;
    expect(run!.status).toBe("blocked");
    expect(run!.blockedSince).toBe(secondRequest!.createdAt);
    await subject.manager.respondRequest(secondRequest!.id, "continue");
    await second;
    expect(run!.status).toBe("running");
    expect(run!.blockedSince).toBeUndefined();
    await subject.manager.shutdown();
  });

  it("queues a wrap instruction while blocked and delivers it after resolution", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const root = await mkdtemp(join(tmpdir(), "subagent-manager-"));
    temporary.push(root);
    const limits = config();
    limits.runtime.maxWallSeconds = 1;
    const subject = harness(root, { config: limits });
    const [run] = await subject.manager.dispatch([boundedTask("blocked-wrap")], subject.ctx);
    const contact = subject.native.starts[0]!.customTools!.find(
      (tool) => tool.name === "contact_supervisor",
    )!;
    const response = contact.execute(
      "blocked",
      { kind: "decision", title: "Choose", detail: "Choose a path." },
      new AbortController().signal,
      () => {},
      {} as never,
    );
    await vi.advanceTimersByTimeAsync(800);
    expect(run!.status).toBe("blocked");
    expect(run!.wrappingUp).toBe(true);
    expect(subject.native.steered).toEqual([]);
    const request = subject.manager.pendingRequests()[0]!;
    await subject.manager.respondRequest(request.id, "continue");
    await response;
    await vi.runAllTicks();
    expect(subject.native.steered).toHaveLength(1);
    const stop = subject.manager.stop(run!.id);
    await vi.runAllTicks();
    await stop;
    vi.useRealTimers();
    await subject.manager.shutdown();
  });

  it("accepts late same-generation text and usage during cleanup without replacing the reason", async () => {
    const root = await mkdtemp(join(tmpdir(), "subagent-manager-"));
    temporary.push(root);
    const subject = harness(root);
    const [run] = await subject.manager.dispatch([boundedTask("late-cleanup")], subject.ctx);
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(subject.native, "park").mockImplementation(async (id) => {
      subject.native.parked.push(id);
      await pending;
      subject.native.listeners.delete(id);
    });
    const stopped = subject.manager.stop(run!.id);
    expect(run!.terminationReason?.code).toBe("explicit_stop");
    subject.native.emit(run!.id, { type: "text", delta: "Partial", text: "Partial report" });
    subject.native.emit(run!.id, {
      type: "usage",
      input: 5,
      output: 3,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0.01,
    });
    subject.native.emit(run!.id, { type: "error", error: new Error("late backend error") });
    subject.native.emit(run!.id, { type: "settled", report: "late settlement" });
    expect(run!.report).toBe("Partial report");
    expect(run!.usage.total).toBe(8);
    expect(run!.terminationReason?.code).toBe("explicit_stop");
    release();
    await stopped;
    await subject.manager.shutdown();
  });

  it("ignores stale wall timers after completion, stop, session change, and shutdown", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const limits = config();
    limits.runtime.maxWallSeconds = 1;
    const makeSubject = async () => {
      const root = await mkdtemp(join(tmpdir(), "subagent-manager-"));
      temporary.push(root);
      return harness(root, { config: limits });
    };

    const completedSubject = await makeSubject();
    const [completed] = await completedSubject.manager.dispatch(
      [boundedTask("stale-completed")],
      completedSubject.ctx,
    );
    completedSubject.native.emit(completed!.id, { type: "settled", report: "Done." });
    await vi.runAllTicks();
    expect(completed!.terminationReason?.code).toBe("completed");

    const stoppedSubject = await makeSubject();
    const [stopped] = await stoppedSubject.manager.dispatch(
      [boundedTask("stale-stopped")],
      stoppedSubject.ctx,
    );
    await stoppedSubject.manager.stop(stopped!.id);
    expect(stopped!.terminationReason?.code).toBe("explicit_stop");

    const switchedSubject = await makeSubject();
    const [switched] = await switchedSubject.manager.dispatch(
      [boundedTask("stale-session")],
      switchedSubject.ctx,
    );
    switchedSubject.setSessionId("next-parent");
    await switchedSubject.manager.status(switchedSubject.ctx);
    expect(switched!.terminationReason?.code).toBe("session_change");

    const shutdownSubject = await makeSubject();
    const [shutdown] = await shutdownSubject.manager.dispatch(
      [boundedTask("stale-shutdown")],
      shutdownSubject.ctx,
    );
    await shutdownSubject.manager.shutdown();
    expect(shutdown!.terminationReason?.code).toBe("parent_shutdown");

    await vi.advanceTimersByTimeAsync(1_000);
    expect(completed!.terminationHistory.map((reason) => reason.code)).toEqual(["completed"]);
    expect(stopped!.terminationHistory.map((reason) => reason.code)).toEqual(["explicit_stop"]);
    expect(switched!.terminationHistory.map((reason) => reason.code)).toEqual(["session_change"]);
    expect(shutdown!.terminationHistory.map((reason) => reason.code)).toEqual(["parent_shutdown"]);

    await completedSubject.manager.shutdown();
    await stoppedSubject.manager.shutdown();
    await switchedSubject.manager.shutdown();
    vi.useRealTimers();
  });

  it("does not let a stale completed lease deadline terminate a revived generation", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const root = await mkdtemp(join(tmpdir(), "subagent-manager-"));
    temporary.push(root);
    const limits = config();
    limits.runtime.maxWallSeconds = 1;
    const subject = harness(root, { config: limits });
    const [run] = await subject.manager.dispatch([boundedTask("stale-generation")], subject.ctx);
    subject.native.emit(run!.id, { type: "settled", report: "First lease complete." });
    await vi.runAllTicks();
    expect(run!.status).toBe("parked");

    await vi.advanceTimersByTimeAsync(100);
    await subject.manager.steer(run!.id, "Use a new, narrower lease.");
    expect(run!.leaseHistory).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(900);
    expect(run!.status).toBe("running");
    expect(run!.activeLeaseGeneration).toBe(2);
    await vi.advanceTimersByTimeAsync(100);
    expect(run!.status).toBe("failed");
    expect(run!.terminationReason).toMatchObject({ code: "wall_limit", generation: 2 });
    vi.useRealTimers();
    await subject.manager.shutdown();
  });

  it("keeps the original lease when private wrap steering fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "subagent-manager-"));
    temporary.push(root);
    const limits = config();
    limits.runtime.maxTurns = 5;
    const subject = harness(root, { config: limits });
    vi.spyOn(subject.native, "steer").mockRejectedValueOnce(new Error("steer unavailable"));
    const [run] = await subject.manager.dispatch([boundedTask("wrap-steer-failure")], subject.ctx);
    for (let turn = 0; turn < 4; turn += 1) subject.native.emit(run!.id, { type: "turn_end" });
    await vi.waitFor(() =>
      expect(run!.activity.some((entry) => entry.text.includes("wrap instruction failed"))).toBe(
        true,
      ),
    );
    expect(run!.status).toBe("running");
    expect(run!.wrappingUp).toBe(true);
    expect(run!.activeLeaseGeneration).toBe(1);
    expect(run!.terminationReason).toBeUndefined();
    await subject.manager.stop(run!.id);
    await subject.manager.shutdown();
  });

  it("makes a blocked run fail at its wall limit and cancels its request", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const root = await mkdtemp(join(tmpdir(), "subagent-manager-"));
    temporary.push(root);
    const limits = config();
    limits.runtime.maxWallSeconds = 1;
    const subject = harness(root, { config: limits });
    const [run] = await subject.manager.dispatch([boundedTask("blocked-hard-limit")], subject.ctx);
    const contact = subject.native.starts[0]?.customTools?.find(
      (tool) => tool.name === "contact_supervisor",
    );
    const response = contact!.execute(
      "blocked-hard-limit",
      { kind: "blocker", title: "Blocked", detail: "An answer is required." },
      new AbortController().signal,
      () => {},
      {} as never,
    );
    await vi.runAllTicks();
    expect(run!.status).toBe("blocked");

    await vi.advanceTimersByTimeAsync(1_000);
    expect(run!.status).toBe("failed");
    expect(run!.terminationReason?.code).toBe("wall_limit");
    expect(subject.manager.inbox.all()[0]?.status).toBe("cancelled");
    expect(subject.manager.claims.forRun(run!.id)).toBeUndefined();
    await response;
    vi.useRealTimers();
    await subject.manager.shutdown();
  });

  it("propagates ancestor termination and preserves descendant partial output", async () => {
    const root = await mkdtemp(join(tmpdir(), "subagent-manager-"));
    temporary.push(root);
    const subject = harness(root);
    const [parent, child] = await subject.manager.dispatch(
      [boundedTask("parent"), boundedTask("child")],
      subject.ctx,
    );
    child!.parentId = parent!.id;
    subject.native.emit(child!.id, { type: "text", delta: "Partial", text: "Child partial" });
    await subject.manager.stop(parent!.id);
    expect(parent!.terminationReason?.code).toBe("explicit_stop");
    expect(child!.terminationReason).toMatchObject({
      code: "ancestor_terminated",
      ancestorRunId: parent!.id,
    });
    expect(child!.report).toBe("Child partial");
    await subject.manager.shutdown();
  });

  it("rejects exhausted-turn revival before reserving a claim", async () => {
    const root = await mkdtemp(join(tmpdir(), "subagent-manager-"));
    temporary.push(root);
    const limits = config();
    limits.runtime.maxTurns = 1;
    const subject = harness(root, { config: limits });
    const [run] = await subject.manager.dispatch([boundedTask("exhausted")], subject.ctx);
    subject.native.emit(run!.id, { type: "turn_end" });
    subject.native.emit(run!.id, { type: "settled", report: "Done." });
    await vi.waitFor(() => expect(run!.status).toBe("parked"));
    await expect(subject.manager.steer(run!.id, "Continue.")).rejects.toThrow(
      /exhausted its cumulative turn limit/,
    );
    expect(run!.status).toBe("parked");
    expect(subject.manager.claims.forRun(run!.id)).toBeUndefined();
    await subject.manager.shutdown();
  });

  it("returns structured timeout and abort reasons without stopping a child", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const root = await mkdtemp(join(tmpdir(), "subagent-manager-"));
    temporary.push(root);
    const subject = harness(root);
    const [run] = await subject.manager.dispatch([boundedTask("bounded-collect")], subject.ctx);

    await expect(subject.manager.collect([], "all")).resolves.toEqual({
      runs: [],
      waitReason: "settled",
    });
    await expect(subject.manager.collect(["missing-run"], "all")).rejects.toThrow(
      /Unknown Hackler run/,
    );
    expect(subject.manager.takeUnreportedUsage([])).toEqual(emptyUsage());
    expect(() => subject.manager.takeUnreportedUsage(["missing-run"])).toThrow(
      /Unknown Hackler run/,
    );

    const timed = subject.manager.collect([run!.id], "all", undefined, 10);
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(timed).resolves.toMatchObject({ waitReason: "timeout" });
    expect(run!.status).toBe("running");

    let defaultReason: string | undefined;
    const defaulted = subject.manager.collect([run!.id], "all").then((result) => {
      defaultReason = result.waitReason;
      return result;
    });
    await vi.advanceTimersByTimeAsync(59_999);
    expect(defaultReason).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    await expect(defaulted).resolves.toMatchObject({ waitReason: "timeout" });

    const controller = new AbortController();
    const aborted = subject.manager.collect([run!.id], "all", controller.signal, 10);
    controller.abort();
    await expect(aborted).resolves.toMatchObject({ waitReason: "aborted" });
    expect(run!.status).toBe("running");

    const stop = subject.manager.stop(run!.id);
    await vi.runAllTicks();
    await stop;
    vi.useRealTimers();
    await subject.manager.shutdown();
  });

  it("persists a separate redacted evaluation ledger beyond display activity", async () => {
    const root = await mkdtemp(join(tmpdir(), "subagent-manager-"));
    temporary.push(root);
    const subject = harness(root);
    const [run] = await subject.manager.dispatch([boundedTask("trace-canary")], subject.ctx);
    const { request } = subject.manager.inbox.request({
      fromRunId: run!.id,
      kind: "decision",
      title: "FORBIDDEN_TRACE_TITLE",
      detail: "FORBIDDEN_TRACE_DETAIL",
    });
    subject.manager.inbox.resolve(request.id, "FORBIDDEN_TRACE_ANSWER");
    subject.native.emit(run!.id, { type: "settled", report: "FORBIDDEN_TRACE_REPORT" });
    await vi.waitFor(() => expect(run!.status).toBe("parked"));

    const trace = subject.manager.evaluationTrace("2026-01-01T00:00:20.000Z");
    expect(trace.runs[0]).toMatchObject({
      id: run!.id,
      status: "parked",
      leases: [expect.objectContaining({ acceptedAt: expect.any(String), endReason: "completed" })],
      terminalReason: { code: "completed" },
    });
    expect(trace.requests).toEqual([
      expect.objectContaining({ id: request.id, runId: run!.id, status: "answered" }),
    ]);
    expect(trace.activities.some((activity) => activity.kind === "spawn")).toBe(true);
    expect(trace.capacityTimeline.length).toBeGreaterThan(1);
    expect(JSON.stringify(trace)).not.toMatch(
      /FORBIDDEN_TRACE_(?:TITLE|DETAIL|ANSWER|REPORT)|trace-canary/,
    );

    await subject.manager.shutdown();
    const persisted = JSON.parse(
      await readFile(join(root, "parent-session", "runs.json"), "utf8"),
    ) as { evaluation?: unknown };
    expect(persisted.evaluation).toEqual(expect.objectContaining({ schemaVersion: 1 }));
  });

  it("registers immutable ordered membership before startup and emits one aggregate after all cleanup", async () => {
    const root = await mkdtemp(join(tmpdir(), "subagent-manager-v3-"));
    temporary.push(root);
    const subject = harness(root);
    const runs = await subject.manager.dispatch(
      [boundedTask("aggregate-a"), boundedTask("aggregate-b", "reviewer")],
      subject.ctx,
      { toolCallId: "dispatch-two" },
    );
    const [batch] = subject.manager.batchSnapshots();
    expect(batch).toMatchObject({
      route: "pi",
      phase: "collecting",
      members: [
        { runId: runs[0]!.id, generation: 1 },
        { runId: runs[1]!.id, generation: 1 },
      ],
      results: [],
    });

    subject.native.emit(runs[1]!.id, { type: "settled", report: "Second report." });
    await vi.waitFor(() => expect(runs[1]!.status).toBe("parked"));
    expect(runs[1]!.completionAcknowledgedGeneration).toBeUndefined();
    expect(
      subject.emitted.filter((event) => event.name === events.continuationEnqueue),
    ).toHaveLength(0);
    subject.native.emit(runs[0]!.id, { type: "settled", report: "First report." });
    await vi.waitFor(() =>
      expect(
        subject.emitted.filter((event) => event.name === events.continuationEnqueue),
      ).toHaveLength(1),
    );
    const completed = subject.manager.batchSnapshots()[0]!;
    expect(subject.manager.hubSnapshot().batchCounts).toEqual({
      open: 1,
      ready: 0,
      inFlight: 1,
    });
    expect(completed.results.map((result) => result.runId)).toEqual(runs.map((run) => run.id));
    expect(completed.results.map((result) => result.snapshot?.status)).toEqual([
      "parked",
      "parked",
    ]);
    expect(runs.map((run) => run.completionAcknowledgedGeneration)).toEqual([undefined, undefined]);
    subject.emit(events.continuationReceipt, {
      producerId: "hackler-batches-v3",
      requestId: completed.continuationId,
      status: "settled",
    });
    expect(subject.manager.batchSnapshots()[0]?.phase).toBe("delivered");
    expect(runs.map((run) => run.completionAcknowledgedGeneration)).toEqual([1, 1]);
    const historyOnly = [...subject.emitted]
      .reverse()
      .find((event) => event.name === events.subagentsStatus)?.data as SubagentsStatusEvent;
    expect(historyOnly).toMatchObject({ foreground: 0, history: 2, agents: [] });
    expect(subject.manager.hubSnapshot().batchCounts.open).toBe(0);
    expect(subject.sentMessages).toEqual([]);
    await subject.manager.shutdown();
  });

  it("keeps concurrent dispatch batches isolated and preserves exact stop evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "subagent-manager-v3-"));
    temporary.push(root);
    const subject = harness(root);
    const [first] = await subject.manager.dispatch([boundedTask("batch-one")], subject.ctx, {
      toolCallId: "batch-one-call",
    });
    const [second] = await subject.manager.dispatch([boundedTask("batch-two")], subject.ctx, {
      toolCallId: "batch-two-call",
    });
    subject.native.emit(first!.id, { type: "text", delta: "partial", text: "Partial evidence." });
    await subject.manager.stop(first!.id);
    subject.native.emit(second!.id, { type: "settled", report: "Complete evidence." });
    await vi.waitFor(() =>
      expect(
        subject.emitted.filter((event) => event.name === events.continuationEnqueue),
      ).toHaveLength(2),
    );
    const requests = subject.emitted
      .filter((event) => event.name === events.continuationEnqueue)
      .map((event) => event.data as { dedupeKey?: string; message?: { content?: string } });
    expect(new Set(requests.map((request) => request.dedupeKey)).size).toBe(2);
    const stopped = requests.find((request) => request.message?.content?.includes("Stop reason"));
    expect(stopped?.message?.content).toContain("explicit_stop");
    expect(stopped?.message?.content).toContain("Partial report:\nPartial evidence.");
    expect(subject.sentMessages).toEqual([]);
    await subject.manager.shutdown();
  });

  it("acknowledges the exact terminal generation returned by explicit collect", async () => {
    const root = await mkdtemp(join(tmpdir(), "subagent-manager-v3-"));
    temporary.push(root);
    const subject = harness(root);
    const [run] = await subject.manager.dispatch(
      [boundedTask("explicit-terminal-collect")],
      subject.ctx,
    );
    subject.native.emit(run!.id, { type: "settled", report: "Collect this generation." });
    await vi.waitFor(() => expect(run!.status).toBe("parked"));
    expect(subject.manager.batchSnapshots()[0]?.phase).toBe("in-flight");
    expect(run!.completionAcknowledgedGeneration).toBeUndefined();

    const result = await subject.manager.collect([run!.id], "none");

    expect(result.runs[0]?.completionAcknowledgedGeneration).toBe(1);
    expect(run!.completionAcknowledgedGeneration).toBe(1);
    expect(subject.manager.batchSnapshots()[0]?.phase).toBe("in-flight");
    await subject.manager.shutdown();
  });

  it("creates one singleton batch for every revival generation", async () => {
    const root = await mkdtemp(join(tmpdir(), "subagent-manager-v3-"));
    temporary.push(root);
    const subject = harness(root);
    const [run] = await subject.manager.dispatch([boundedTask("revival-batches")], subject.ctx, {
      toolCallId: "initial-generation",
    });
    subject.native.emit(run!.id, { type: "settled", report: "Generation one." });
    await vi.waitFor(() => expect(run!.status).toBe("parked"));
    await subject.manager.steer(run!.id, "Generation two.");
    subject.native.emit(run!.id, { type: "settled", report: "Generation two." });
    await vi.waitFor(() => expect(run!.status).toBe("parked"));
    const batches = subject.manager.batchSnapshots();
    expect(batches).toHaveLength(2);
    expect(batches.map((batch) => batch.members)).toEqual([
      [{ runId: run!.id, generation: 1 }],
      [{ runId: run!.id, generation: 2 }],
    ]);
    await subject.manager.shutdown();
  });

  it("does not let a revived generation inherit an older acknowledgement", async () => {
    const root = await mkdtemp(join(tmpdir(), "subagent-manager-v3-"));
    temporary.push(root);
    const subject = harness(root);
    const [run] = await subject.manager.dispatch(
      [boundedTask("generation-safe-revival")],
      subject.ctx,
    );
    subject.native.emit(run!.id, { type: "settled", report: "Generation one." });
    await vi.waitFor(() => expect(run!.status).toBe("parked"));
    const firstBatch = subject.manager.batchSnapshots()[0]!;
    subject.emit(events.continuationReceipt, {
      producerId: "hackler-batches-v3",
      requestId: firstBatch.continuationId,
      status: "settled",
    });
    expect(run!.completionAcknowledgedGeneration).toBe(1);

    await subject.manager.steer(run!.id, "Open generation two.");
    expect(run!.activeLeaseGeneration).toBe(2);
    expect(run!.completionAcknowledgedGeneration).toBe(1);
    subject.native.emit(run!.id, { type: "settled", report: "Generation two." });
    await vi.waitFor(() => expect(run!.status).toBe("parked"));
    expect(run!.terminationReason?.generation).toBe(2);
    expect(run!.completionAcknowledgedGeneration).toBe(1);

    const secondBatch = subject.manager.batchSnapshots()[1]!;
    subject.emit(events.continuationReceipt, {
      producerId: "hackler-batches-v3",
      requestId: secondBatch.continuationId,
      status: "settled",
    });
    expect(run!.completionAcknowledgedGeneration).toBe(2);
    await subject.manager.shutdown();
  });

  it("lets an orchestrator collect claim and acknowledge its batch without an automatic follow-up", async () => {
    const root = await mkdtemp(join(tmpdir(), "subagent-manager-v3-"));
    temporary.push(root);
    const subject = harness(root);
    const mission = await subject.manager.startMission(
      "Collect a nested batch explicitly.",
      ["topic:nested-collect"],
      subject.ctx,
      "shared",
    );
    const owner = subject.manager.store.get(mission.orchestratorId)!;
    const tools = subject.native.starts.find((start) => start.id === owner.id)?.customTools;
    const dispatch = tools?.find((tool) => tool.name === "subagent_dispatch");
    const collect = tools?.find((tool) => tool.name === "subagent_collect");
    await dispatch!.execute(
      "nested-collect-call",
      { tasks: [boundedTask("nested-collected-child")] },
      new AbortController().signal,
      () => {},
      {} as never,
    );
    const child = subject.manager.store.children(owner.id)[0]!;
    const collecting = collect!.execute(
      "collect-call",
      { ids: [child.id], wait: "all" },
      new AbortController().signal,
      () => {},
      {} as never,
    );
    subject.native.emit(child.id, { type: "settled", report: "Collected evidence." });
    await collecting;
    const batch = subject.manager
      .batchSnapshots()
      .find((candidate) => candidate.ownerRunId === owner.id)!;
    expect(batch).toMatchObject({
      phase: "delivered",
      claimedBy: owner.id,
      results: [expect.objectContaining({ runId: child.id, report: "Collected evidence." })],
    });
    expect(child.completionAcknowledgedGeneration).toBe(1);
    expect(subject.native.steered.some((entry) => entry.id === owner.id)).toBe(false);
    subject.native.emit(owner.id, { type: "settled", report: "Explicitly collected." });
    await vi.waitFor(() => expect(owner.status).toBe("parked"));
    await subject.manager.shutdown();
  });

  it("orphans nested batches and folds terminal child evidence when the owner terminates", async () => {
    const root = await mkdtemp(join(tmpdir(), "subagent-manager-v3-"));
    temporary.push(root);
    const subject = harness(root);
    const mission = await subject.manager.startMission(
      "Coordinate nested orphan evidence.",
      ["topic:nested-orphan"],
      subject.ctx,
      "shared",
    );
    const owner = subject.manager.store.get(mission.orchestratorId)!;
    const dispatch = subject.native.starts
      .find((start) => start.id === owner.id)
      ?.customTools?.find((tool) => tool.name === "subagent_dispatch");
    await dispatch!.execute(
      "nested-orphan-call",
      { tasks: [boundedTask("nested-orphan-child")] },
      new AbortController().signal,
      () => {},
      {} as never,
    );
    const child = subject.manager.store.children(owner.id)[0]!;
    subject.native.emit(child.id, {
      type: "text",
      delta: "partial",
      text: "Nested partial evidence.",
    });
    await subject.manager.stop(owner.id);
    await vi.waitFor(() => expect(child.status).toBe("stopped"));
    const nested = subject.manager.batchSnapshots().find((batch) => batch.ownerRunId === owner.id)!;
    expect(nested).toMatchObject({ route: "owner", phase: "orphaned" });
    expect(child.completionAcknowledgedGeneration).toBeUndefined();
    expect(owner.report).toContain("Orphaned nested result");
    expect(owner.report).toContain("ancestor_terminated");
    expect(owner.report).toContain("Nested partial evidence.");
    expect(subject.native.steered.some((entry) => entry.id === owner.id)).toBe(false);
    await subject.manager.shutdown();
  });

  it("reconciles a receipt that arrives before persisted batches restore", async () => {
    const root = await mkdtemp(join(tmpdir(), "subagent-manager-v3-"));
    temporary.push(root);
    const original = harness(root);
    const [run] = await original.manager.dispatch([boundedTask("restore-receipt")], original.ctx, {
      toolCallId: "restore-receipt-call",
    });
    original.native.emit(run!.id, { type: "settled", report: "Persisted result." });
    await vi.waitFor(() => expect(original.manager.batchSnapshots()[0]?.phase).toBe("in-flight"));
    const requestId = original.manager.batchSnapshots()[0]!.continuationId!;
    await original.manager.shutdown();

    const restored = harness(root);
    restored.emit(events.continuationReceipt, {
      producerId: "hackler-batches-v3",
      requestId,
      status: "settled",
    });
    await restored.manager.status(restored.ctx);
    await vi.waitFor(() => expect(restored.manager.batchSnapshots()[0]?.phase).toBe("delivered"));
    expect(
      restored.emitted.filter((event) => event.name === events.continuationEnqueue),
    ).toHaveLength(1);
    await restored.manager.shutdown();
  });

  it("does not claim a multi-member nested batch for a partial collection", async () => {
    const root = await mkdtemp(join(tmpdir(), "subagent-manager-v3-"));
    temporary.push(root);
    const subject = harness(root);
    const mission = await subject.manager.startMission(
      "Collect only one nested child.",
      ["topic:nested-partial-collect"],
      subject.ctx,
      "shared",
    );
    const owner = subject.manager.store.get(mission.orchestratorId)!;
    const tools = subject.native.starts.find((start) => start.id === owner.id)?.customTools;
    const dispatch = tools?.find((tool) => tool.name === "subagent_dispatch");
    const collect = tools?.find((tool) => tool.name === "subagent_collect");
    await dispatch!.execute(
      "nested-partial-call",
      { tasks: [boundedTask("partial-a"), boundedTask("partial-b", "reviewer")] },
      new AbortController().signal,
      () => {},
      {} as never,
    );
    const children = subject.manager.store.children(owner.id);
    await collect!.execute(
      "nonblocking-collect-call",
      { ids: children.map((child) => child.id), wait: "none" },
      new AbortController().signal,
      () => {},
      {} as never,
    );
    expect(
      subject.manager.batchSnapshots().find((batch) => batch.ownerRunId === owner.id)?.claimedBy,
    ).toBeUndefined();
    const collecting = collect!.execute(
      "partial-collect-call",
      { ids: [children[0]!.id], wait: "all" },
      new AbortController().signal,
      () => {},
      {} as never,
    );
    subject.native.emit(children[0]!.id, { type: "settled", report: "First only." });
    await collecting;
    expect(
      subject.manager.batchSnapshots().find((batch) => batch.ownerRunId === owner.id)?.claimedBy,
    ).toBeUndefined();
    subject.native.emit(children[1]!.id, { type: "settled", report: "Second later." });
    await vi.waitFor(() =>
      expect(
        subject.manager.batchSnapshots().find((batch) => batch.ownerRunId === owner.id)?.phase,
      ).toBe("ready"),
    );
    await subject.manager.stop(owner.id);
    await subject.manager.shutdown();
  });

  it("restores schema v2 runs without synthesizing or replaying historical batches", async () => {
    const root = await mkdtemp(join(tmpdir(), "subagent-manager-v3-"));
    temporary.push(root);
    const original = harness(root);
    const [run] = await original.manager.dispatch([boundedTask("v2-no-replay")], original.ctx, {
      toolCallId: "historical",
    });
    original.native.emit(run!.id, { type: "settled", report: "Historical report." });
    await vi.waitFor(() => expect(run!.status).toBe("parked"));
    await original.manager.shutdown();
    const path = join(root, "parent-session", "runs.json");
    const persisted = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    persisted.schemaVersion = 2;
    delete persisted.batches;
    delete persisted.batchSequence;
    await writeFile(path, JSON.stringify(persisted));

    const restored = harness(root);
    await restored.manager.status(restored.ctx);
    expect(restored.manager.batchSnapshots()).toEqual([]);
    expect(restored.manager.store.get(run!.id)?.completionAcknowledgedGeneration).toBe(1);
    expect(restored.emitted.filter((event) => event.name === events.continuationEnqueue)).toEqual(
      [],
    );
    await restored.manager.shutdown();
    const migrated = JSON.parse(await readFile(path, "utf8")) as { schemaVersion?: number };
    expect(migrated.schemaVersion).toBe(3);
  });

  it("derives schema v3 acknowledgement only from exact delivered terminal evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "subagent-manager-v3-"));
    temporary.push(root);
    const original = harness(root);
    const runs = await original.manager.dispatch(
      [
        boundedTask("restored-delivered"),
        boundedTask("restored-orphaned", "reviewer"),
        boundedTask("restored-unknown"),
      ],
      original.ctx,
      { toolCallId: "restore-acknowledgements" },
    );
    for (const run of runs)
      original.native.emit(run.id, { type: "settled", report: `${run.id} evidence.` });
    await vi.waitFor(() => expect(runs.every((run) => run.status === "parked")).toBe(true));
    await original.manager.shutdown();

    const path = join(root, "parent-session", "runs.json");
    const persisted = JSON.parse(await readFile(path, "utf8")) as {
      schemaVersion: number;
      runs: Array<{
        id: string;
        completionAcknowledgedGeneration?: number;
        completionReported: boolean;
      }>;
      batches: Array<{
        phase: string;
        deliveredAt?: string;
        orphanedAt?: string;
        members: Array<{ runId: string; generation: number }>;
        results: Array<{ runId: string; generation: number }>;
      }>;
    };
    expect(persisted.schemaVersion).toBe(3);
    for (const run of persisted.runs) {
      delete run.completionAcknowledgedGeneration;
      run.completionReported = true;
    }
    const [batch] = persisted.batches;
    expect(batch).toBeDefined();
    // Split the original aggregate into three persisted batches so each migration case is isolated.
    persisted.batches = batch!.members.map((member, index) => {
      const result = structuredClone(
        batch!.results.find(
          (candidate) =>
            candidate.runId === member.runId && candidate.generation === member.generation,
        )!,
      );
      if (index === 2) result.generation += 100;
      return {
        ...structuredClone(batch!),
        id: `${(batch as unknown as { id: string }).id}-${index}`,
        sequence: index + 1,
        members: [structuredClone(member)],
        results: [result],
        phase: index === 1 ? "orphaned" : "delivered",
        ...(index === 1
          ? { orphanedAt: new Date().toISOString(), deliveredAt: undefined }
          : { deliveredAt: new Date().toISOString(), orphanedAt: undefined }),
      };
    });
    await writeFile(path, `${JSON.stringify(persisted, null, 2)}\n`);

    const restored = harness(root);
    await restored.manager.status(restored.ctx);
    expect(
      runs.map((run) => restored.manager.store.get(run.id)?.completionAcknowledgedGeneration),
    ).toEqual([1, undefined, undefined]);
    expect(restored.manager.store.get(runs[2]!.id)?.completionReported).toBe(true);
    await restored.manager.shutdown();
  });
});
