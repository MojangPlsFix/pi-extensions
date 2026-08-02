import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { contextModeRoot, contextModeServer } from "./context-mode-resolver.js";

/** Context Mode without its Pi active-memory/session hooks or admin tools. */
export const ALLOWED_TOOLS = new Set([
  "ctx_execute_file",
  "ctx_index",
  "ctx_search",
  "ctx_fetch_and_index",
  "ctx_stats",
]);

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

export default function childContextModeExtension(pi: ExtensionAPI): void {
  let shutdown: (() => void) | undefined;
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
      const client = new bridge.MCPStdioClient(server, process.env);
      client.start();
      await client.initialize();
      for (const tool of await client.listTools()) {
        if (!ALLOWED_TOOLS.has(tool.name)) continue;
        pi.registerTool({
          name: tool.name,
          label: tool.name,
          description: tool.description ?? "",
          parameters: tool.inputSchema ?? { type: "object", properties: {} },
          async execute(_toolCallId, params) {
            const result = await client.callTool(tool.name, (params ?? {}) as object);
            const text = (result.content ?? [])
              .filter((part) => part.type === "text" && typeof part.text === "string")
              .map((part) => part.text)
              .join("\n");
            if (result.isError) throw new Error(text || `${tool.name} failed`);
            return { content: [{ type: "text" as const, text }], details: {} };
          },
        });
      }
      shutdown = () => client.shutdown();
    } catch (error) {
      ctx.ui.notify(
        `Context Mode is unavailable: ${error instanceof Error ? error.message : String(error)}`,
        "warning",
      );
    }
  });
  pi.on("session_shutdown", () => shutdown?.());
}
