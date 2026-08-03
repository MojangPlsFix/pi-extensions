import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadPlanModeConfig, updatePlanModeConfig, writePlanModeConfig } from "../config.js";

describe("Plan Mode configuration", () => {
  it("merges trusted project configuration and normalizes names", async () => {
    const root = await mkdtemp(join(tmpdir(), "plan-mode-"));
    const agent = join(root, "agent");
    const project = join(root, "project");
    process.env.PI_CODING_AGENT_DIR = agent;
    await writePlanModeConfig(join(agent, "plan-mode.json"), {
      readOnlyTools: ["functions.example_external_tool"],
      readOnlyCommands: { "example-cli": ["help"] },
    });
    await writePlanModeConfig(join(project, ".pi", "plan-mode.json"), {
      readOnlyTools: ["example_external_tool"],
      readOnlyCommands: { "example-cli": ["inspect"] },
    });
    const loaded = await loadPlanModeConfig({
      cwd: project,
      trusted: true,
      checkAvailability: false,
    });
    expect(loaded.readOnlyTools).toEqual(["example_external_tool"]);
    expect(loaded.readOnlyCommands["example-cli"]).toEqual(["help", "inspect"]);
    delete process.env.PI_CODING_AGENT_DIR;
    await rm(root, { recursive: true, force: true });
  });

  it("fails closed for malformed entries and preserves exact atomic output", async () => {
    const root = await mkdtemp(join(tmpdir(), "plan-mode-"));
    const path = join(root, "plan-mode.json");
    process.env.PI_CODING_AGENT_DIR = root;
    await writeFile(path, "{bad", "utf8");
    const loaded = await loadPlanModeConfig({
      cwd: root,
      trusted: false,
      checkAvailability: false,
    });
    expect(loaded.warnings).toHaveLength(1);
    await updatePlanModeConfig(path, { addTools: ["example_external_tool"] });
    expect(JSON.parse(await readFile(path, "utf8")).readOnlyTools).toEqual([
      "example_external_tool",
    ]);
    delete process.env.PI_CODING_AGENT_DIR;
    await rm(root, { recursive: true, force: true });
  });
});
