import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  composeBashOperations,
  isSupportedRtkVersion,
  rewriteWithRtk,
  runExecutable,
  TERMINATION_ESCALATION_MS,
} from "../child-rtk.js";
import {
  childPiArgs,
  childResourceWarnings,
  childSkillPaths,
  childUtilityExtensions,
  detectChildResources,
  extensionDirectory,
  reviewedResourcePaths,
} from "../child-runtime.js";
import {
  BUILTIN_RESOURCE_PROFILES,
  effectiveAgentResources,
  loadSubagentConfig,
  resolveAgentResourcePolicy,
} from "../config.js";
import {
  type AgentDefinition,
  type ChildResourcePolicy,
  emptyUsage,
  type ManagedAgent,
  type ResolvedChildResourcePolicy,
} from "../types.js";

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const explorer: AgentDefinition = {
  name: "explorer",
  description: "explorer",
  mode: "explorer",
  prompt: "",
  source: "builtin",
};
const worker: AgentDefinition = { ...explorer, name: "worker", mode: "worker" };

function managed(
  definition: AgentDefinition,
  resources: ManagedAgent["effectiveResources"],
): ManagedAgent {
  return {
    id: "child",
    name: definition.name,
    definition,
    task: "task",
    taskHistory: ["task"],
    status: "running",
    backend: "rpc",
    startedAt: new Date(0).toISOString(),
    sessionDir: "/tmp/subagent-session",
    stderr: "",
    output: "",
    usage: emptyUsage(),
    completionReported: false,
    effectiveResources: resources,
    requestedResources: {
      ...BUILTIN_RESOURCE_PROFILES[definition.mode],
    },
    detectedResources: {
      contextMode: resources?.contextMode ?? false,
      contextExecution: resources?.contextExecution ?? false,
      webSearch: resources?.webSearch ?? false,
      todos: resources?.todos ?? false,
      rtk: resources?.rtk ?? false,
      uv: resources?.uv ?? false,
    },
    resourceWarnings: [],
    activity: [],
  };
}

