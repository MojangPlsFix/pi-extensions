import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { contextModeRoot, contextModeServer } from "./context-mode-resolver.js";

/** Context Mode without its Pi active-memory/session hooks or admin tools. */
export const READ_ONLY_TOOLS = [
  "ctx_index",
  "ctx_search",
  "ctx_fetch_and_index",
  "ctx_stats",
] as const;
/** File execution is execution-only just like shell and batch execution. */
export const EXECUTION_TOOLS = ["ctx_execute", "ctx_execute_file", "ctx_batch_execute"] as const;
export const ALLOWED_TOOLS = new Set<string>(READ_ONLY_TOOLS);

function allowedTools(): Set<string> {
  const allowed = new Set<string>(READ_ONLY_TOOLS);
  if (process.env.PI_SUBAGENT_CONTEXT_EXECUTION === "1")
    for (const tool of EXECUTION_TOOLS) allowed.add(tool);
  return allowed;
}

type McpClient = {
  start(): void;
  initialize(): Promise<void>;
  listTools(): Promise<Array<{ name: string; description?: string; inputSchema?: object }>>;
  callTool(
    name: string,
    args: object,
  ): Promise<{ content?: Array<{ type?: string; text?: string }>; isError?: boolean }>;
  shutdown(): void;
};

export function createIdempotentShutdown(state: {
  client?: Pick<McpClient, "shutdown">;
}): () => void {
  return () => {
    const client = state.client;
    state.client = undefined;
    try {
      client?.shutdown();
    } catch {
      // Startup/shutdown cleanup is best effort and must not mask the original failure.
    }
  };
}

export default function childContextModeExtension(pi: ExtensionAPI): void {
  const state: { client?: McpClient } = {};
  const shutdown = createIdempotentShutdown(state);
  pi.on("session_start", async (_event, ctx) => {
    const root = contextModeRoot();
    const server = root ? contextModeServer(root) : undefined;
    if (!root || !server) {
      ctx.ui.notify("Context Mode is unavailable: package not found.", "warning");
      return;
    }
    try {
      const bridge = (await import(
        pathToFileURL(join(root, "build", "adapters", "pi", "mcp-bridge.js")).href
      )) as {
        MCPStdioClient: new (server: string, env?: NodeJS.ProcessEnv) => McpClient;
      };
      state.client = new bridge.MCPStdioClient(server, process.env);
      state.client!.start();
      await state.client!.initialize();
      const allowed = allowedTools();
      for (const tool of await state.client!.listTools()) {
        if (!allowed.has(tool.name)) continue;
        pi.registerTool({
          name: tool.name,
          label: tool.name,
          description: tool.description ?? "",
          parameters: tool.inputSchema ?? { type: "object", properties: {} },
          async execute(_toolCallId, params) {
            const result = await state.client!.callTool(tool.name, (params ?? {}) as object);
            const text = (result.content ?? [])
              .filter((part) => part.type === "text" && typeof part.text === "string")
              .map((part) => part.text)
              .join("\n");
            if (result.isError) throw new Error(text || `${tool.name} failed`);
            return { content: [{ type: "text" as const, text }], details: {} };
          },
        });
      }
    } catch (error) {
      shutdown();
      ctx.ui.notify(
        `Context Mode is unavailable: ${error instanceof Error ? error.message : String(error)}`,
        "warning",
      );
    }
  });
  pi.on("session_shutdown", shutdown);
}
