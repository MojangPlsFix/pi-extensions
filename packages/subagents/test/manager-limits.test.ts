import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BUILTIN_PROFILES } from "../agents.js";
import { DEFAULT_SUBAGENT_CONFIG, type SubagentConfig } from "../config.js";
import { SubagentManager, type SubagentManagerDependencies } from "../manager.js";
import type { NativeRunEvent, NativeRunListener } from "../native-backend.js";
import type { AgentDefinition } from "../types.js";

const temporary: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

class FakeBackend<Spec extends { id: string }> {
  readonly starts: Spec[] = [];
  readonly steered: string[] = [];
  readonly aborted: string[] = [];
  readonly parked: string[] = [];
  readonly listeners = new Map<string, NativeRunListener>();

  async start(spec: Spec, listener: NativeRunListener): Promise<void> {
    this.starts.push(spec);
    this.listeners.set(spec.id, listener);
    listener({ type: "accepted" });
  }

  emit(id: string, event: NativeRunEvent): void {
    this.listeners.get(id)?.(event);
  }
  async steer(id: string): Promise<void> {
    this.steered.push(id);
  }
  async abort(id: string): Promise<void> {
    this.aborted.push(id);
  }
  async park(id: string): Promise<void> {
    this.parked.push(id);
  }
  async shutdown(): Promise<void> {}
}

function task(key: string, agent: string) {
  return {
    key,
    agent,
    task: `Inspect ${key}.`,
    owns: [`topic:${key}`],
    deliverable: `${key} report.`,
    acceptance: `${key} limits are captured.`,
    stopConditions: ["Stop after the limit contract is verified."],
  };
}

async function subject(
  config: SubagentConfig,
  profiles: AgentDefinition[],
  backends: { native?: object; rpc?: object; external?: object },
) {
  const root = await mkdtemp(join(tmpdir(), "subagent-limits-"));
  temporary.push(root);
  const listeners = new Map<string, Array<(value: unknown) => void>>();
  const pi = {
    events: {
      on(name: string, listener: (value: unknown) => void) {
        listeners.set(name, [...(listeners.get(name) ?? []), listener]);
        return () => {};
      },
      emit(name: string, value: unknown) {
        for (const listener of listeners.get(name) ?? []) listener(value);
      },
    },
    sendMessage() {},
  } as unknown as ExtensionAPI;
  const manager = new SubagentManager(pi, {
    native: backends.native as SubagentManagerDependencies["native"],
    rpc: backends.rpc as SubagentManagerDependencies["rpc"],
    external: backends.external as SubagentManagerDependencies["external"],
    sessionRoot: root,
    loadConfig: async () => structuredClone(config),
    discoverProfiles: async () => ({
      profiles: profiles.map((profile) => structuredClone(profile)),
      diagnostics: [],
    }),
  });
  const ctx = {
    cwd: process.cwd(),
    model: undefined,
    thinkingLevel: "low",
    ui: {},
    modelRegistry: { refresh: async () => {}, getAll: () => [] },
    sessionManager: {
      getSessionId: () => "limit-parent",
      getSessionFile: () => join(root, "parent.jsonl"),
      buildSessionContext: () => ({ messages: [] }),
    },
    isProjectTrusted: () => false,
  } as unknown as ExtensionContext;
  return { manager, ctx };
}

