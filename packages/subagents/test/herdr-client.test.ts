import { describe, expect, it } from "vitest";
import { HerdrClient } from "../herdr-client.js";

describe("Herdr capability checks", () => {
  it("distinguishes absent, incomplete, and complete environments", () => {
    expect(HerdrClient.environmentState({})).toBe("absent");
    expect(HerdrClient.environmentState({ HERDR_ENV: "1" })).toBe("incomplete");
    expect(
      HerdrClient.environmentState({
        HERDR_ENV: "1",
        HERDR_PANE_ID: "pane",
        HERDR_SOCKET_PATH: "/tmp/control",
      }),
    ).toBe("complete");
  });
  it("passes only reviewed isolation overrides to Herdr pane creation", async () => {
    const calls: string[][] = [];
    process.env.FAKE_SECRET = "must-not-reach-herdr-arguments";
    const client = new HerdrClient(async (args) => {
      calls.push(args);
      return { stdout: '{"result":{"pane":{"pane_id":"child"}}}', stderr: "" };
    });
    await client.split("parent", "right", "/project", {
      CONTEXT_MODE_DIR: "/tmp/child/context-mode",
      PI_TODO_PATH: "/tmp/child/todos",
    });
    const command = calls[0]!.join(" ");
    expect(command).toContain("--env CONTEXT_MODE_DIR=/tmp/child/context-mode");
    expect(command).toContain("--env PI_TODO_PATH=/tmp/child/todos");
    expect(command).not.toContain("FAKE_SECRET");
    expect(command).not.toContain("must-not-reach-herdr-arguments");
    delete process.env.FAKE_SECRET;
  });
  it("reads the parent pane context and parent tab label", async () => {
    const calls: string[][] = [];
    const client = new HerdrClient(async (args) => {
      calls.push(args);
      return {
        stdout:
          args[0] === "pane"
            ? '{"result":{"pane":{"pane_id":"pane-parent","tab_id":"workspace:t1","workspace_id":"workspace"}}}'
            : '{"result":{"tab":{"tab_id":"workspace:t1","workspace_id":"workspace","label":"Orchestrator"}}}',
        stderr: "",
      };
    });

    await expect(client.verify("pane-parent")).resolves.toEqual({
      paneId: "pane-parent",
      tabId: "workspace:t1",
      workspaceId: "workspace",
    });
    await expect(client.getTab("workspace:t1")).resolves.toEqual({
      tabId: "workspace:t1",
      workspaceId: "workspace",
      label: "Orchestrator",
    });
    expect(calls).toEqual([
      ["pane", "current", "--pane", "pane-parent"],
      ["tab", "get", "workspace:t1"],
    ]);
  });
  it("creates a non-focused workspace-bound tab and returns its root pane", async () => {
    const calls: string[][] = [];
    const client = new HerdrClient(async (args) => {
      calls.push(args);
      return {
        stdout:
          '{"result":{"type":"tab_created","tab":{"tab_id":"tab-1"},"root_pane":{"pane_id":"root-1"}}}',
        stderr: "",
      };
    });

    await expect(
      client.createTab("Orchestrator - Subagents", "/work/project", "workspace", { CHILD: "yes" }),
    ).resolves.toEqual({
      tabId: "tab-1",
      paneId: "root-1",
    });
    expect(calls[0]).toEqual([
      "tab",
      "create",
      "--workspace",
      "workspace",
      "--label",
      "Orchestrator - Subagents",
      "--cwd",
      "/work/project",
      "--env",
      "CHILD=yes",
      "--no-focus",
    ]);
  });
  it("parses geometry-rich pane layout snapshots", async () => {
    const calls: string[][] = [];
    const client = new HerdrClient(async (args) => {
      calls.push(args);
      return {
        stdout:
          '{"result":{"type":"pane_layout","layout":{"tab_id":"tab-1","panes":[{"pane_id":"one","rect":{"x":0,"y":0,"width":120,"height":40}}]}}}',
        stderr: "",
      };
    });

    await expect(client.layout("one")).resolves.toEqual({
      tabId: "tab-1",
      panes: [{ paneId: "one", rect: { x: 0, y: 0, width: 120, height: 40 } }],
    });
    expect(calls).toEqual([["pane", "layout", "--pane", "one"]]);
  });
  it("reports bounded display metadata and focuses the canonical target", async () => {
    const calls: string[][] = [];
    const client = new HerdrClient(async (args) => {
      calls.push(args);
      return { stdout: "ok", stderr: "" };
    });

    await client.reportMetadata("pane-1", {
      agent: "internal-a",
      title: "Inspect parser",
      displayRole: "explorer",
      stateLabels: { working: "Exploring" },
      tokens: { role: "explorer", model: "provider/model" },
      seq: 3,
    });
    await client.focus("pane-1");

    expect(calls[0]).toEqual([
      "pane",
      "report-metadata",
      "pane-1",
      "--source",
      "pi-subagents",
      "--agent",
      "internal-a",
      "--title",
      "Inspect parser",
      "--display-agent",
      "explorer",
      "--state-label",
      "working=Exploring",
      "--token",
      "role=explorer",
      "--token",
      "model=provider/model",
      "--seq",
      "3",
    ]);
    expect(calls[1]).toEqual(["agent", "focus", "pane-1"]);
  });
  it("rejects a parent pane response without workspace identity", async () => {
    const client = new HerdrClient(async () => ({
      stdout: '{"result":{"pane":{"pane_id":"parent","tab_id":"workspace:t1"}}}',
      stderr: "",
    }));
    await expect(client.verify("parent")).rejects.toThrow("parent pane context");
  });
  it("retries agent start while a freshly split pane is not yet an available shell", async () => {
    let attempts = 0;
    const delays: number[] = [];
    const client = new HerdrClient(
      async () => {
        attempts += 1;
        if (attempts === 1) {
          throw Object.assign(new Error("Herdr command failed"), {
            stderr:
              '{"error":{"code":"agent_pane_busy","message":"agent target pane child is not an available shell"}}',
          });
        }
        return { stdout: "ok", stderr: "" };
      },
      async (ms) => {
        delays.push(ms);
      },
    );

    await client.start("explorer-a", "child", ["--no-extensions"]);

    expect(attempts).toBe(2);
    expect(delays).toEqual([100]);
  });
});
