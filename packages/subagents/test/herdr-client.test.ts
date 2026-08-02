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
  it("verifies the control plane without creating a pane", async () => {
    const calls: string[][] = [];
    const client = new HerdrClient(async (args) => {
      calls.push(args);
      return { stdout: "ok", stderr: "" };
    });
    await client.verify("parent");
    expect(calls).toEqual([["pane", "current", "--pane", "parent"]]);
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
