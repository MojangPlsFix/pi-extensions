import { describe, expect, it } from "vitest";
import { EXPLORER_TOOLS, MAX_ACTIVE, MAX_WORKERS, WORKER_TOOLS } from "../config.js";
import { childPrompt } from "../manager.js";
import { childEnvironment, childIsolationOverrides } from "../process.js";

describe("subagent boundaries", () => {
  it("keeps explorer resources read-only and worker concurrency bounded", () => {
    expect(EXPLORER_TOOLS).not.toEqual(expect.arrayContaining(["todo", "bash", "edit", "write"]));
    expect(WORKER_TOOLS).toEqual(expect.arrayContaining(["todo", "bash", "edit", "write"]));
    expect(MAX_ACTIVE).toBeGreaterThanOrEqual(MAX_WORKERS);
  });
  it("uses child-owned Todo and Context Mode paths without leaking parent state", () => {
    const contextDirectory = "/tmp/isolated-child";
    const overrides = childIsolationOverrides(contextDirectory);
    const environment = childEnvironment(contextDirectory);
    expect(overrides).toEqual({
      CONTEXT_MODE_DIR: "/tmp/isolated-child/context-mode",
      PI_TODO_PATH: "/tmp/isolated-child/todos",
    });
    expect(environment).toMatchObject(overrides);
    expect(environment.PI_TODO_PATH).not.toBe(process.env.PI_TODO_PATH);
  });
  it("uses a provider-neutral child prompt without excluded integrations", () => {
    const prompt = childPrompt({
      name: "explorer",
      description: "x",
      mode: "explorer",
      prompt: "Inspect",
      source: "builtin",
    });
    expect(prompt).toContain("isolated persistent Pi subagent");
    expect(prompt).toContain("Do not assume access to parent-only state");
  });
});
