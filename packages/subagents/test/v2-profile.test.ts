import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BUILTIN_PROFILES,
  discoverAgents,
  ejectBuiltinProfile,
  parseFrontmatter,
} from "../agents.js";
import {
  capabilityCeilingDiagnostics,
  matchesExecutableArgvPrefix,
  matchesToolPattern,
  selectEffectiveCapabilities,
  validateCapabilityDefinition,
} from "../capabilities.js";
import {
  loadSubagentConfig,
  MAX_ACTIVE,
  MAX_DEPTH,
  MAX_SHARED_WRITERS,
  updateProfileControl,
} from "../config.js";

const temporary: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("Subagents v2 profiles", () => {
  it("ships the six visible built-ins and hidden plan reviewer", () => {
    expect(BUILTIN_PROFILES.map((profile) => profile.name)).toEqual([
      "scout",
      "researcher",
      "worker",
      "reviewer",
      "oracle",
      "orchestrator",
      "plan-reviewer",
    ]);
    expect(BUILTIN_PROFILES.find((profile) => profile.name === "plan-reviewer")).toMatchObject({
      hidden: true,
      class: "review",
    });
    expect(BUILTIN_PROFILES.find((profile) => profile.name === "researcher")?.tools).toContain(
      "search",
    );
    expect(
      Object.fromEntries(
        BUILTIN_PROFILES.map(({ name, timeout, turnBudget }) => [name, { timeout, turnBudget }]),
      ),
    ).toEqual({
      scout: { timeout: 600, turnBudget: 60 },
      researcher: { timeout: 1800, turnBudget: 64 },
      worker: { timeout: 1800, turnBudget: 110 },
      reviewer: { timeout: 2100, turnBudget: 40 },
      oracle: { timeout: 2100, turnBudget: 72 },
      orchestrator: { timeout: 2700, turnBudget: 128 },
      "plan-reviewer": { timeout: 2100, turnBudget: 40 },
    });
  });

  it("parses the v2 profile fields and rejects legacy schema keys", () => {
    const profile = parseFrontmatter(
      `---
schemaVersion: 2
name: Careful Orchestrator
description: An orchestrator
class: orchestrator
runner: rpc
tools:
  - read
  - grep
capabilities: [git]
skills: [testing]
defaultContext: decisions
allowedNestedProfiles: [review]
maxDepth: 1
workspace: shared
timeout: 30
turnBudget: 4
tokenBudget: 1000
costBudget: 2.5
infer: true
hidden: false
---
Do the work.`,
      "/profiles/careful.md",
    );
    expect(profile).toMatchObject({
      name: "careful-orchestrator",
      class: "orchestrator",
      runner: "rpc",
      tools: ["read", "grep"],
      maxDepth: 1,
      timeout: 30,
      turnBudget: 4,
      infer: true,
    });
    expect(
      parseFrontmatter(
        "---\nschemaVersion: 1\nname: old\ndescription: old\nmode: worker\n---\nx",
        "/profiles/old.md",
      ),
    ).toBeUndefined();
    expect(
      parseFrontmatter(
        "---\nschemaVersion: 2\nname: alias\ndescription: alias\nclass: read\ndefault-context: fresh\n---\nx",
        "/profiles/alias.md",
      ),
    ).toBeUndefined();
    expect(
      parseFrontmatter(
        "---\nschemaVersion: 2\nname: unsafe\ndescription: unsafe\nclass: read\ntools: [jira_delete]\n---\nx",
        "/profiles/unsafe.md",
      ),
    ).toBeUndefined();
  });

  it("discovers trusted project overrides and reports malformed and duplicate paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "subagents-v2-"));
    temporary.push(root);
    const user = join(root, "user");
    const project = join(root, ".pi", "agents");
    await (await import("node:fs/promises")).mkdir(project, { recursive: true });
    await (await import("node:fs/promises")).mkdir(user, { recursive: true });
    await writeFile(
      join(user, "scout.md"),
      "---\nschemaVersion: 2\nname: scout\ndescription: user\nclass: read\n---\nuser",
    );
    await writeFile(
      join(project, "scout.md"),
      "---\nschemaVersion: 2\nname: scout\ndescription: project\nclass: review\n---\nproject",
    );
    await writeFile(join(project, "bad.md"), "not frontmatter");
    const untrusted = await discoverAgents({
      cwd: root,
      userDir: user,
      piConfigDir: ".pi",
      trustedProject: false,
    });
    expect(untrusted.profiles.find((profile) => profile.name === "scout")?.description).toBe(
      "user",
    );
    const trusted = await discoverAgents({
      cwd: root,
      userDir: user,
      piConfigDir: ".pi",
      trustedProject: true,
    });
    expect(trusted.profiles.find((profile) => profile.name === "scout")?.description).toBe(
      "project",
    );
    expect(trusted.diagnostics.some((diagnostic) => diagnostic.path.endsWith("bad.md"))).toBe(true);
    expect(
      trusted.diagnostics.some(
        (diagnostic) => diagnostic.code === "duplicate" && diagnostic.path.endsWith("scout.md"),
      ),
    ).toBe(true);
  });

  it("matches capability patterns as complete names and reports unknown selections", () => {
    expect(matchesToolPattern("git-status", "git-*")).toBe(true);
    expect(matchesToolPattern("prefix-git-status", "git-*")).toBe(false);
    expect(matchesExecutableArgvPrefix(["git", "status", "--short"], ["git", "status"])).toBe(true);
    expect(matchesExecutableArgvPrefix(["git-status", "--short"], ["git", "status"])).toBe(false);
    const policy = selectEffectiveCapabilities(["git", "missing"], {
      git: { name: "git", toolPatterns: ["git-*"], state: "shared-read", approval: "ask" },
    });
    expect(policy.tools).toEqual(["git-*"]);
    expect(policy.diagnostics[0]?.code).toBe("unknown");
    const deniedForScout = selectEffectiveCapabilities(["mutating"], {
      mutating: {
        name: "mutating",
        toolPatterns: ["bash"],
        state: "shared-write",
        approval: "ask",
      },
    });
    expect(
      capabilityCeilingDiagnostics(BUILTIN_PROFILES[0]!, deniedForScout).map(
        (diagnostic) => diagnostic.message,
      ),
    ).toEqual([
      expect.stringContaining("mutating tools"),
      expect.stringContaining("shared-write"),
      expect.stringContaining("Read-only workspace"),
    ]);
    expect(() =>
      validateCapabilityDefinition(
        { name: "project", extensionPath: "/tmp/x", state: "isolated", approval: "allow" },
        "capabilities.project",
        { source: "project" },
      ),
    ).toThrow(/may not define/);
  });

  it("ejects built-ins without overwriting and persists enable metadata", async () => {
    const root = await mkdtemp(join(tmpdir(), "subagents-v2-controls-"));
    temporary.push(root);
    const agents = join(root, "agents");
    const configPath = join(root, "config.json");
    const path = await ejectBuiltinProfile("scout", agents);
    expect(
      parseFrontmatter(await (await import("node:fs/promises")).readFile(path, "utf8"), path),
    ).toMatchObject({
      name: "scout",
      schemaVersion: 2,
      timeout: 600,
      turnBudget: 60,
    });
    await expect(ejectBuiltinProfile("scout", agents)).rejects.toThrow(/already exists/);
    await updateProfileControl("scout", { disabled: true, ejected: true }, configPath);
    await expect(loadSubagentConfig(configPath)).resolves.toMatchObject({
      profiles: { scout: { enabled: false, disabled: true, ejected: true } },
    });
    await writeFile(
      configPath,
      JSON.stringify({
        schemaVersion: 2,
        profiles: { scout: { enabled: true, disabled: true } },
      }),
    );
    await expect(loadSubagentConfig(configPath)).rejects.toThrow(/must describe the same state/);
  });

  it("auto-enables Herdr from a complete environment unless explicitly disabled", async () => {
    const root = await mkdtemp(join(tmpdir(), "subagents-v2-herdr-"));
    temporary.push(root);
    const path = join(root, "config.json");
    vi.stubEnv("HERDR_ENV", "1");
    vi.stubEnv("HERDR_PANE_ID", "parent-pane");
    vi.stubEnv("HERDR_SOCKET_PATH", "/tmp/herdr.sock");
    await writeFile(path, JSON.stringify({ schemaVersion: 2, herdr: { direction: "right" } }));
    await expect(loadSubagentConfig(path)).resolves.toMatchObject({ herdr: { enabled: true } });
    await writeFile(path, JSON.stringify({ schemaVersion: 2, herdr: { enabled: false } }));
    await expect(loadSubagentConfig(path)).resolves.toMatchObject({ herdr: { enabled: false } });
  });

  it("loads v2 runtime ceilings and retention defaults", async () => {
    const root = await mkdtemp(join(tmpdir(), "subagents-v2-config-"));
    temporary.push(root);
    const path = join(root, "config.json");
    const firstDefault = await loadSubagentConfig(join(root, "missing.json"));
    firstDefault.runtime.maxTurns = 1;
    await expect(loadSubagentConfig(join(root, "missing.json"))).resolves.toMatchObject({
      runtime: { maxTurns: 128 },
    });
    await writeFile(
      path,
      JSON.stringify({
        schemaVersion: 2,
        runtime: { maxActive: MAX_ACTIVE },
        retention: { days: 30, entries: 200 },
        models: {
          default: { model: "provider/default", thinking: "low" },
          overrides: { reviewer: { model: "provider/review", thinking: "high" } },
        },
        runners: {
          cli: {
            command: "example-cli",
            args: ["review"],
            envAllowlist: ["EXAMPLE_TOKEN"],
            timeoutMs: 1000,
            maxOutputBytes: 2048,
          },
        },
        herdr: { enabled: true, direction: "down", maxOutputBytes: 4096 },
        profiles: { scout: { disabled: true, note: "local preference" } },
      }),
    );
    const config = await loadSubagentConfig(path);
    expect(config.runtime).toEqual({
      maxActive: MAX_ACTIVE,
      maxSharedWriters: MAX_SHARED_WRITERS,
      maxDepth: MAX_DEPTH,
      maxWallSeconds: 2700,
      maxTurns: 128,
      wrapUpRatio: 0.8,
    });
    expect(config.models.overrides.reviewer).toEqual({
      model: "provider/review",
      thinking: "high",
    });
    expect(config.runners.cli).toMatchObject({ command: "example-cli", timeoutMs: 1000 });
    expect(config.herdr).toEqual({ enabled: true, direction: "down", maxOutputBytes: 4096 });
    expect(config.profiles.scout).toMatchObject({ disabled: true });
    await writeFile(
      path,
      JSON.stringify({ schemaVersion: 2, runtime: { maxDepth: MAX_DEPTH + 1 } }),
    );
    await expect(loadSubagentConfig(path)).rejects.toThrow(/runtime.maxDepth/);
    for (const runtime of [
      { wrapUpRatio: 0 },
      { wrapUpRatio: 1 },
      { wrapUpRatio: null },
      { maxWallSeconds: 2701 },
      { maxWallSeconds: 0 },
      { maxWallSeconds: null },
      { maxTurns: 129 },
      { maxTurns: 0 },
      { maxTurns: null },
    ]) {
      await writeFile(path, JSON.stringify({ schemaVersion: 2, runtime }));
      await expect(loadSubagentConfig(path)).rejects.toThrow(
        /runtime\.(wrapUpRatio|maxWallSeconds|maxTurns)/,
      );
    }
    await writeFile(
      path,
      JSON.stringify({
        schemaVersion: 2,
        runtime: { maxWallSeconds: 600, maxTurns: 50, wrapUpRatio: 0.5 },
      }),
    );
    await expect(loadSubagentConfig(path)).resolves.toMatchObject({
      runtime: { maxWallSeconds: 600, maxTurns: 50, wrapUpRatio: 0.5 },
    });
    await writeFile(path, JSON.stringify({ schemaVersion: 2, runtime: { maxTurn: 50 } }));
    await expect(loadSubagentConfig(path)).rejects.toThrow(/runtime.maxTurn is not supported/);
    await writeFile(
      path,
      JSON.stringify({ schemaVersion: 2, agents: { worker: { model: "old" } } }),
    );
    await expect(loadSubagentConfig(path)).rejects.toThrow(/agents is not supported/);
  });
});
