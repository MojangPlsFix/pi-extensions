import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { events } from "../../../shared/events.js";
import { BUILTIN_PROFILES } from "../agents.js";
import { selectEffectiveCapabilities } from "../capabilities.js";
import { DEFAULT_SUBAGENT_CONFIG, type SubagentConfig } from "../config.js";
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
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

class FakeNativeBackend {
  readonly starts: NativeRunSpec[] = [];
  readonly listeners = new Map<string, NativeRunListener>();
  readonly aborted: string[] = [];
  readonly parked: string[] = [];

  async start(spec: NativeRunSpec, listener: NativeRunListener): Promise<void> {
    this.starts.push(spec);
    this.listeners.set(spec.id, listener);
    listener({ type: "accepted", sessionFile: join(spec.sessionDir, `${spec.id}.jsonl`) });
  }

  emit(id: string, event: NativeRunEvent): void {
    this.listeners.get(id)?.(event);
  }

  async steer(): Promise<void> {}
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

function harness(
  sessionRoot: string,
  options: { config?: SubagentConfig; profiles?: AgentDefinition[] } = {},
) {
  const bus = new Map<string, Array<(data: unknown) => void>>();
  const sent: unknown[] = [];
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
        for (const listener of bus.get(name) ?? []) listener(data);
      },
    },
    sendMessage(message: unknown) {
      sent.push(message);
    },
  } as unknown as ExtensionAPI;
  const native = new FakeNativeBackend();
  const manager = new SubagentManager(pi, {
    native: native as unknown as NativeBackend,
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
        },
        {
          key: "review-tests",
          agent: "reviewer",
          task: "Review authentication tests.",
          owns: ["path:test/auth"],
          deliverable: "Review findings.",
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
          },
          {
            key: "two",
            agent: "reviewer",
            task: "Inspect auth flow!",
            owns: ["path:src/auth"],
            deliverable: "Findings.",
          },
        ],
        subject.ctx,
      ),
    ).rejects.toThrow(/same normalized work/);
    expect(subject.native.starts).toHaveLength(0);
    await subject.manager.shutdown();
  });

  it("revives with the captured capability policy, isolated cwd, and timeout", async () => {
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
        },
      ],
      subject.ctx,
    );
    expect(run).toBeDefined();
    run!.status = "parked";
    run!.finishedAt = new Date().toISOString();
    run!.ownership.workspace = "worktree";
    run!.worktree = {
      missionId: run!.id,
      root: "/tmp/captured-worktree",
      cwd: "/tmp/captured-worktree/subdir",
      sourceRoot: subject.ctx.cwd,
      baseCommit: "deadbeef",
    };
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

    await subject.manager.steer(run!.id, "Continue in the isolated tree.");
    expect(subject.native.starts[1]).toMatchObject({
      cwd: "/tmp/captured-worktree/subdir",
      extensionPaths: ["/trusted/captured-extension.ts"],
      timeoutMs: 9_000,
    });
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

    const collected = await subject.manager.collect([run!.id], "all");
    expect(collected[0]?.status).toBe("blocked");
    const request = subject.manager.pendingRequests()[0];
    expect(request).toMatchObject({ kind: "decision", fromRunId: run!.id });
    await subject.manager.respondRequest(request!.id, "continue");
    await response;
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
          },
        ],
        subject.ctx,
      ),
    ).rejects.toThrow(/Plan Mode/);
    expect(subject.native.starts).toHaveLength(2);
    await subject.manager.shutdown();
  });
});
