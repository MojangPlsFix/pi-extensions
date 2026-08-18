import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import contextMode, {
  BRIDGED_TOOLS,
  ContextAbortError,
  compactBridgeSchema,
  createContextCallRenderer,
  createContextResultRenderer,
  ExternalContextBridge,
  indexIntentOutput,
  NativeContextRunner,
  nativeBatchExecution,
  nativeExecution,
  renderContextResult,
  resolveNodeRuntime,
  sanitizeExecutionEnv,
  shellRuntime,
  shellScriptExtension,
} from "../index.js";
import {
  normalizeLifecycleToolResult,
  ROUTING_ANCHOR,
  sanitizeInjectedRouting,
} from "../lifecycle.js";
import { enforceExecutionPolicy, resetSecurityModuleForTests } from "../security.js";
import type { ContextDetails } from "../types.js";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  resetSecurityModuleForTests();
  vi.unstubAllEnvs();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function fakeSecurityRuntime(directory: string, deny = false): Promise<void> {
  const build = join(directory, "build");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(build, { recursive: true }));
  await writeFile(join(directory, "server.bundle.mjs"), "", "utf8");
  await writeFile(
    join(directory, "package.json"),
    JSON.stringify({ version: "1.0.169", type: "module" }),
    "utf8",
  );
  await writeFile(
    join(build, "security.js"),
    `export const readBashPolicies=()=>[];
export const evaluateCommandDenyOnly=(command)=>({decision:${deny ? "command.includes('blocked')?'deny':'allow'" : "'allow'"},matchedPattern:${deny ? "command.includes('blocked')?'blocked *':undefined" : "undefined"}});
export const extractShellCommands=(code)=>code.includes('blocked')?[code]:[];
export const readToolDenyPatterns=()=>[];
export const evaluateFilePath=(path)=>({denied:${deny ? "path.includes('secret')" : "false"},matchedPattern:${deny ? "path.includes('secret')?'**/secret*':undefined" : "undefined"}});\n`,
    "utf8",
  );
  vi.stubEnv("PI_CONTEXT_MODE_DIR", directory);
  resetSecurityModuleForTests();
}

function theme(): Theme {
  return {
    fg: (_color, value) => value,
    bg: (_color, value) => value,
    bold: (value) => value,
    italic: (value) => value,
    strikethrough: (value) => value,
  } as Theme;
}

function registry(existingTools: string[] = []) {
  const tools: Array<Record<string, unknown>> = [];
  const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
  const events = new Map<string, (...args: unknown[]) => unknown>();
  const warnings: string[] = [];
  const api = {
    registerTool(tool: Record<string, unknown>) {
      tools.push(tool);
      handlers.set(tool.name as string, tool.execute as (...args: unknown[]) => Promise<unknown>);
    },
    registerCommand() {},
    on(name: string, handler: (...args: unknown[]) => unknown) {
      events.set(name, handler);
    },
    getAllTools() {
      return existingTools.map((name) => ({ name }));
    },
    logger: {
      warn(message: string) {
        warnings.push(message);
      },
    },
  };
  contextMode(api as never);
  return { tools, handlers, events, warnings };
}

