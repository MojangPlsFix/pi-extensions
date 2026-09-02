import { spawn } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { PermissionHandler, PermissionRequest, SessionConfig } from "@github/copilot-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildCopilotSdkSessionConfig,
  COPILOT_SDK_RUNTIME_LAUNCHER_PATH,
  type CopilotRuntimeFileSystem,
  type CopilotSdkClientAdapter,
  type CopilotSdkSessionAdapter,
  CopilotSearchRuntime,
  copilotSdkPermissionHandler,
  copilotSdkRuntimeEnvironment,
  isCopilotWebSearchTool,
  registerSearchExtension,
  renderSearchResult,
  type SearchDetails,
  type SearchParams,
  verifyCopilotSdkToolMetadata,
} from "../index.js";

const searchMetadata = {
  name: "github-mcp-server-web_search",
  namespacedName: "github-mcp-server/web_search",
  mcpServerName: "github-mcp-server",
  mcpToolName: "web_search",
};
const fetchMetadata = {
  name: "web_fetch",
  namespacedName: "web_fetch",
};

type Event = Record<string, unknown> & { type: string; data?: Record<string, unknown> };
type SessionBehavior = (session: FakeSession) => Promise<Event | undefined>;

class FakeSession implements CopilotSdkSessionAdapter {
  readonly handlers = new Set<(event: Event) => void>();
  readonly sendPrompts: string[] = [];
  readonly abort = vi.fn(async () => undefined);
  readonly disconnect = vi.fn(async () => undefined);
  readonly rpc: CopilotSdkSessionAdapter["rpc"];

  constructor(
    readonly sessionId: string,
    private readonly behavior: SessionBehavior,
    metadata: unknown,
  ) {
    this.rpc = {
      tools: {
        initializeAndValidate: vi.fn(async () => undefined),
        getCurrentMetadata: vi.fn(async () => metadata),
      },
    };
  }

  on(handler: (event: Event) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  emit(event: Event): void {
    for (const handler of this.handlers) handler(event);
  }

  async sendAndWait(options: { prompt: string }): Promise<Event | undefined> {
    this.sendPrompts.push(options.prompt);
    return this.behavior(this);
  }
}

class FakeClient implements CopilotSdkClientAdapter {
  readonly start = vi.fn<() => Promise<void>>(async () => undefined);
  readonly stop = vi.fn(async () => []);
  readonly forceStop = vi.fn(async () => undefined);
  readonly getStatus = vi.fn(async () => ({ version: "1.0.79", protocolVersion: 3 }));
  readonly deleteSession = vi.fn(async (_sessionId: string) => undefined);
  readonly sessions: FakeSession[] = [];
  readonly configs: SessionConfig[] = [];
  createError?: Error;

  constructor(
    private readonly behaviors: SessionBehavior[] = [],
    private readonly metadata: unknown = [searchMetadata],
  ) {}

