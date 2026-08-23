import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NativeRunEvent } from "../native-backend.js";
import { ExternalProcessBackend, RpcProcessBackend } from "../process-backends.js";

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

  it("terminates the entire owned process group when parked", async () => {
    const sessionDir = await mkdtemp(join(tmpdir(), "subagent-external-group-"));
    temporary.push(sessionDir);
    const pidFile = join(sessionDir, "grandchild.pid");
    const backend = new ExternalProcessBackend();
    await backend.start(
      {
        id: "external-group",
        cwd: sessionDir,
        sessionDir,
        task: "wait",
        runner: {
          command: process.execPath,
          args: [
            "-e",
            `const {spawn}=require('node:child_process');const fs=require('node:fs');process.on('SIGINT',()=>{});process.on('SIGTERM',()=>{});const c=spawn(process.execPath,['-e',"process.on('SIGINT',()=>{});process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:'ignore'});fs.writeFileSync(${JSON.stringify(pidFile)},String(c.pid));setInterval(()=>{},1000)`,
          ],
          envAllowlist: [],
          timeoutMs: 20_000,
          maxOutputBytes: 10_000,
        },
      },
      () => {},
    );
    await vi.waitFor(async () => expect(await readFile(pidFile, "utf8")).toMatch(/^\d+$/u));
    const grandchildPid = Number(await readFile(pidFile, "utf8"));
    await Promise.all([backend.park("external-group"), backend.park("external-group")]);
    expect(backend.has("external-group")).toBe(false);
    expect(() => process.kill(grandchildPid, 0)).toThrow();
  }, 10_000);

  it("retains a wall stop without emitting a semantic timeout reason", async () => {
    const sessionDir = await mkdtemp(join(tmpdir(), "subagent-external-wall-"));
    temporary.push(sessionDir);
    const backend = new ExternalProcessBackend();
    const events: NativeRunEvent[] = [];
    await backend.start(
      {
        id: "external-wall",
        cwd: sessionDir,
        sessionDir,
        task: "wait",
        runner: {
          command: process.execPath,
          args: ["-e", "process.stdin.resume();setInterval(()=>{},1000)"],
          envAllowlist: [],
          timeoutMs: 10,
          maxOutputBytes: 10_000,
        },
      },
      (event) => events.push(event),
    );
    await vi.waitFor(() => expect(backend.has("external-wall")).toBe(false), { timeout: 5_000 });
    expect(events.filter((event) => event.type === "error")).toEqual([]);
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

describe("RpcProcessBackend", () => {
  it("fails closed before spawning when the parent prompt gate denies", async () => {
    const sessionDir = await mkdtemp(join(tmpdir(), "subagent-rpc-gate-"));
    temporary.push(sessionDir);
    const backend = new RpcProcessBackend();
    const gate = vi.fn(async () => false);
    await expect(
      backend.start(
        {
          id: "rpc-gated",
          cwd: sessionDir,
          sessionDir,
          task: "must not reach provider",
          systemPrompt: "system",
          tools: [],
          extensionPaths: [],
          skillPaths: [],
          preTurnGate: gate,
        },
        () => {},
      ),
    ).rejects.toThrow("pre-turn gate denied");
    expect(gate).toHaveBeenCalledWith(expect.objectContaining({ boundary: "rpc_parent_prompt" }));
    expect(backend.has("rpc-gated")).toBe(false);
  });

  it("cancels a delayed RPC session-path handshake and parks its process", async () => {
    const root = await mkdtemp(join(tmpdir(), "subagent-rpc-cancel-"));
    temporary.push(root);
    const executable = join(root, "pi");
    await writeFile(
      executable,
      `#!/usr/bin/env node\nconst rl=require('node:readline').createInterface({input:process.stdin});rl.on('line',(line)=>{const f=JSON.parse(line);if(f.type==='prompt')process.stdout.write(JSON.stringify({type:'response',id:f.id,success:true})+'\\n')});setInterval(()=>{},1000);\n`,
    );
    await chmod(executable, 0o755);
    const originalArgv1 = process.argv[1] ?? "";
    const originalPath = process.env.PATH;
    process.argv[1] = join(root, "not-a-real-script");
    process.env.PATH = `${root}:${originalPath ?? ""}`;
    const backend = new RpcProcessBackend();
    const controller = new AbortController();
    try {
      const started = backend.start(
        {
          id: "rpc-cancelled-path",
          cwd: root,
          sessionDir: join(root, "sessions"),
          task: "inspect",
          systemPrompt: "system",
          tools: [],
          extensionPaths: [],
          skillPaths: [],
          signal: controller.signal,
        },
        () => {},
      );
      await vi.waitFor(() => expect(backend.has("rpc-cancelled-path")).toBe(true));
      controller.abort(new Error("session path cancelled"));
      await expect(started).rejects.toThrow("session path cancelled");
      await vi.waitFor(() => expect(backend.has("rpc-cancelled-path")).toBe(false));
    } finally {
      process.argv[1] = originalArgv1;
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      await backend.shutdown();
    }
  }, 10_000);

  it("relays a child wall marker for manager-owned wall classification", async () => {
    const root = await mkdtemp(join(tmpdir(), "subagent-rpc-wall-marker-"));
    temporary.push(root);
    const executable = join(root, "pi");
    await writeFile(
      executable,
      `#!/usr/bin/env node\nconst fs=require('node:fs');const path=require('node:path');const args=process.argv.slice(2);const session=args[args.indexOf('--session-dir')+1];const rl=require('node:readline').createInterface({input:process.stdin});rl.on('line',(line)=>{const f=JSON.parse(line);if(f.type==='prompt')process.stdout.write(JSON.stringify({type:'response',id:f.id,success:true})+'\\n');if(f.type==='get_state'){process.stdout.write(JSON.stringify({type:'response',id:f.id,success:true,data:{sessionFile:path.join(session,'child.jsonl')}})+'\\n');fs.writeFileSync(path.join(session,'wall-limit.reached'),'wall_limit');process.stdout.write(JSON.stringify({type:'agent_settled'})+'\\n')}});setInterval(()=>{},1000);\n`,
    );
    await chmod(executable, 0o755);
    const originalArgv1 = process.argv[1] ?? "";
    const originalPath = process.env.PATH;
    process.argv[1] = join(root, "not-a-real-script");
    process.env.PATH = `${root}:${originalPath ?? ""}`;
    const backend = new RpcProcessBackend();
    const events: NativeRunEvent[] = [];
    try {
      await backend.start(
        {
          id: "rpc-wall-marker",
          cwd: root,
          sessionDir: join(root, "sessions"),
          task: "inspect",
          systemPrompt: "system",
          tools: [],
          extensionPaths: [],
          skillPaths: [],
          deadlineAtMs: Date.now() + 60_000,
        },
        (event) => events.push(event),
      );
      await vi.waitFor(() => expect(events).toContainEqual({ type: "deadline_reached" }));
      expect(events.some((event) => event.type === "settled")).toBe(false);
      await backend.park("rpc-wall-marker");
    } finally {
      process.argv[1] = originalArgv1;
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      await backend.shutdown();
    }
  }, 10_000);

  it("does not resolve startup until delayed RPC session state is observed", async () => {
    const root = await mkdtemp(join(tmpdir(), "subagent-rpc-path-"));
    temporary.push(root);
    const executable = join(root, "pi");
    await writeFile(
      executable,
      `#!/usr/bin/env node\nconst rl=require('node:readline').createInterface({input:process.stdin});rl.on('line',(line)=>{const f=JSON.parse(line);if(f.type==='prompt')process.stdout.write(JSON.stringify({type:'response',id:f.id,success:true})+'\\n');if(f.type==='get_state')setTimeout(()=>process.stdout.write(JSON.stringify({type:'response',id:f.id,success:true,data:{sessionFile:'/tmp/delayed.jsonl'}})+'\\n'),60)});setInterval(()=>{},1000);\n`,
    );
    await chmod(executable, 0o755);
    const originalArgv1 = process.argv[1] ?? "";
    const originalPath = process.env.PATH;
    process.argv[1] = join(root, "not-a-real-script");
    process.env.PATH = `${root}:${originalPath ?? ""}`;
    const backend = new RpcProcessBackend();
    const events: NativeRunEvent[] = [];
    try {
      const startedAt = Date.now();
      await backend.start(
        {
          id: "rpc-path",
          cwd: root,
          sessionDir: join(root, "sessions"),
          task: "inspect",
          systemPrompt: "system",
          tools: [],
          extensionPaths: [],
          skillPaths: [],
          initialCompletedTurns: 2,
          maxTurns: 5,
          deadlineAtMs: 4_102_444_800_000,
        },
        (event) => events.push(event),
      );
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(40);
      const gate = await readFile(join(root, "sessions", "runtime-gate.ts"), "utf8");
      expect(gate).toContain('pi.on("before_provider_request"');
      expect(gate).toContain("Date.now() < 4102444800000");
      expect(gate).toContain("let completed = 2");
      expect(gate).toContain("completed < 5");
      expect(events).toEqual([
        { type: "session", sessionFile: "/tmp/delayed.jsonl" },
        { type: "accepted" },
      ]);
      await backend.park("rpc-path");
    } finally {
      process.argv[1] = originalArgv1;
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      await backend.shutdown();
    }
  }, 10_000);
});