describe("Context Mode Pi ownership", () => {
  it("uses concise local bridge descriptions and keeps schema validation fields", () => {
    const schema = compactBridgeSchema({
      type: "object",
      description: "very long upstream prose",
      properties: {
        query: { type: "string", minLength: 1, description: "more upstream prose" },
      },
      required: ["query"],
    });
    expect(schema).toEqual({
      type: "object",
      properties: { query: { type: "string", minLength: 1 } },
      required: ["query"],
    });
  });

  it("scrubs runtime injection variables before child execution", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-context-env-test-"));
    temporaryDirectories.push(directory);
    const env = sanitizeExecutionEnv(
      {
        NODE_OPTIONS: "--require evil.js",
        PYTHONSTARTUP: "evil.py",
        RUSTC_WRAPPER: "evil-wrapper",
        BASH_ENV: "evil.sh",
        COMPlus_ProfAPI_ProfilerCompatibilitySetting: "EnableV2Profiler",
        SAFE_CONTEXT_TEST: "kept",
      },
      directory,
    );
    expect(env).not.toHaveProperty("NODE_OPTIONS");
    expect(env).not.toHaveProperty("PYTHONSTARTUP");
    expect(env).not.toHaveProperty("RUSTC_WRAPPER");
    expect(env).not.toHaveProperty("BASH_ENV");
    expect(env).not.toHaveProperty("COMPlus_ProfAPI_ProfilerCompatibilitySetting");
    expect(env.SAFE_CONTEXT_TEST).toBe("kept");
    vi.stubEnv("NODE_OPTIONS", "--require evil.js");
    vi.stubEnv("PYTHONSTARTUP", "evil.py");
    const result = await new NativeContextRunner().execute(
      {
        language: "javascript",
        code: 'console.log(process.env.NODE_OPTIONS ?? "unset", process.env.PYTHONSTARTUP ?? "unset")',
      },
      undefined,
      directory,
    );
    expect(result.stdout.trim()).toBe("unset unset");
  });

  it("uses a Windows cmd script extension rather than a .sh file", () => {
    expect(shellScriptExtension("win32")).toBe(".cmd");
    expect(shellScriptExtension("linux")).toBe(".sh");
    expect(shellRuntime("win32", { ComSpec: "C:\\\\Windows\\\\System32\\\\cmd.exe" })).toContain(
      "cmd.exe",
    );
  });

  it("registers only Pi-owned execution tools synchronously", () => {
    const subject = registry();
    expect(subject.tools.map((tool) => tool.name)).toEqual([
      "ctx_execute",
      "ctx_execute_file",
      "ctx_batch_execute",
    ]);
    expect(BRIDGED_TOOLS).toContain("ctx_doctor");
    expect(subject.tools.every((tool) => tool.renderCall && tool.renderResult)).toBe(true);
  });

  it("registers the pinned upstream session-memory and compaction lifecycle without its tools", () => {
    const subject = registry();
    for (const event of [
      "before_agent_start",
      "context",
      "session_before_compact",
      "session_compact",
      "turn_end",
    ])
      expect(subject.events.has(event), `missing ${event}`).toBe(true);
    const messages = [
      {
        role: "user",
        content:
          "context-mode active. old upstream routing including Upgrade and Purge.\n\n<active_memory>remember me</active_memory>",
      },
    ];
    sanitizeInjectedRouting(messages);
    expect(messages[0]?.content).toBe(
      `${ROUTING_ANCHOR}\n\n<active_memory>remember me</active_memory>`,
    );
    expect(normalizeLifecycleToolResult({ toolName: "ctx_execute", result: "ok" })).toEqual({
      toolName: "context_mode_ctx_execute",
      result: "ok",
    });
  });

  it("keeps execution tools out of a read-only child", () => {
    vi.stubEnv("PI_SUBAGENT_CONTEXT_EXECUTION", "0");
    const subject = registry();
    expect(subject.tools).toHaveLength(0);
  });

  it("stays inactive when another Context Mode owner already registered tools", () => {
    const subject = registry(["ctx_search"]);
    expect(subject.tools).toHaveLength(0);
    expect(subject.events.size).toBe(0);
    expect(subject.warnings.join("\n")).toContain("another extension already registered");
  });
});

describe("native Context Mode policy enforcement", () => {
  it("uses the pinned external security module for shell commands, embedded commands, and files", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-context-security-test-"));
    temporaryDirectories.push(directory);
    await fakeSecurityRuntime(directory, true);
    await expect(
      enforceExecutionPolicy({
        projectRoot: directory,
        language: "shell",
        code: "blocked command",
      }),
    ).rejects.toThrow("blocked *");
    await expect(
      enforceExecutionPolicy({
        projectRoot: directory,
        language: "javascript",
        code: "blocked embedded command",
      }),
    ).rejects.toThrow("blocked *");
    await expect(
      enforceExecutionPolicy({
        projectRoot: directory,
        language: "javascript",
        code: "console.log('ok')",
        path: join(directory, "secret.txt"),
      }),
    ).rejects.toThrow("**/secret*");
  });
});