  async createSession(config: SessionConfig): Promise<FakeSession> {
    this.configs.push(config);
    if (this.createError) throw this.createError;
    const behavior = this.behaviors[this.sessions.length] ?? successfulBehavior();
    const metadata = config.availableTools?.toString().includes("web_fetch")
      ? [searchMetadata, fetchMetadata]
      : this.metadata;
    const session = new FakeSession(`session-${this.sessions.length + 1}`, behavior, metadata);
    this.sessions.push(session);
    config.onEvent?.(
      event("session.start", { selectedModel: "gpt-5.6-luna", reasoningEffort: "none" }) as never,
    );
    return session;
  }
}

function fakeFileSystem(): CopilotRuntimeFileSystem & {
  runtimeDirectories: string[];
  sessionDirectories: string[];
  removed: string[];
} {
  const runtimeDirectories: string[] = [];
  const sessionDirectories: string[] = [];
  const removed: string[] = [];
  return {
    runtimeDirectories,
    sessionDirectories,
    removed,
    async createRuntimeDirectory() {
      const directory = `/tmp/runtime-${runtimeDirectories.length + 1}`;
      runtimeDirectories.push(directory);
      return directory;
    },
    async createSessionDirectory(baseDirectory) {
      const directory = `${baseDirectory}/query-${sessionDirectories.length + 1}`;
      sessionDirectories.push(directory);
      return directory;
    },
    async createDirectory() {},
    async removeDirectory(path) {
      removed.push(path);
    },
  };
}

function event(type: string, data: Record<string, unknown> = {}): Event {
  return { type, data };
}

async function permissionDecision(handler: PermissionHandler, request: PermissionRequest) {
  return handler(request, { sessionId: "one" });
}

function successfulBehavior(
  name = "web_search",
  url = "https://example.com/evidence",
): SessionBehavior {
  return async (session) => {
    session.emit(
      event("session.start", { selectedModel: "gpt-5.6-luna", reasoningEffort: "none" }),
    );
    session.emit(event("tool.execution_start", { toolCallId: "search-1", toolName: name }));
    session.emit(
      event("tool.execution_complete", {
        toolCallId: "search-1",
        success: true,
        result: { citableSources: [{ title: "Evidence", url }] },
      }),
    );
    const answer = event("assistant.message", {
      content: `Retrieved evidence from ${url}`,
      model: "gpt-5.6-luna",
    });
    session.emit(answer);
    return answer;
  };
}

function runtimeWith(
  client: FakeClient,
  options: { timeout?: string; cleanupGrace?: number; shutdownGrace?: number } = {},
) {
  const fileSystem = fakeFileSystem();
  let factoryCalls = 0;
  const runtime = new CopilotSearchRuntime({
    createClient: () => {
      factoryCalls += 1;
      return client;
    },
    fileSystem,
    environment: () => ({ PI_COPILOT_SEARCH_TIMEOUT_MS: options.timeout ?? "1000" }),
    sessionCleanupGraceMs: options.cleanupGrace ?? 20,
    shutdownGraceMs: options.shutdownGrace ?? 20,
  });
  return { runtime, fileSystem, factoryCalls: () => factoryCalls };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("Copilot SDK runtime lifecycle", () => {
  it("constructs and registers without starting external resources", () => {
    let factoryCalls = 0;
    const runtime = new CopilotSearchRuntime({
      createClient: () => {
        factoryCalls += 1;
        return new FakeClient();
      },
      fileSystem: fakeFileSystem(),
    });
    const handlers = new Map<string, () => Promise<void>>();
    const tools: unknown[] = [];
    registerSearchExtension(
      {
        on: (name: string, handler: () => Promise<void>) => handlers.set(name, handler),
        registerTool: (tool: unknown) => tools.push(tool),
      } as never,
      runtime,
    );
    expect(factoryCalls).toBe(0);
    expect(tools).toHaveLength(1);
    expect(handlers.has("session_shutdown")).toBe(true);
  });

  it("suppresses bundled runtime stderr in the isolated launcher process", async () => {
    const result = await new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [COPILOT_SDK_RUNTIME_LAUNCHER_PATH, "--pi-sdk-launcher-stderr-test=secret-marker"],
        { shell: false, stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
      );
      let stderr = "";
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });
      child.once("error", reject);
      child.once("close", (code) => resolve({ code, stderr }));
    });
    expect(result).toEqual({ code: 0, stderr: "" });
    expect(result.stderr).not.toContain("secret-marker");
  });

  it("removes inherited runtime injection and debug environment variables", () => {
    const environment = copilotSdkRuntimeEnvironment({
      HOME: "/home/test",
      GITHUB_TOKEN: "retained-auth-token",
      NODE_OPTIONS: "--require=/tmp/untrusted-preload.cjs",
      NODE_DEBUG: "http",
      LD_PRELOAD: "/tmp/untrusted.so",
      COPILOT_CLI_PATH: "/tmp/untrusted-runtime",
    });
    expect(environment).toEqual({
      HOME: "/home/test",
      GITHUB_TOKEN: "retained-auth-token",
    });
  });

  it("creates a new lazy runtime after Pi starts a later session", async () => {
    vi.stubEnv("PI_COPILOT_SEARCH_TRANSPORT", "sdk");
    const result = {
      output: "Evidence https://example.com",
      sources: [{ url: "https://example.com/" }],
      resultCount: 1,
      outputTruncated: false,
      sourcesTruncated: false,
    };
    const first = {
      search: vi.fn(async () => result),
      shutdown: vi.fn(async () => undefined),
    };
    const second = {
      search: vi.fn(async () => result),
      shutdown: vi.fn(async () => undefined),
    };
    const handlers = new Map<string, () => Promise<void> | void>();
    let tool:
      | {
          execute: (
            id: string,
            params: SearchParams,
            signal: AbortSignal | undefined,
            update: undefined,
            context: unknown,
          ) => Promise<unknown>;
        }
      | undefined;
    registerSearchExtension(
      {
        on: (name: string, handler: () => Promise<void> | void) => handlers.set(name, handler),
        registerTool: (value: unknown) => {
          tool = value as typeof tool;
        },
      } as never,
      first,
      () => second,
    );
    await handlers.get("session_shutdown")?.();
    handlers.get("session_start")?.();
    await tool?.execute("one", { query: "new session" }, undefined, undefined, {
      cwd: "/tmp",
      model: { provider: "github-copilot", id: "parent" },
    });
    expect(first.shutdown).toHaveBeenCalledTimes(1);
    expect(first.search).not.toHaveBeenCalled();
    expect(second.search).toHaveBeenCalledTimes(1);
  });

  it("starts one client for concurrent first calls and creates a session per search", async () => {
    let releaseStart: (() => void) | undefined;
    const client = new FakeClient();
    client.start.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          releaseStart = resolve;
        }),
    );
    const subject = runtimeWith(client);
    const first = subject.runtime.search({ query: "first" });
    const second = subject.runtime.search({ query: "second" });
    await vi.waitFor(() => expect(client.start).toHaveBeenCalledTimes(1));
    releaseStart?.();
    const results = await Promise.all([first, second]);
    expect(results).toHaveLength(2);
    expect(subject.factoryCalls()).toBe(1);
    expect(client.sessions).toHaveLength(2);
    expect(client.sessions.every((session) => session.sendPrompts.length === 1)).toBe(true);
    expect(client.deleteSession).toHaveBeenCalledTimes(2);
  });

  it("reuses a warm client and sends combined requests in one turn", async () => {
    const client = new FakeClient();
    const subject = runtimeWith(client);
    await subject.runtime.search({ prompt: "overview", query: "details", queries: ["examples"] });
    await subject.runtime.search({ query: "next" });
    expect(client.start).toHaveBeenCalledTimes(1);
    expect(client.sessions).toHaveLength(2);
    expect(client.sessions[0]?.sendPrompts).toHaveLength(1);
    expect(client.sessions[0]?.sendPrompts[0]).toContain("overview\n\ndetails\n\nexamples");
    expect(client.sessions[0]?.disconnect).toHaveBeenCalledTimes(1);
    expect(client.deleteSession).toHaveBeenCalledWith("session-1");
    expect(client.deleteSession).toHaveBeenCalledWith("session-2");
  });

  it("cleans sessions on tool failure, timeout, and cancellation", async () => {
    const failed: SessionBehavior = async (session) => {
      session.emit(event("tool.execution_start", { toolCallId: "one", toolName: "web_search" }));
      session.emit(event("tool.execution_complete", { toolCallId: "one", success: false }));
      return event("assistant.message", { content: "unsupported answer" });
    };
    const never: SessionBehavior = async () => new Promise(() => undefined);
    const client = new FakeClient([failed, never, never]);
    const subject = runtimeWith(client, { timeout: "10", cleanupGrace: 20 });

    await expect(subject.runtime.search({ query: "failed" })).rejects.toThrow(
      "without a successful web_search",
    );
    await expect(subject.runtime.search({ query: "timeout" })).rejects.toThrow(
      "timed out after 10ms",
    );
    const controller = new AbortController();
    const cancelled = subject.runtime.search({ query: "cancelled" }, controller.signal);
    const cancellation = expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
    while (client.sessions.length < 3) await Promise.resolve();
    controller.abort();
    await cancellation;

    expect(client.sessions.every((session) => session.disconnect.mock.calls.length === 1)).toBe(
      true,
    );
    expect(client.deleteSession).toHaveBeenCalledTimes(3);
    expect(client.stop).not.toHaveBeenCalled();
  });

  it("cancels hung capability verification and still deletes the session", async () => {
    const client = new FakeClient();
    const session = new FakeSession("verify-session", successfulBehavior(), [searchMetadata]);
    const initialize = vi.fn(async () => new Promise<void>(() => undefined));
    if (session.rpc?.tools)
      (session.rpc.tools as { initializeAndValidate: () => Promise<void> }).initializeAndValidate =
        initialize;
    vi.spyOn(client, "createSession").mockResolvedValue(session);
    const subject = runtimeWith(client, { cleanupGrace: 20, shutdownGrace: 20 });
    const controller = new AbortController();
    const pending = subject.runtime.search({ query: "verify" }, controller.signal);
    const rejection = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(initialize).toHaveBeenCalledTimes(1));
    controller.abort();
    await rejection;
    expect(session.abort).toHaveBeenCalled();
    expect(session.disconnect).toHaveBeenCalled();
    expect(client.deleteSession).toHaveBeenCalledWith("verify-session");
    await subject.runtime.shutdown();
  });

  it("cancels one query without stopping another session on the shared runtime", async () => {
    const never: SessionBehavior = async () => new Promise(() => undefined);
    let releaseSecond: (() => void) | undefined;
    const second: SessionBehavior = async (session) => {
      await new Promise<void>((resolve) => {
        releaseSecond = resolve;
      });
      return successfulBehavior()(session);
    };
    const client = new FakeClient([never, second]);
    const subject = runtimeWith(client, { timeout: "1000" });
    const controller = new AbortController();
    const cancelled = subject.runtime.search({ query: "cancel me" }, controller.signal);
    const cancellation = expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
    const unrelated = subject.runtime.search({ query: "keep going" });
    while (client.sessions.length < 2) await Promise.resolve();
    controller.abort();
    await cancellation;
    expect(client.stop).not.toHaveBeenCalled();
    releaseSecond?.();
    await expect(unrelated).resolves.toMatchObject({ resultCount: 1 });
    expect(client.stop).not.toHaveBeenCalled();
  });

  it("resets the inactivity timeout on meaningful SDK events", async () => {
    const progress: SessionBehavior = async (session) => {
      for (let index = 0; index < 4; index += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        session.emit(event("assistant.streaming_delta", { totalBytes: index + 1 }));
      }
      session.emit(event("tool.execution_start", { toolCallId: "one", toolName: "web_search" }));
      session.emit(
        event("tool.execution_complete", {
          toolCallId: "one",
          success: true,
          result: { citableSources: [{ url: "https://example.com/progress" }] },
        }),
      );
      return event("assistant.message", {
        content: "Progress result https://example.com/progress",
      });
    };
    const subject = runtimeWith(new FakeClient([progress]), { timeout: "25" });
    await expect(subject.runtime.search({ query: "progress" })).resolves.toMatchObject({
      resultCount: 1,
    });
  });

  it("shuts down idempotently and force-stops after the grace period", async () => {
    const client = new FakeClient();
    client.stop.mockImplementation(async () => new Promise(() => undefined));
    const subject = runtimeWith(client, { shutdownGrace: 5 });
    await subject.runtime.search({ query: "warm" });
    const first = subject.runtime.shutdown();
    const second = subject.runtime.shutdown();
    expect(first).toBe(second);
    await first;
    expect(client.stop).toHaveBeenCalledTimes(1);
    expect(client.forceStop).toHaveBeenCalledTimes(1);
    expect(subject.fileSystem.removed).toContain("/tmp/runtime-1");
    await expect(subject.runtime.search({ query: "late" })).rejects.toThrow("shutting down");
  });

  it("cannot start a delayed runtime after shutdown has completed", async () => {
    const fileSystem = fakeFileSystem();
    let resolveRuntimeDirectory: ((directory: string) => void) | undefined;
    const createRuntimeDirectory = vi.fn(
      async () =>
        new Promise<string>((resolve) => {
          resolveRuntimeDirectory = resolve;
        }),
    );
    fileSystem.createRuntimeDirectory = createRuntimeDirectory;
    const client = new FakeClient();
    const createClient = vi.fn(() => client);
    const runtime = new CopilotSearchRuntime({
      createClient,
      fileSystem,
      environment: () => ({ PI_COPILOT_SEARCH_TIMEOUT_MS: "1000" }),
      shutdownGraceMs: 5,
    });
    const search = runtime.search({ query: "delayed startup" });
    const rejection = expect(search).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(createRuntimeDirectory).toHaveBeenCalledTimes(1));
    await runtime.shutdown();
    await rejection;

    resolveRuntimeDirectory?.("/tmp/runtime-delayed");
    await vi.waitFor(() => expect(fileSystem.removed).toContain("/tmp/runtime-delayed"));
    expect(createClient).not.toHaveBeenCalled();
    expect(client.start).not.toHaveBeenCalled();
  });

  it("does not retry a startup failure and permits a later independent initialization", async () => {
    const first = new FakeClient();
    first.start.mockRejectedValue(new Error("connection failed with secret payload"));
    const second = new FakeClient();
    const clients = [first, second];
    let calls = 0;
    const runtime = new CopilotSearchRuntime({
      createClient: () => clients[calls++] as FakeClient,
      fileSystem: fakeFileSystem(),
      environment: () => ({ PI_COPILOT_SEARCH_TIMEOUT_MS: "1000" }),
      shutdownGraceMs: 10,
    });
    await expect(runtime.search({ query: "first" })).rejects.toThrow("could not start");
    expect(calls).toBe(1);
    await expect(runtime.search({ query: "second" })).resolves.toMatchObject({ resultCount: 1 });
    expect(calls).toBe(2);
  });

  it("deletes the caller-generated session ID when SDK session creation fails", async () => {
    const client = new FakeClient();
    client.createError = new Error("session option update failed with secret payload");
    const subject = runtimeWith(client);
    await expect(subject.runtime.search({ query: "create failure" })).rejects.toThrow(
      "Copilot SDK search failed",
    );
    const requestedSessionId = client.configs[0]?.sessionId;
    expect(requestedSessionId).toEqual(expect.any(String));
    expect(client.deleteSession).toHaveBeenCalledWith(requestedSessionId);
    expect(subject.fileSystem.removed).toContain("/tmp/runtime-1/query-1");
  });

  it("aborts and drains a session-creation race during shutdown", async () => {
    const client = new FakeClient();
    const lateSession = new FakeSession("late-session", successfulBehavior(), [searchMetadata]);
    let resolveCreation: ((session: FakeSession) => void) | undefined;
    const create = vi.spyOn(client, "createSession").mockImplementation(
      async () =>
        new Promise<FakeSession>((resolve) => {
          resolveCreation = resolve;
        }),
    );
    const subject = runtimeWith(client, { cleanupGrace: 20, shutdownGrace: 50 });
    const pending = subject.runtime.search({ query: "shutdown race" });
    const rejection = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    const shutdown = subject.runtime.shutdown();
    resolveCreation?.(lateSession);
    await rejection;
    await shutdown;
    expect(lateSession.abort).toHaveBeenCalled();
    expect(lateSession.disconnect).toHaveBeenCalled();
    expect(client.deleteSession).toHaveBeenCalledWith("late-session");
    expect(client.stop).toHaveBeenCalledTimes(1);
  });

  it("reinitializes only on a later search after a broken connection", async () => {
    const broken = new FakeClient([
      async () => {
        throw new Error("JSON-RPC connection closed");
      },
    ]);
    const healthy = new FakeClient();
    const clients = [broken, healthy];
    let calls = 0;
    const runtime = new CopilotSearchRuntime({
      createClient: () => clients[calls++] as FakeClient,
      fileSystem: fakeFileSystem(),
      environment: () => ({ PI_COPILOT_SEARCH_TIMEOUT_MS: "1000" }),
      shutdownGraceMs: 10,
    });
    await expect(runtime.search({ query: "broken" })).rejects.toThrow("not retried");
    expect(calls).toBe(1);
    await expect(runtime.search({ query: "later" })).resolves.toMatchObject({ resultCount: 1 });
    expect(calls).toBe(2);
  });

  it("retires a client when capability metadata reports a broken connection", async () => {
    const broken = new FakeClient();
    const brokenSession = new FakeSession("metadata-session", successfulBehavior(), [
      searchMetadata,
    ]);
    if (brokenSession.rpc?.tools)
      (
        brokenSession.rpc.tools as { getCurrentMetadata: () => Promise<unknown> }
      ).getCurrentMetadata = vi.fn(async () => {
        throw new Error("JSON-RPC connection closed with secret metadata");
      });
    vi.spyOn(broken, "createSession").mockImplementation(async (config) => {
      broken.configs.push(config);
      return brokenSession;
    });
    const healthy = new FakeClient();
    const clients = [broken, healthy];
    let calls = 0;
    const runtime = new CopilotSearchRuntime({
      createClient: () => clients[calls++] as FakeClient,
      fileSystem: fakeFileSystem(),
      environment: () => ({ PI_COPILOT_SEARCH_TIMEOUT_MS: "1000" }),
      shutdownGraceMs: 10,
    });

    const firstError = await runtime.search({ query: "broken metadata" }).catch((error) => error);
    expect(firstError).toBeInstanceOf(Error);
    expect((firstError as Error).message).toContain("connection closed");
    expect((firstError as Error).message).not.toContain("secret metadata");
    expect(broken.stop).toHaveBeenCalledTimes(1);
    await expect(runtime.search({ query: "later" })).resolves.toMatchObject({ resultCount: 1 });
    expect(calls).toBe(2);
  });

  it("bounds temporary-state creation and removal waits", async () => {
    const creationFileSystem = fakeFileSystem();
    creationFileSystem.createSessionDirectory = async () => new Promise<string>(() => undefined);
    const creationRuntime = new CopilotSearchRuntime({
      createClient: () => new FakeClient(),
      fileSystem: creationFileSystem,
      environment: () => ({ PI_COPILOT_SEARCH_TIMEOUT_MS: "5" }),
      sessionCleanupGraceMs: 5,
      shutdownGraceMs: 5,
    });
    await expect(creationRuntime.search({ query: "hung state creation" })).rejects.toThrow(
      "timed out after 5ms",
    );
    await creationRuntime.shutdown();

    const removalFileSystem = fakeFileSystem();
    removalFileSystem.removeDirectory = async () => new Promise<void>(() => undefined);
    const removalRuntime = new CopilotSearchRuntime({
      createClient: () => new FakeClient(),
      fileSystem: removalFileSystem,
      environment: () => ({ PI_COPILOT_SEARCH_TIMEOUT_MS: "1000" }),
      sessionCleanupGraceMs: 5,
      shutdownGraceMs: 5,
    });
    await expect(removalRuntime.search({ query: "hung state cleanup" })).rejects.toThrow(
      "could not remove its temporary session",
    );
    await removalRuntime.shutdown();
  });
});