describe("effective runtime limits", () => {
  it("uses the profile/global minimum for native and RPC wall and turn budgets", async () => {
    const config = structuredClone(DEFAULT_SUBAGENT_CONFIG);
    config.runtime.maxWallSeconds = 500;
    config.runtime.maxTurns = 50;
    const nativeProfile = {
      ...structuredClone(BUILTIN_PROFILES.find((profile) => profile.name === "scout")!),
      name: "native-limit",
      timeout: 600,
      turnBudget: 60,
    };
    const rpcProfile = {
      ...structuredClone(BUILTIN_PROFILES.find((profile) => profile.name === "reviewer")!),
      name: "rpc-limit",
      runner: "rpc" as const,
      timeout: 300,
      turnBudget: 40,
    };
    const native = new FakeBackend<{ id: string; timeoutMs?: number }>();
    const rpc = new FakeBackend<{ id: string; timeoutMs?: number; maxTurns?: number }>();
    const current = await subject(config, [nativeProfile, rpcProfile], { native, rpc });

    const [nativeRun] = await current.manager.dispatch(
      [task("native-min", nativeProfile.name)],
      current.ctx,
    );
    const [rpcRun] = await current.manager.dispatch(
      [task("rpc-min", rpcProfile.name)],
      current.ctx,
    );

    expect(nativeRun!.originalEffectiveLimits).toMatchObject({
      maxWallSeconds: 500,
      maxTurns: 50,
    });
    expect(native.starts[0]).toMatchObject({ timeoutMs: 500_000 });
    expect(rpcRun!.originalEffectiveLimits).toMatchObject({
      maxWallSeconds: 300,
      maxTurns: 40,
    });
    expect(rpc.starts[0]).toMatchObject({
      timeoutMs: 300_000,
      maxTurns: 40,
      deadlineAtMs: expect.any(Number),
    });
    rpc.emit(rpcRun!.id, { type: "deadline_reached" });
    await vi.waitFor(() => expect(rpcRun!.status).toBe("failed"));
    expect(rpcRun!.terminationReason?.code).toBe("wall_limit");
    await current.manager.shutdown();
  });

  it.each([
    { label: "global", global: 200, profile: 400, runner: 600, expected: 200 },
    { label: "profile", global: 700, profile: 300, runner: 500, expected: 300 },
    { label: "runner", global: 800, profile: 600, runner: 400, expected: 400 },
  ])(
    "uses the external three-way minimum when $label is smallest",
    async ({ global, profile, runner, expected }) => {
      const config = structuredClone(DEFAULT_SUBAGENT_CONFIG);
      config.runtime.maxWallSeconds = global;
      config.capabilities["external-exec"] = {
        name: "external-exec",
        executableArgvPrefixes: [["fake-review"]],
        state: "isolated",
        approval: "allow",
      };
      const definition: AgentDefinition = {
        ...structuredClone(BUILTIN_PROFILES.find((candidate) => candidate.name === "reviewer")!),
        name: "external-limit",
        runner: "external",
        timeout: profile,
        turnBudget: 1,
        capabilities: ["external-exec"],
        source: "user",
      };
      config.runners[definition.name] = {
        command: "fake-review",
        args: [],
        envAllowlist: [],
        timeoutMs: runner * 1_000,
        maxOutputBytes: 1_024,
      };
      const external = new FakeBackend<{ id: string; runner: { timeoutMs: number } }>();
      const current = await subject(config, [definition], { external });

      const [run] = await current.manager.dispatch(
        [task(`external-${expected}`, definition.name)],
        current.ctx,
      );

      expect(run!.originalEffectiveLimits).toMatchObject({
        maxWallSeconds: expected,
        maxTurns: "notApplicable",
      });
      expect(run!.leaseHistory[0]?.effectiveLimits.maxTurns).toBe("notApplicable");
      expect(external.starts[0]?.runner.timeoutMs).toBe(runner * 1_000);
      await current.manager.shutdown();
    },
  );

  it("warns but does not steer or stop an external runner at the wrap threshold", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const config = structuredClone(DEFAULT_SUBAGENT_CONFIG);
    config.runtime.maxWallSeconds = 1;
    config.runtime.wrapUpRatio = 0.8;
    config.capabilities["external-exec"] = {
      name: "external-exec",
      executableArgvPrefixes: [["fake-review"]],
      state: "isolated",
      approval: "allow",
    };
    const definition: AgentDefinition = {
      ...structuredClone(BUILTIN_PROFILES.find((candidate) => candidate.name === "reviewer")!),
      name: "external-warning",
      runner: "external",
      timeout: 10,
      capabilities: ["external-exec"],
      source: "user",
    };
    config.runners[definition.name] = {
      command: "fake-review",
      args: [],
      envAllowlist: [],
      timeoutMs: 10_000,
      maxOutputBytes: 1_024,
    };
    const external = new FakeBackend<{ id: string; runner: { timeoutMs: number } }>();
    const current = await subject(config, [definition], { external });
    const [run] = await current.manager.dispatch(
      [task("external-warning", definition.name)],
      current.ctx,
    );

    await vi.advanceTimersByTimeAsync(800);
    expect(run!.wrappingUp).toBe(true);
    expect(external.steered).toEqual([]);
    expect(external.aborted).toEqual([]);
    expect(external.parked).toEqual([]);

    await vi.advanceTimersByTimeAsync(200);
    expect(run!.terminationReason?.code).toBe("wall_limit");
    expect(external.aborted).toEqual([run!.id]);
    expect(external.parked).toEqual([run!.id]);
    vi.useRealTimers();
    await current.manager.shutdown();
  });
});