describe("optional child resources", () => {
  it("keeps the public resource policy partial while resolving a full internal policy", () => {
    const override: ChildResourcePolicy = { webSearch: true };
    const resolved: ResolvedChildResourcePolicy = resolveAgentResourcePolicy(worker, {
      defaults: { resources: override },
    });
    expect(resolved.webSearch).toBe(true);
    expect(resolved.todos).toBe(true);
  });

  it("uses profile, defaults, mode, then exact custom-agent precedence", () => {
    const definition = { ...worker, name: "builder", source: "user" as const };
    const result = resolveAgentResourcePolicy(definition, {
      defaults: { resources: { webSearch: true, uv: "disabled" } },
      agents: {
        worker: { resources: { webSearch: false, rtk: "enabled" } },
        builder: { resources: { webSearch: true } },
      },
    });
    expect(result.webSearch).toBe(true);
    expect(result.rtk).toBe("enabled");
    expect(result.uv).toBe("disabled");
    expect(result.todos).toBe(true);
  });

  it("rejects unknown values and role/conflict boundaries", async () => {
    const directory = await mkdtemp(join(tmpdir(), "subagent-resources-"));
    temporary.push(directory);
    const path = join(directory, "config.json");
    await writeFile(path, '{"agents":{"explorer":{"resources":{"uv":"auto"}}}}');
    await expect(loadSubagentConfig(path)).rejects.toThrow("Explorer uv");
    await writeFile(
      path,
      '{"agents":{"worker":{"resources":{"contextMode":"disabled","contextExecution":true}}}}',
    );
    await expect(loadSubagentConfig(path)).rejects.toThrow("contextExecution");
    await writeFile(path, '{"defaults":{"resources":{"webSearch":"enabled"}}}');
    await expect(loadSubagentConfig(path)).rejects.toThrow("must be a boolean");
    await writeFile(path, '{"unexpected":true}');
    await expect(loadSubagentConfig(path)).rejects.toThrow("not supported");
  });

  it("skips disabled probes and caches requested RTK/UV probes", async () => {
    const disabled = {
      ...BUILTIN_RESOURCE_PROFILES.worker,
      contextMode: "disabled" as const,
      contextExecution: false,
      webSearch: false,
      todos: false,
      rtk: "disabled" as const,
      uv: "disabled" as const,
    };
    let rtkCalls = 0;
    let uvCalls = 0;
    const overrides = {
      contextModeAvailable: () => {
        throw new Error("disabled context probe should not run");
      },
      exists: () => {
        throw new Error("disabled filesystem probe should not run");
      },
      probeRtk: async () => {
        rtkCalls++;
        return true;
      },
      probeUv: async () => {
        uvCalls++;
        return true;
      },
    };
    await expect(
      detectChildResources(disabled, "/tmp/disabled", new Map(), overrides),
    ).resolves.toMatchObject({
      contextMode: false,
      rtk: false,
      uv: false,
    });
    expect({ rtkCalls, uvCalls }).toEqual({ rtkCalls: 0, uvCalls: 0 });

    const cache = new Map<string, Promise<boolean>>();
    const enabled = { ...BUILTIN_RESOURCE_PROFILES.worker };
    const probing = {
      contextModeAvailable: () => true,
      exists: () => true,
      probeRtk: async () => {
        rtkCalls++;
        return true;
      },
      probeUv: async () => {
        uvCalls++;
        return true;
      },
    };
    await detectChildResources(enabled, "/tmp/cached", cache, probing);
    await detectChildResources(enabled, "/tmp/cached", cache, probing);
    expect({ rtkCalls, uvCalls }).toEqual({ rtkCalls: 1, uvCalls: 1 });
  });

  it("falls back to native Bash when UV is unavailable", async () => {
    const requested = { ...BUILTIN_RESOURCE_PROFILES.worker };
    const detected = await detectChildResources(requested, "/tmp/no-uv", new Map(), {
      contextModeAvailable: () => false,
      exists: () => true,
      probeRtk: async () => false,
      probeUv: async () => false,
    });
    const effective = effectiveAgentResources(requested, detected);
    const subject = managed(worker, effective);
    const paths = reviewedResourcePaths();
    expect(effective.uv).toBe(false);
    expect(childUtilityExtensions(subject)).not.toContain(paths.uv);
    expect(childPiArgs(subject)[childPiArgs(subject).indexOf("--tools") + 1]).toContain("bash");
  });

  it("keeps effective capability state separate from requested state", () => {
    const requested = { ...BUILTIN_RESOURCE_PROFILES.worker, webSearch: true };
    const detected = {
      contextMode: true,
      contextExecution: true,
      webSearch: false,
      todos: true,
      rtk: false,
      uv: true,
    };
    expect(effectiveAgentResources(requested, detected)).toMatchObject({
      contextMode: true,
      contextExecution: true,
      webSearch: false,
      todos: true,
      rtk: false,
      uv: true,
    });
    expect(childResourceWarnings(requested, detected)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("warning: Web Search unavailable"),
        expect.stringContaining("informational: RTK unavailable"),
      ]),
    );
  });

  it("builds exact default and all-effective child resources", () => {
    const paths = reviewedResourcePaths();
    const contextExtension = join(extensionDirectory(), "child-context-mode.ts");
    const rtkExtension = join(extensionDirectory(), "child-rtk.ts");
    const defaultExplorer = managed(explorer, {
      contextMode: false,
      contextExecution: false,
      webSearch: true,
      todos: false,
      rtk: false,
      uv: false,
    });
    const defaultWorker = managed(worker, {
      contextMode: false,
      contextExecution: false,
      webSearch: false,
      todos: true,
      rtk: false,
      uv: false,
    });
    const commonArgs = [
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--no-context-files",
      "--session-dir",
      "/tmp/subagent-session",
      "--name",
      "child",
      "--append-system-prompt",
      "/tmp/subagent-session/subagent-system-prompt.md",
    ];
    expect(childPiArgs(defaultExplorer)).toEqual([
      ...commonArgs,
      "--tools",
      "read,grep,find,ls,search",
      "--skill",
      paths.webSearchSkill,
      "--extension",
      paths.webSearch,
    ]);
    expect(childPiArgs(defaultWorker)).toEqual([
      ...commonArgs,
      "--tools",
      "read,grep,find,ls,todo,bash,edit,write",
      "--extension",
      paths.todos,
    ]);

    const all = managed(worker, {
      contextMode: true,
      contextExecution: true,
      webSearch: true,
      todos: true,
      rtk: true,
      uv: true,
    });
    expect(childUtilityExtensions(all)).toEqual([
      contextExtension,
      paths.todos,
      paths.webSearch,
      rtkExtension,
    ]);
    expect(childSkillPaths(all)).toEqual([paths.webSearchSkill]);
    const allTools = childPiArgs(all)[childPiArgs(all).indexOf("--tools") + 1]!;
    expect(allTools).toBe(
      "read,grep,find,ls,todo,bash,edit,write,ctx_execute_file,ctx_index,ctx_search,ctx_fetch_and_index,ctx_stats,ctx_execute,ctx_batch_execute,search",
    );
    expect(allTools.split(",").filter((tool) => tool === "bash")).toHaveLength(1);
    expect(childPiArgs(all)).toEqual([
      ...commonArgs,
      "--tools",
      allTools,
      "--skill",
      paths.webSearchSkill,
      "--extension",
      contextExtension,
      "--extension",
      paths.todos,
      "--extension",
      paths.webSearch,
      "--extension",
      rtkExtension,
    ]);
  });

  it("builds deterministic worker args and never adds execution tools to an explorer", () => {
    const resources = {
      contextMode: true,
      contextExecution: true,
      webSearch: true,
      todos: true,
      rtk: true,
      uv: true,
    };
    const workerArgs = childPiArgs(managed(worker, resources));
    const tools = workerArgs[workerArgs.indexOf("--tools") + 1];
    expect(tools).toContain("ctx_execute,ctx_batch_execute");
    expect(tools).toContain("search");
    expect(workerArgs.filter((arg) => arg === "--extension").length).toBe(4);
    const explorerArgs = childPiArgs(
      managed(explorer, {
        ...resources,
        contextExecution: false,
        todos: false,
        rtk: false,
        uv: false,
      }),
    );
    expect(explorerArgs[explorerArgs.indexOf("--tools") + 1]?.split(",")).not.toContain(
      "ctx_execute",
    );
    expect(explorerArgs[explorerArgs.indexOf("--tools") + 1]).not.toContain("bash");
  });

  it("composes RTK before UV and retains exactly one Bash owner", async () => {
    const order: string[] = [];
    const native = {
      exec: vi.fn(async (command: string) => {
        order.push(`native:${command}`);
        return { exitCode: 0 };
      }),
    };
    const operations = composeBashOperations(
      { rtk: true, uv: true },
      {
        native,
        rewrite: async (command) => {
          order.push(`rtk:${command}`);
          return "echo rewritten | sed -n '1p'";
        },
        validate: (command) => {
          order.push(`uv:${command}`);
          return undefined;
        },
        uvPrefix: () => "UV_PREFIX",
      },
    );
    await operations.exec("echo original", "/tmp", { onData: vi.fn() });
    expect(order).toEqual([
      "rtk:echo original",
      "uv:echo rewritten | sed -n '1p'",
      "native:UV_PREFIX\necho rewritten | sed -n '1p'",
    ]);
  });

  it("enforces the RTK minimum version boundary", () => {
    expect(isSupportedRtkVersion("rtk 0.22.9")).toBe(false);
    expect(isSupportedRtkVersion("rtk 0.23.0")).toBe(true);
    expect(isSupportedRtkVersion("rtk 1.0.0")).toBe(true);
    expect(isSupportedRtkVersion("rtk unavailable")).toBe(false);
  });

  it("forcefully terminates timeout children that ignore SIGTERM", async () => {
    const started = Date.now();
    await expect(
      runExecutable(
        process.execPath,
        ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 10)"],
        { timeoutMs: 100 },
      ),
    ).resolves.toMatchObject({ ok: false });
    expect(Date.now() - started).toBeGreaterThanOrEqual(TERMINATION_ESCALATION_MS - 20);
    expect(Date.now() - started).toBeLessThan(500);
  });

  it("bounds probes and fails open when RTK is disabled or unavailable", async () => {
    const command = "echo safe && echo '$HOME'";
    await expect(
      rewriteWithRtk(command, { cwd: process.cwd(), env: { RTK_DISABLED: "1" } }),
    ).resolves.toBe(command);
  });
});