describe("Copilot SDK retrieval policy and normalization", () => {
  it("uses empty-mode session controls, web-only filters, and selective permissions", async () => {
    const permissionCallIds = new Set(["url-one"]);
    const config = buildCopilotSdkSessionConfig(
      {
        query: "docs",
        includeContent: true,
        model: "legacy-model",
        reasoningEffort: "high",
      } as SearchParams & { model: string; reasoningEffort: string },
      "/tmp/session",
      ["mcp:github-mcp-server-web_search", "builtin:web_fetch"],
      permissionCallIds,
    );
    expect(config).toMatchObject({
      model: "gpt-5.6-luna",
      workingDirectory: "/tmp/session",
      configDirectory: "/tmp/session/config",
      enableConfigDiscovery: false,
      skipCustomInstructions: true,
      instructionDirectories: [],
      enableSkills: false,
      memory: { enabled: false },
      enableSessionStore: false,
      enableFileHooks: false,
      enableHostGitOperations: false,
      mcpOAuthTokenStorage: "in-memory",
      toolSearch: { enabled: false },
      availableTools: ["mcp:github-mcp-server-web_search", "builtin:web_fetch"],
    });
    expect(config).not.toHaveProperty("reasoningEffort");
    const handler = config.onPermissionRequest as PermissionHandler;
    expect(
      await permissionDecision(handler, {
        kind: "mcp",
        serverName: "github-mcp-server",
        toolName: "web_search",
        toolTitle: "Search",
        readOnly: true,
      }),
    ).toEqual({ kind: "approve-once" });
    expect(
      await permissionDecision(handler, {
        kind: "mcp",
        serverName: "other",
        toolName: "write_issue",
        toolTitle: "Write",
        readOnly: false,
      }),
    ).toMatchObject({ kind: "reject" });

    const urlHandler = copilotSdkPermissionHandler(
      true,
      permissionCallIds,
      () => true,
      async (hostname) => (hostname === "private.example" ? ["10.0.0.8"] : ["93.184.216.34"]),
    );
    expect(
      await permissionDecision(urlHandler, {
        kind: "url",
        url: "https://example.com/docs",
        intention: "read",
        toolCallId: "url-one",
      }),
    ).toEqual({ kind: "approve-once" });
    expect(
      await permissionDecision(urlHandler, {
        kind: "url",
        url: "https://example.com/docs",
        intention: "read",
        managedApprovalRequired: true,
        toolCallId: "url-one",
      }),
    ).toMatchObject({ kind: "reject" });
    expect(
      await permissionDecision(
        copilotSdkPermissionHandler(true, permissionCallIds, () => false),
        {
          kind: "mcp",
          serverName: "github-mcp-server",
          toolName: "web_search",
          toolTitle: "Search",
          readOnly: true,
        },
      ),
    ).toMatchObject({ kind: "reject" });
    expect(
      await permissionDecision(handler, {
        kind: "mcp",
        serverName: "unrelated-server",
        toolName: "web_search",
        toolTitle: "Search",
        readOnly: true,
      }),
    ).toMatchObject({ kind: "reject" });
    expect(
      await permissionDecision(handler, {
        kind: "mcp",
        serverName: "github-mcp-server",
        toolName: "web_search",
        toolTitle: "Search",
        readOnly: true,
        managedApprovalRequired: true,
      }),
    ).toMatchObject({ kind: "reject" });
    expect(
      await permissionDecision(urlHandler, {
        kind: "url",
        url: "http://127.0.0.1/private",
        intention: "read",
        toolCallId: "url-one",
      }),
    ).toMatchObject({ kind: "reject" });
    expect(
      await permissionDecision(urlHandler, {
        kind: "url",
        url: "http://[ff02::1]/multicast",
        intention: "read",
        toolCallId: "url-one",
      }),
    ).toMatchObject({ kind: "reject" });
    expect(
      await permissionDecision(urlHandler, {
        kind: "url",
        url: "http://[::ffff:7f00:1]/mapped-loopback",
        intention: "read",
        toolCallId: "url-one",
      }),
    ).toMatchObject({ kind: "reject" });
    expect(
      await permissionDecision(urlHandler, {
        kind: "url",
        url: "http://[fec0::1]/site-local",
        intention: "read",
        toolCallId: "url-one",
      }),
    ).toMatchObject({ kind: "reject" });
    expect(
      await permissionDecision(urlHandler, {
        kind: "url",
        url: "https://example.com/sandbox-bypass",
        intention: "read",
        requestSandboxBypass: true,
        toolCallId: "url-one",
      }),
    ).toMatchObject({ kind: "reject" });
    expect(
      await permissionDecision(urlHandler, {
        kind: "url",
        url: "https://private.example/internal",
        intention: "read",
        toolCallId: "url-one",
      }),
    ).toMatchObject({ kind: "reject" });
    expect(
      await permissionDecision(urlHandler, {
        kind: "url",
        url: "https://example.com/unrelated",
        intention: "read",
        toolCallId: "other-call",
      }),
    ).toMatchObject({ kind: "reject" });
  });

  it("recognizes canonical and documented legacy search event names", async () => {
    for (const name of [
      "web_search",
      "github-mcp-server-web_search",
      "github-mcp-server/web_search",
    ]) {
      expect(isCopilotWebSearchTool(name)).toBe(true);
      const client = new FakeClient([successfulBehavior(name)]);
      await expect(runtimeWith(client).runtime.search({ query: name })).resolves.toMatchObject({
        resultCount: 1,
      });
    }
    expect(isCopilotWebSearchTool("other-server-web_search")).toBe(false);
  });

  it("validates exact capability metadata and encodes source-qualified filters", async () => {
    expect(verifyCopilotSdkToolMetadata([searchMetadata], false)).toEqual(
      new Map([["web_search", "mcp:github-mcp-server-web_search"]]),
    );
    expect(verifyCopilotSdkToolMetadata([searchMetadata, fetchMetadata], true)).toEqual(
      new Map([
        ["web_search", "mcp:github-mcp-server-web_search"],
        ["web_fetch", "builtin:web_fetch"],
      ]),
    );
    expect(() => verifyCopilotSdkToolMetadata([searchMetadata, { name: "bash" }], false)).toThrow(
      "did not isolate",
    );
    expect(() =>
      verifyCopilotSdkToolMetadata(
        [{ ...searchMetadata, mcpServerName: "unrelated-server" }],
        false,
      ),
    ).toThrow("untrusted web tool server");
    expect(() => verifyCopilotSdkToolMetadata([], false)).toThrow("canonical web_search");

    const client = new FakeClient();
    const runtime = runtimeWith(client).runtime;
    await runtime.search({ query: "first" });
    await runtime.search({ query: "second" });
    expect(client.configs[0]?.availableTools).toEqual(["web_search"]);
    expect(client.configs[1]?.availableTools).toEqual(["mcp:github-mcp-server-web_search"]);
  });

  it("correlates completion by tool-call ID and requires explicit success", async () => {
    const mismatch: SessionBehavior = async (session) => {
      session.emit(event("tool.execution_start", { toolCallId: "one", toolName: "web_search" }));
      session.emit(event("tool.execution_complete", { toolCallId: "two", success: true }));
      return event("assistant.message", { content: "Answer https://example.com" });
    };
    await expect(
      runtimeWith(new FakeClient([mismatch])).runtime.search({ query: "docs" }),
    ).rejects.toThrow("without a successful web_search");
  });

  it("extracts sources by priority, deduplicates, redacts, and reports observed model effort", async () => {
    const behavior: SessionBehavior = async (session) => {
      session.emit(
        event("session.start", { selectedModel: "observed-model", reasoningEffort: "none" }),
      );
      session.emit(event("tool.execution_start", { toolCallId: "one", mcpToolName: "web_search" }));
      session.emit(
        event("tool.execution_complete", {
          toolCallId: "one",
          success: true,
          result: {
            citableSources: [{ title: "Citation", url: "https://one.example/path?token=secret" }],
            structuredContent: {
              results: [
                { title: "Structured", url: "https://two.example/docs", api_key: "secret" },
              ],
            },
            content: "Tool text https://three.example/result Bearer hidden-secret",
          },
        }),
      );
      return event("assistant.message", {
        content:
          "Answer https://four.example/final and duplicate https://two.example/docs Bearer answer-secret",
      });
    };
    const result = await runtimeWith(new FakeClient([behavior])).runtime.search({ query: "docs" });
    expect(result.sources.map((source) => source.url)).toEqual([
      "https://one.example/path",
      "https://two.example/docs",
      "https://three.example/result",
      "https://four.example/final",
    ]);
    expect(result.model).toBe("observed-model");
    expect(result.reasoningEffort).toBe("none");
    expect(JSON.stringify(result)).not.toContain("hidden-secret");
    expect(JSON.stringify(result)).not.toContain("answer-secret");
    expect(JSON.stringify(result)).not.toContain("token=");
  });

  it("extracts typed SDK resource URI sources", async () => {
    const behavior: SessionBehavior = async (session) => {
      session.emit(event("tool.execution_start", { toolCallId: "one", toolName: "web_search" }));
      session.emit(
        event("tool.execution_complete", {
          toolCallId: "one",
          success: true,
          result: {
            contents: [
              { type: "resource_link", uri: "https://example.com/resource-link" },
              {
                type: "resource",
                resource: { uri: "https://example.com/embedded-resource" },
              },
            ],
          },
        }),
      );
      return event("assistant.message", { content: "Retrieved two typed resources." });
    };
    const result = await runtimeWith(new FakeClient([behavior])).runtime.search({ query: "uris" });
    expect(result.sources.map((source) => source.url)).toEqual([
      "https://example.com/resource-link",
      "https://example.com/embedded-resource",
    ]);
  });

  it("extracts safe structured sources from optional web_fetch results", async () => {
    const behavior: SessionBehavior = async (session) => {
      session.emit(event("tool.execution_start", { toolCallId: "search", toolName: "web_search" }));
      session.emit(
        event("tool.execution_complete", {
          toolCallId: "search",
          success: true,
          result: { citableSources: [{ url: "https://example.com/search-result" }] },
        }),
      );
      session.emit(event("tool.execution_start", { toolCallId: "fetch", toolName: "web_fetch" }));
      session.emit(
        event("tool.execution_complete", {
          toolCallId: "fetch",
          success: true,
          result: {
            structuredContent: { uri: "https://example.com/inspected-page" },
          },
        }),
      );
      return event("assistant.message", { content: "Retrieved and inspected the source page." });
    };
    const result = await runtimeWith(new FakeClient([behavior])).runtime.search({
      query: "fetch sources",
      includeContent: true,
    });
    expect(result.sources.map((source) => source.url)).toEqual([
      "https://example.com/search-result",
      "https://example.com/inspected-page",
    ]);
    expect(result.resultCount).toBe(1);
  });

  it("bounds SDK output and source counts", async () => {
    const behavior: SessionBehavior = async (session) => {
      session.emit(event("tool.execution_start", { toolCallId: "one", toolName: "web_search" }));
      session.emit(
        event("tool.execution_complete", {
          toolCallId: "one",
          success: true,
          result: {
            citableSources: Array.from({ length: 25 }, (_, index) => ({
              title: `Source ${index}`,
              url: `https://example.com/${index}`,
            })),
          },
        }),
      );
      return event("assistant.message", {
        content: `${"x".repeat(13_000)} https://example.com/final`,
      });
    };
    const result = await runtimeWith(new FakeClient([behavior])).runtime.search({
      query: "bounds",
    });
    expect(result.sources).toHaveLength(20);
    expect(result.sourcesTruncated).toBe(true);
    expect(result.outputTruncated).toBe(true);
    expect(result.output).toContain("[truncated]");
    expect(result.output.length).toBeLessThanOrEqual(12_000);
  });

  it("rejects a factual answer with no safe source URL", async () => {
    const sourceLess: SessionBehavior = async (session) => {
      session.emit(event("tool.execution_start", { toolCallId: "one", toolName: "web_search" }));
      session.emit(event("tool.execution_complete", { toolCallId: "one", success: true }));
      return event("assistant.message", { content: "A factual but ungrounded answer." });
    };
    await expect(
      runtimeWith(new FakeClient([sourceLess])).runtime.search({ query: "facts" }),
    ).rejects.toThrow("without a safe source URL");
  });

  it("keeps fetch unavailable unless includeContent is true", async () => {
    const withoutFetch = copilotSdkPermissionHandler(false);
    const withFetch = copilotSdkPermissionHandler(true);
    const request = {
      kind: "mcp" as const,
      serverName: "github-mcp-server",
      toolName: "web_fetch",
      toolTitle: "Fetch",
      readOnly: true,
    };
    expect(await permissionDecision(withoutFetch, request)).toMatchObject({ kind: "reject" });
    expect(await permissionDecision(withFetch, request)).toEqual({ kind: "approve-once" });
  });
});