describe("native Context Mode intent indexing", () => {
  it("indexes output and returns only matching searched sections", async () => {
    const calls: Array<{ name: string; args: object }> = [];
    const bridge = {
      async call(name: string, args: object) {
        calls.push({ name, args });
        return name === "ctx_search"
          ? { content: [{ type: "text", text: "matching intent section" }] }
          : { content: [{ type: "text", text: "indexed" }] };
      },
    };
    const result = await indexIntentOutput({
      bridge: bridge as never,
      output: "large derived output",
      intent: "failing tests",
      source: "execute:test",
      signal: undefined,
      onUpdate: undefined,
      details: { status: "success", backend: "native", toolName: "ctx_execute" },
    });
    expect(calls.map((call) => call.name)).toEqual(["ctx_index", "ctx_search"]);
    expect(calls[1]?.args).toEqual({ queries: ["failing tests"], source: "execute:test" });
    expect(result).toBe("matching intent section");
  });
});

describe("native Context Mode execution provenance", () => {
  it("returns a bounded executed-source echo before program output", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-context-echo-test-"));
    temporaryDirectories.push(directory);
    const result = await nativeExecution(
      new NativeContextRunner(),
      { language: "javascript", code: 'console.log("echo output")' },
      undefined,
      undefined,
      directory,
      undefined,
    );
    expect(result.content[0]?.text).toContain('```javascript\nconsole.log("echo output")');
    expect(result.content[0]?.text).toContain("echo output");
  });
});

describe("native Context Mode non-zero intent indexing", () => {
  it("indexes large failure output and preserves the failed tool result", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-context-error-intent-test-"));
    temporaryDirectories.push(directory);
    const calls: string[] = [];
    const bridge = {
      async call(name: string) {
        calls.push(name);
        return name === "ctx_search"
          ? { content: [{ type: "text", text: "matched failure section" }] }
          : { content: [{ type: "text", text: "indexed" }] };
      },
    };
    await expect(
      nativeExecution(
        new NativeContextRunner(),
        {
          language: "javascript",
          code: 'console.error("failure ".repeat(1000)); process.exitCode = 1',
          intent: "test failures",
        },
        undefined,
        undefined,
        directory,
        bridge as never,
      ),
    ).rejects.toThrow("matched failure section");
    expect(calls).toEqual(["ctx_index", "ctx_search"]);
  });
});

describe("native Context Mode batch execution", () => {
  it("runs commands concurrently, indexes bounded output, and returns search results", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-context-batch-test-"));
    temporaryDirectories.push(directory);
    await fakeSecurityRuntime(directory);
    const calls: Array<{ name: string; args: object }> = [];
    const bridge = {
      async call(name: string, args: object) {
        calls.push({ name, args });
        return name === "ctx_search"
          ? { content: [{ type: "text", text: "## query\nmatched batch output" }] }
          : { content: [{ type: "text", text: "indexed" }] };
      },
    };
    const updates: Array<{ details?: ContextDetails }> = [];
    const result = await nativeBatchExecution(
      new NativeContextRunner(),
      bridge as never,
      {
        commands: [
          { label: "one", command: "printf one" },
          { label: "two", command: "printf two" },
        ],
        queries: ["query"],
        concurrency: 2,
        query_scope: "batch",
      },
      undefined,
      (update) => updates.push(update),
      directory,
    );
    expect(calls.map((call) => call.name)).toEqual(["ctx_index", "ctx_search"]);
    expect(calls[1]?.args).toMatchObject({
      queries: ["query"],
      source: expect.stringMatching(/^batch:/u),
    });
    expect(result.content[0]?.text).toContain("matched batch output");
    expect(result.details).toMatchObject({
      status: "success",
      completedCommands: 2,
      totalCommands: 2,
    });
    expect(updates.some((update) => update.details?.phase === "execute")).toBe(true);
    expect(updates.some((update) => update.details?.phase === "index")).toBe(true);
    expect(updates.some((update) => update.details?.phase === "search")).toBe(true);
  });
});

