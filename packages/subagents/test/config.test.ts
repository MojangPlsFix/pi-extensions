import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LEGACY_SESSION_ROOT,
  loadSubagentConfig,
  resolveAgentModelPolicy,
  SESSION_ROOT,
} from "../config.js";
import { SubagentManager } from "../manager.js";
import type { AgentDefinition } from "../types.js";

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const custom: AgentDefinition = {
  name: "reviewer",
  description: "review",
  mode: "explorer",
  model: "frontmatter/model",
  thinking: "high",
  prompt: "review",
  source: "user",
};

describe("Subagent model configuration", () => {
  it("resolves per-agent, frontmatter, defaults, then parent with explicit inheritance", () => {
    expect(
      resolveAgentModelPolicy(
        custom,
        {
          defaults: { model: "defaults/model", thinking: "low" },
          agents: { reviewer: { model: "agent/model", thinking: "off" } },
        },
        "parent/model",
        "medium",
      ),
    ).toEqual({ model: "agent/model", thinking: "off" });

    expect(
      resolveAgentModelPolicy(
        custom,
        { agents: { reviewer: { model: "inherit", thinking: "inherit" } } },
        "parent/model",
        "medium",
      ),
    ).toEqual({ model: "parent/model", thinking: "medium" });

    expect(resolveAgentModelPolicy(custom, {}, "parent/model", "medium")).toEqual({
      model: "frontmatter/model",
      thinking: "high",
    });
  });

  it("loads valid JSON and rejects malformed policy before spawn allocation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "subagent-config-"));
    temporary.push(directory);
    const path = join(directory, "config.json");
    await writeFile(path, '{"agents":{"explorer":{"model":"provider/model","thinking":"off"}}}');
    await expect(loadSubagentConfig(path)).resolves.toMatchObject({
      agents: { explorer: { model: "provider/model", thinking: "off" } },
    });
    await writeFile(path, '{"defaults":{"thinking":"impossible"}}');
    await expect(loadSubagentConfig(path)).rejects.toThrow("not a supported thinking level");
  });

  it("preflights model existence and authentication", async () => {
    const pi = {
      events: { on: vi.fn(), emit: vi.fn() },
      sendMessage: vi.fn(),
    } as never;
    const manager = new SubagentManager(pi);
    const model = { provider: "provider", id: "model" };
    const registry = {
      refresh: vi.fn(async () => {}),
      find: vi.fn((): typeof model | undefined => model),
      getAll: vi.fn(() => [model]),
      getApiKeyAndHeaders: vi.fn(async () => ({ ok: true, apiKey: "secret" })),
    };
    const preflight = (
      manager as unknown as {
        preflightModel(name: string | undefined, ctx: unknown): Promise<void>;
      }
    ).preflightModel.bind(manager);
    await expect(preflight("provider/model", { modelRegistry: registry })).resolves.toBeUndefined();
    expect(registry.refresh).toHaveBeenCalledBefore(registry.find);
    expect(registry.getApiKeyAndHeaders).toHaveBeenCalledWith(model);

    registry.find.mockReturnValueOnce(undefined);
    await expect(preflight("provider/missing", { modelRegistry: registry })).rejects.toThrow(
      "unavailable",
    );
    registry.getApiKeyAndHeaders.mockResolvedValueOnce({
      ok: false,
      error: "login required",
    } as never);
    await expect(preflight("provider/model", { modelRegistry: registry })).rejects.toThrow(
      "not authenticated",
    );
  });

  it("stores new transcripts outside normal sessions while retaining a legacy root", () => {
    expect(SESSION_ROOT.split(/[\\/]/u).slice(-2)).toEqual(["subagents", "sessions"]);
    expect(LEGACY_SESSION_ROOT.split(/[\\/]/u).slice(-2)).toEqual(["sessions", "subagents"]);
    expect(SESSION_ROOT).not.toBe(LEGACY_SESSION_ROOT);
  });
});