describe("registered SDK routing", () => {
  it("uses explicit SDK routing and never calls the CLI after an SDK error", async () => {
    vi.stubEnv("PI_COPILOT_SEARCH_TRANSPORT", "sdk");
    const runtime = {
      search: vi.fn(async () => {
        throw new Error("SDK failed without fallback");
      }),
      shutdown: vi.fn(async () => undefined),
    };
    let tool:
      | {
          execute: (
            id: string,
            params: SearchParams,
            signal: AbortSignal | undefined,
            update: ((value: unknown) => void) | undefined,
            context: unknown,
          ) => Promise<unknown>;
        }
      | undefined;
    registerSearchExtension(
      {
        on: vi.fn(),
        registerTool: (value: unknown) => {
          tool = value as typeof tool;
        },
      } as unknown as ExtensionAPI,
      runtime,
    );
    await expect(
      tool?.execute("one", { query: "docs" }, undefined, undefined, {
        cwd: "/tmp",
        model: { provider: "github-copilot", id: "parent" },
      }),
    ).rejects.toThrow("without fallback");
    expect(runtime.search).toHaveBeenCalledTimes(1);
  });

  it("returns complete SDK result details for successful registered execution", async () => {
    vi.stubEnv("PI_COPILOT_SEARCH_TRANSPORT", "sdk");
    const runtime = {
      search: vi.fn(async () => ({
        output: "Evidence https://example.com/sdk",
        sources: [{ url: "https://example.com/sdk" }],
        resultCount: 1,
        outputTruncated: false,
        sourcesTruncated: false,
        model: "observed-model",
        reasoningEffort: "none",
      })),
      shutdown: vi.fn(async () => undefined),
    };
    let tool:
      | {
          execute: (
            id: string,
            params: SearchParams,
            signal: AbortSignal | undefined,
            update: ((value: unknown) => void) | undefined,
            context: unknown,
          ) => Promise<{ content: Array<{ text: string }>; details: SearchDetails }>;
        }
      | undefined;
    registerSearchExtension(
      {
        on: vi.fn(),
        registerTool: (value: unknown) => {
          tool = value as typeof tool;
        },
      } as unknown as ExtensionAPI,
      runtime,
    );
    const result = await tool?.execute("one", { query: "docs" }, undefined, undefined, {
      cwd: "/tmp",
      model: { provider: "github-copilot", id: "parent" },
    });
    expect(result?.content[0]?.text).toContain("Untrusted external search results");
    expect(result?.details).toMatchObject({
      backend: "copilot-sdk",
      model: "observed-model",
      reasoningEffort: "none",
      sourceCount: 1,
      providerAccounted: true,
      costIncludedInPi: false,
    });
  });

  it("renders Copilot SDK backend details", () => {
    const details: SearchDetails = {
      backend: "copilot-sdk",
      kind: "web",
      model: "gpt-5.6-luna",
      queryCount: 1,
      resultCount: 1,
      sourceCount: 1,
      truncated: false,
      outputTruncated: false,
      sourcesTruncated: false,
      providerAccounted: true,
      usageStatus: "provider-accounted",
      costIncludedInPi: false,
      sourceUrls: ["https://example.com"],
      preview: "Evidence",
    };
    const theme = {
      fg: (_color: string, value: string) => value,
      bold: (value: string) => value,
    } as never;
    expect(
      renderSearchResult(
        { content: [{ type: "text", text: "done" }], details },
        { isPartial: false, expanded: false },
        theme,
      )
        .render(200)
        .join("\n"),
    ).toContain("Copilot SDK web search");
  });
});
