import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import contextModeExtension from "../context-mode/index.js";

/** Read-only child Context Mode compatibility entrypoint. The implementation lives in the package owner. */
export const READ_ONLY_TOOLS = [
  "ctx_index",
  "ctx_search",
  "ctx_fetch_and_index",
  "ctx_stats",
] as const;
export const EXECUTION_TOOLS = ["ctx_execute", "ctx_execute_file", "ctx_batch_execute"] as const;
export const ALLOWED_TOOLS = new Set<string>(READ_ONLY_TOOLS);

type ShutdownClient = { shutdown(): void };

export function createIdempotentShutdown(state: { client?: ShutdownClient }): () => void {
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

/** @deprecated Kept as a stable child extension path; use packages/context-mode directly elsewhere. */
export default function childContextModeExtension(pi: ExtensionAPI): void {
  contextModeExtension(pi);
}
