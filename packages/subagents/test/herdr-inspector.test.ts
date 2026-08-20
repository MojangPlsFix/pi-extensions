import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HerdrInspectorManager } from "../herdr-inspector.js";

const previous = {
  HERDR_ENV: process.env.HERDR_ENV,
  HERDR_PANE_ID: process.env.HERDR_PANE_ID,
  HERDR_SOCKET_PATH: process.env.HERDR_SOCKET_PATH,
};
const cleanup: string[] = [];

afterEach(async () => {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const path of cleanup.splice(0)) await fs.rm(path, { recursive: true, force: true });
});

describe("HerdrInspectorManager", () => {
  it("opens only a display command and closes the owned pane", async () => {
    process.env.HERDR_ENV = "1";
    process.env.HERDR_PANE_ID = "parent-pane";
    process.env.HERDR_SOCKET_PATH = "/tmp/herdr.sock";
    const dir = await fs.mkdtemp(join(tmpdir(), "subagent-inspector-"));
    cleanup.push(dir);
    const sessionFile = join(dir, "session.jsonl");
    await fs.writeFile(sessionFile, "");
    const client = {
      verify: vi.fn(async (_pane: string) => ({
        paneId: "parent-pane",
        tabId: "tab",
        workspaceId: "ws",
      })),
      splitCurrent: vi.fn(
        async (_direction: "right" | "down", _cwd: string, _focus: boolean) => "inspector-pane",
      ),
      runInPane: vi.fn(async (_pane: string, _command: string) => {}),
      close: vi.fn(async (_pane: string) => {}),
    };
    const inspectors = new HerdrInspectorManager(client);
    const binding = await inspectors.open("run-1", sessionFile, dir);
    expect(binding.paneId).toBe("inspector-pane");
    expect(client.splitCurrent).toHaveBeenCalledWith("right", dir, false);
    expect(client.runInPane).toHaveBeenCalledOnce();
    const command = client.runInPane.mock.calls[0]?.[1] ?? "";
    expect(command).toContain("inspector-runner.mjs");
    expect(command).toContain(sessionFile);
    expect(command).not.toContain("pi --mode");
    expect(command).not.toContain("herdr agent");
    await inspectors.close("run-1");
    expect(client.close).toHaveBeenCalledWith("inspector-pane");
  });

  it("closes every owned transcript pane during parent shutdown", async () => {
    process.env.HERDR_ENV = "1";
    process.env.HERDR_PANE_ID = "parent-pane";
    process.env.HERDR_SOCKET_PATH = "/tmp/herdr.sock";
    const dir = await fs.mkdtemp(join(tmpdir(), "subagent-inspector-"));
    cleanup.push(dir);
    const sessionFile = join(dir, "session.jsonl");
    await fs.writeFile(sessionFile, "");
    const client = {
      verify: vi.fn(async () => ({
        paneId: "parent-pane",
        tabId: "tab",
        workspaceId: "ws",
      })),
      splitCurrent: vi
        .fn()
        .mockResolvedValueOnce("inspector-one")
        .mockResolvedValueOnce("inspector-two"),
      runInPane: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    };
    const inspectors = new HerdrInspectorManager(client);
    await inspectors.open("run-1", sessionFile, dir);
    await inspectors.open("run-2", sessionFile, dir);

    await inspectors.shutdown();

    expect(client.close).toHaveBeenCalledWith("inspector-one");
    expect(client.close).toHaveBeenCalledWith("inspector-two");
    expect(inspectors.all()).toEqual([]);
  });

  it("does not allocate a pane when Herdr is absent", async () => {
    delete process.env.HERDR_ENV;
    delete process.env.HERDR_PANE_ID;
    delete process.env.HERDR_SOCKET_PATH;
    const client = {
      verify: vi.fn(),
      splitCurrent: vi.fn(),
      runInPane: vi.fn(),
      close: vi.fn(),
    };
    const inspectors = new HerdrInspectorManager(client);
    await expect(inspectors.open("run-1", "/missing", process.cwd())).rejects.toThrow(
      "Herdr is unavailable",
    );
    expect(client.splitCurrent).not.toHaveBeenCalled();
  });
});
