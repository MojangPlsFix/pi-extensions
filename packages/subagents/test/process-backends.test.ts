import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NativeRunEvent } from "../native-backend.js";
import { ExternalProcessBackend } from "../process-backends.js";

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("ExternalProcessBackend", () => {
  it("does not spawn when startup is already cancelled", async () => {
    const sessionDir = await mkdtemp(join(tmpdir(), "subagent-external-"));
    temporary.push(sessionDir);
    const controller = new AbortController();
    controller.abort(new Error("parent closed"));
    const backend = new ExternalProcessBackend();
    await expect(
      backend.start(
        {
          id: "external-cancelled",
          cwd: sessionDir,
          sessionDir,
          task: "must not run",
          signal: controller.signal,
          runner: {
            command: process.execPath,
            args: ["-e", "process.exit(99)"],
            envAllowlist: [],
            timeoutMs: 5_000,
            maxOutputBytes: 10_000,
          },
        },
        () => {},
      ),
    ).rejects.toThrow("parent closed");
    expect(backend.has("external-cancelled")).toBe(false);
  });

  it("uses direct argv and closes stdin after the task without terminal input", async () => {
    const sessionDir = await mkdtemp(join(tmpdir(), "subagent-external-"));
    temporary.push(sessionDir);
    const backend = new ExternalProcessBackend();
    const events: NativeRunEvent[] = [];
    let settle: (() => void) | undefined;
    const settled = new Promise<void>((resolve) => {
      settle = resolve;
    });

    await backend.start(
      {
        id: "external-1",
        cwd: sessionDir,
        sessionDir,
        task: "sensitive task text",
        runner: {
          command: process.execPath,
          args: [
            "-e",
            "let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>process.stdout.write(JSON.stringify({argv:process.argv.slice(1),input:s})))",
          ],
          envAllowlist: [],
          timeoutMs: 5_000,
          maxOutputBytes: 10_000,
        },
      },
      (event) => {
        events.push(event);
        if (event.type === "settled") settle?.();
      },
    );
    await settled;

    const report = events.find((event) => event.type === "settled");
    expect(report).toMatchObject({ type: "settled" });
    if (report?.type !== "settled") throw new Error("Missing settled event.");
    expect(JSON.parse(report.report)).toEqual({ argv: [], input: "sensitive task text" });
    expect(report.report).not.toContain('argv":["sensitive task text"');
    await backend.shutdown();
  });

  it("terminates an accepted process when its parent cancellation signal fires", async () => {
    const sessionDir = await mkdtemp(join(tmpdir(), "subagent-external-"));
    temporary.push(sessionDir);
    const controller = new AbortController();
    const backend = new ExternalProcessBackend();
    await backend.start(
      {
        id: "external-active",
        cwd: sessionDir,
        sessionDir,
        task: "wait",
        signal: controller.signal,
        runner: {
          command: process.execPath,
          args: ["-e", "process.stdin.resume();setInterval(()=>{},1000)"],
          envAllowlist: [],
          timeoutMs: 5_000,
          maxOutputBytes: 10_000,
        },
      },
      () => {},
    );
    expect(backend.has("external-active")).toBe(true);
    controller.abort(new Error("parent closed"));
    await vi.waitFor(() => expect(backend.has("external-active")).toBe(false), { timeout: 5_000 });
  });
});