describe("native Context Mode runner", () => {
  it("requires a real Node runtime and never returns a Pi or Bun host executable", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-context-node-test-"));
    temporaryDirectories.push(directory);
    const node = join(directory, process.platform === "win32" ? "node.exe" : "node");
    await writeFile(node, "", "utf8");
    await chmod(node, 0o755);
    const env = { PATH: directory };
    expect(resolveNodeRuntime("/usr/local/bin/pi", env)).toBe(node);
    expect(resolveNodeRuntime("/usr/local/bin/bun", env)).toBe(node);
    expect(resolveNodeRuntime("/usr/local/bin/pi", { PATH: "" })).toBeNull();
  });

  it("executes JavaScript with CommonJS require semantics", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-context-test-"));
    temporaryDirectories.push(directory);
    const result = await new NativeContextRunner().execute(
      {
        language: "javascript",
        code: 'console.log(require("node:path").basename(process.cwd()))',
      },
      undefined,
      directory,
    );
    expect(result.stdout.trim()).toBe(basename(directory));
    expect(result.exitCode).toBe(0);
  });

  it("enforces the output limit in bytes and reports truncated failure", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-context-output-cap-test-"));
    temporaryDirectories.push(directory);
    const result = await new NativeContextRunner().execute(
      { language: "javascript", code: 'process.stdout.write("a" + "😀".repeat(30000))' },
      undefined,
      directory,
    );
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr)).toBeLessThanOrEqual(
      100000,
    );
  });

  it("executes JavaScript and returns bounded tool output", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-context-test-"));
    temporaryDirectories.push(directory);
    const result = await new NativeContextRunner().execute(
      { language: "javascript", code: 'console.log("native-ok")' },
      undefined,
      directory,
    );
    expect(result.stdout.trim()).toBe("native-ok");
    expect(result.exitCode).toBe(0);
  });

  it("reports throttled elapsed and output-byte progress", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-context-progress-test-"));
    temporaryDirectories.push(directory);
    const progress: Array<{ elapsedMs: number; outputBytes: number }> = [];
    await new NativeContextRunner().execute(
      {
        language: "javascript",
        code: 'console.log("progress"); setTimeout(() => {}, 600)',
      },
      undefined,
      directory,
      (update) => progress.push(update),
    );
    expect(progress.some((update) => update.outputBytes > 0)).toBe(true);
    expect(progress.at(-1)?.elapsedMs).toBeGreaterThanOrEqual(500);
  });

  it("aborts a child and reports AbortError", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-context-test-"));
    temporaryDirectories.push(directory);
    const controller = new AbortController();
    const pending = new NativeContextRunner().execute(
      { language: "javascript", code: "setTimeout(() => {}, 10000)" },
      controller.signal,
      directory,
    );
    setTimeout(() => controller.abort(), 25);
    await expect(pending).rejects.toBeInstanceOf(ContextAbortError);
  });

  it("confines execute_file and exposes FILE_CONTENT without leaving temp files", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-context-test-"));
    temporaryDirectories.push(directory);
    const file = join(directory, "input.txt");
    await writeFile(file, "file-content", "utf8");
    const result = await new NativeContextRunner().executeFile(
      {
        path: file,
        language: "javascript",
        code: 'console.log(require("node:path").basename(FILE_CONTENT_PATH), FILE_CONTENT)',
      },
      undefined,
      directory,
    );
    expect(result.stdout.trim()).toBe("input.txt file-content");
    await expect(
      new NativeContextRunner().executeFile(
        { path: "/tmp/outside-context-mode", language: "javascript", code: "" },
        undefined,
        directory,
      ),
    ).rejects.toThrow("inside the project");
  });

  it.skipIf(process.platform === "win32")("runs the binary produced by rustc", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-context-rust-test-"));
    temporaryDirectories.push(directory);
    const fakeBin = join(directory, "bin");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(fakeBin));
    const fakeRustc = join(fakeBin, "rustc");
    await writeFile(
      fakeRustc,
      '#!/bin/sh\nout=""\nwhile [ "$#" -gt 0 ]; do if [ "$1" = "-o" ]; then out="$2"; shift 2; else shift; fi; done\nprintf "#!/bin/sh\\nprintf rust-compiled\\n" > "$out"\nchmod +x "$out"\n',
      "utf8",
    );
    await chmod(fakeRustc, 0o755);
    vi.stubEnv("PATH", `${fakeBin}:${process.env.PATH ?? ""}`);
    const result = await new NativeContextRunner().execute(
      { language: "rust", code: "fn main() {}" },
      undefined,
      directory,
    );
    expect(result.stdout.trim()).toBe("rust-compiled");
    expect(result.exitCode).toBe(0);
  });

  const rustAvailable = spawnSync("rustc", ["--version"], { stdio: "ignore" }).status === 0;
  it.skipIf(!rustAvailable)("compiles and runs Rust, not just rustc", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-context-test-"));
    temporaryDirectories.push(directory);
    const result = await new NativeContextRunner().execute(
      { language: "rust", code: 'fn main() { println!("rust-ok"); }' },
      undefined,
      directory,
    );
    expect(result.stdout.trim()).toBe("rust-ok");
    expect(result.exitCode).toBe(0);
  });
});

