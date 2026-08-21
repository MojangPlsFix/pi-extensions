import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  CONTEXT_MODE_VERSION,
  contextModeDiagnostic,
  contextModeRoot,
  contextModeServer,
  contextModeVersion,
} from "./resolver.js";
import { resolveNodeRuntime } from "./runner.js";

export const BRIDGED_TOOLS = [
  "ctx_index",
  "ctx_search",
  "ctx_fetch_and_index",
  "ctx_stats",
  "ctx_doctor",
] as const;
export type BridgedToolName = (typeof BRIDGED_TOOLS)[number];

type BridgeCallResult = {
  content?: Array<{ type?: string; text?: string }>;
  isError?: boolean;
};
type BridgeClient = {
  start(): void;
  initialize(): Promise<void>;
  listTools(): Promise<Array<{ name: string; description?: string; inputSchema?: object }>>;
  callTool(name: string, args: object): Promise<BridgeCallResult>;
  shutdown(): void;
};
type BridgeModule = {
  MCPStdioClient: new (
    server: string,
    env?: NodeJS.ProcessEnv,
    runtimeOverride?: string | null,
    diag?: (line: string, level?: "warn" | "debug") => void,
  ) => BridgeClient;
  makeBridgeDiag?: (pi: unknown) => (line: string, level?: "warn" | "debug") => void;
  foregroundBridgeEnv?: (env: NodeJS.ProcessEnv, foreground: boolean) => NodeJS.ProcessEnv;
};

export type BridgeProgress = (text: string, details?: Record<string, unknown>) => void;

/**
 * Adapter boundary for the external ELv2 Context Mode runtime. Only bounded indexing, search,
 * fetch, and diagnostic tools cross this boundary; Pi-owned execution never uses the external
 * protocol. MCP has no cancellation field,
 * so an aborted caller stops waiting but cannot claim that the server-side operation was killed.
 */
export class ExternalContextBridge {
  private client: BridgeClient | undefined;
  private starting: Promise<void> | undefined;
  private readonly cwd: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly pi: unknown;

  constructor(cwd: string, pi?: unknown) {
    this.cwd = cwd;
    this.pi = pi;
    this.env = {
      ...process.env,
      CONTEXT_MODE_PROJECT_DIR: cwd,
      PI_PROJECT_DIR: cwd,
      PI_WORKSPACE_DIR: cwd,
    };
  }

  async start(): Promise<Array<{ name: string; description?: string; inputSchema?: object }>> {
    if (this.client) return this.client.listTools();
    if (!this.starting) this.starting = this.startOnce();
    try {
      await this.starting;
    } finally {
      this.starting = undefined;
    }
    const client = this.client as BridgeClient | undefined;
    return client ? client.listTools() : [];
  }

  async call(
    name: BridgedToolName,
    args: object,
    signal: AbortSignal | undefined,
    progress: BridgeProgress,
  ): Promise<BridgeCallResult> {
    if (!this.client) await this.start();
    const client = this.client;
    if (!client) throw new Error("Context Mode runtime is unavailable.");
    if (signal?.aborted) throw abortError();
    progress(`Running ${name} through the external Context Mode bridge…`, {
      status: "running",
      backend: "external-bridge",
      cancellation: "best-effort-external",
    });
    const operation = client.callTool(name, args);
    // MCP stdio has no request cancellation. Race the Pi call so the model is not held hostage,
    // while consuming the eventual promise to avoid an unhandled rejection after shutdown.
    void operation.catch(() => undefined);
    return raceAbort(operation, signal);
  }

  shutdown(): void {
    const client = this.client;
    this.client = undefined;
    try {
      client?.shutdown();
    } catch {
      // Shutdown must not mask a session or tool error.
    }
  }

  private async startOnce(): Promise<void> {
    const root = contextModeRoot(this.cwd);
    const server = root ? contextModeServer(root) : undefined;
    if (!root || !server) throw new Error(contextModeDiagnostic(this.cwd));
    const version = contextModeVersion(root);
    if (version && version !== CONTEXT_MODE_VERSION) {
      throw new Error(
        `Context Mode runtime ${version} is unsupported; install the pinned ${CONTEXT_MODE_VERSION} runtime.`,
      );
    }
    const modulePath = join(root, "build", "adapters", "pi", "mcp-bridge.js");
    const bridge = (await import(pathToFileURL(modulePath).href)) as BridgeModule;
    const runtime = resolveNodeRuntime();
    if (!runtime)
      throw new Error(
        "No safe Node runtime is available for the Context Mode bridge. Set PI_CONTEXT_MODE_NODE to the Node executable.",
      );
    const env =
      bridge.foregroundBridgeEnv?.(
        this.env,
        (this.pi as ExtensionContext | undefined)?.hasUI !== false,
      ) ?? this.env;
    const diag = bridge.makeBridgeDiag?.(this.pi) ?? (() => undefined);
    const client = new bridge.MCPStdioClient(server, env, runtime, diag);
    this.client = client;
    try {
      client.start();
      await client.initialize();
    } catch (error) {
      this.client = undefined;
      client.shutdown();
      throw error;
    }
  }
}

function abortError(): Error {
  const error = new Error(
    "Context Mode bridge call cancelled; external work may still be running.",
  );
  error.name = "AbortError";
  return error;
}

async function raceAbort<T>(operation: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return operation;
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(abortError());
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

export function bridgeText(result: BridgeCallResult): string {
  return (result.content ?? [])
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text as string)
    .join("\n");
}
