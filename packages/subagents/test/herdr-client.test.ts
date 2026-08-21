import { describe, expect, it, vi } from "vitest";
import { HerdrClient, type HerdrExec } from "../herdr-client.js";

describe("display-only Herdr client", () => {
  it("distinguishes absent, incomplete, and complete environments", () => {
    expect(HerdrClient.environmentState({})).toBe("absent");
    expect(HerdrClient.environmentState({ HERDR_ENV: "1" })).toBe("incomplete");
    expect(
      HerdrClient.environmentState({
        HERDR_ENV: "1",
        HERDR_PANE_ID: "pane-parent",
        HERDR_SOCKET_PATH: "/tmp/herdr.sock",
      }),
    ).toBe("complete");
  });

  it("verifies the parent and creates only a raw non-focused pane", async () => {
    const run = vi.fn<HerdrExec>(async (args) => {
      if (args[0] === "pane" && args[1] === "current")
        return {
          stdout: JSON.stringify({
            result: {
              pane: {
                pane_id: "pane-parent",
                tab_id: "tab-parent",
                workspace_id: "workspace-parent",
              },
            },
          }),
          stderr: "",
        };
      if (args[0] === "pane" && args[1] === "split")
        return {
          stdout: JSON.stringify({ result: { pane: { pane_id: "pane-inspector" } } }),
          stderr: "",
        };
      return { stdout: "", stderr: "" };
    });
    const client = new HerdrClient(run);

    await expect(client.verify("pane-parent")).resolves.toEqual({
      paneId: "pane-parent",
      tabId: "tab-parent",
      workspaceId: "workspace-parent",
    });
    await expect(client.splitCurrent("right", "/repo", false)).resolves.toBe("pane-inspector");
    await client.runInPane("pane-inspector", "node inspector.mjs transcript.jsonl");
    await client.close("pane-inspector");

    expect(run.mock.calls).toEqual([
      [["pane", "current", "--pane", "pane-parent"], 5_000],
      [["pane", "split", "--current", "--direction", "right", "--cwd", "/repo", "--no-focus"]],
      [["pane", "run", "pane-inspector", "node inspector.mjs transcript.jsonl"], 15_000],
      [["pane", "close", "pane-inspector"], 10_000],
    ]);
  });

  it("rejects malformed control-plane identity", async () => {
    const client = new HerdrClient(async () => ({ stdout: "{}", stderr: "" }));
    await expect(client.verify("pane-parent")).rejects.toThrow(/parent pane context/);
  });
});