describe("external bridge lifecycle and package failures", () => {
  it("rejects an external runtime with no package version", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-context-runtime-"));
    temporaryDirectories.push(directory);
    await writeFile(join(directory, "server.bundle.mjs"), "", "utf8");
    vi.stubEnv("PI_CONTEXT_MODE_DIR", directory);
    await expect(new ExternalContextBridge(directory).start()).rejects.toThrow("no readable");
  });

  it("rejects an unpinned external runtime before importing its engine", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-context-runtime-"));
    temporaryDirectories.push(directory);
    await writeFile(join(directory, "server.bundle.mjs"), "", "utf8");
    await writeFile(
      join(directory, "package.json"),
      JSON.stringify({ version: "1.0.168" }),
      "utf8",
    );
    vi.stubEnv("PI_CONTEXT_MODE_DIR", directory);
    await expect(new ExternalContextBridge(directory).start()).rejects.toThrow("unsupported");
  });

  it("logs bridge availability failures without creating chat output", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-context-runtime-"));
    temporaryDirectories.push(directory);
    await writeFile(join(directory, "server.bundle.mjs"), "", "utf8");
    vi.stubEnv("PI_CONTEXT_MODE_DIR", directory);
    const subject = registry();
    await subject.events.get("session_start")!({}, { cwd: directory, hasUI: false });
    expect(subject.warnings.join("\n")).toContain("external bridge unavailable");
    expect(subject.tools.map((tool) => tool.name)).toEqual([
      "ctx_execute",
      "ctx_execute_file",
      "ctx_batch_execute",
    ]);
  });

  it("shuts down an injected bridge client idempotently", () => {
    const bridge = new ExternalContextBridge(process.cwd()) as unknown as {
      client?: { shutdown(): void };
      shutdown(): void;
    };
    const client = { shutdown: vi.fn() };
    bridge.client = client;
    bridge.shutdown();
    bridge.shutdown();
    expect(client.shutdown).toHaveBeenCalledOnce();
  });
});

describe("Context Mode tool-row rendering", () => {
  it("renders the actual tool name, useful call preview, and expanded output", () => {
    const call = createContextCallRenderer("ctx_search")(
      { queries: ["cancellation progress"] },
      theme(),
    );
    const expanded = createContextResultRenderer("ctx_search")(
      {
        content: [{ type: "text", text: "full indexed search result" }],
        details: { status: "success", backend: "external-bridge", toolName: "ctx_search" },
      },
      { isPartial: false, expanded: true },
      theme(),
    );
    expect(call.render(120).join("\n")).toContain("ctx_search");
    expect(call.render(120).join("\n")).toContain("cancellation progress");
    expect(expanded.render(120).join("\n")).toContain("full indexed search result");
    const expandedError = createContextResultRenderer("ctx_execute")(
      {
        content: [{ type: "text", text: "```javascript\nthrow new Error()\n```\n\nstack line" }],
        details: undefined,
      },
      { isPartial: false, expanded: true },
      theme(),
      { isError: true },
    );
    expect(expandedError.render(120).join("\n")).toContain("stack line");
  });

  it("renders partial, cancelled, and completed states without UI side channels", () => {
    const partial = renderContextResult(
      { content: [{ type: "text", text: "Running…" }], details: undefined },
      { isPartial: true, expanded: false },
      theme(),
    );
    const cancelled = renderContextResult(
      {
        content: [{ type: "text", text: "Context Mode execution cancelled" }],
        details: { status: "cancelled", backend: "native" } satisfies ContextDetails,
      },
      { isPartial: false, expanded: false },
      theme(),
    );
    const complete = renderContextResult(
      {
        content: [{ type: "text", text: "done" }],
        details: {
          status: "success",
          backend: "native",
          toolName: "ctx_execute",
          outputBytes: 4,
        } satisfies ContextDetails,
      },
      { isPartial: false, expanded: false },
      theme(),
    );
    expect(partial.render(120).join("\n")).toContain("Running");
    expect(cancelled.render(120).join("\n")).toContain("Cancelled");
    expect(complete.render(120).join("\n")).toContain("ctx_execute");
  });
});
