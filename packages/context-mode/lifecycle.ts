import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { contextModeDiagnostic, contextModeRoot } from "./resolver.js";

type UpstreamExtension = (pi: ExtensionAPI) => void;
type Handler = (...args: any[]) => any;

let upstreamExtension: UpstreamExtension | undefined;
let upstreamLoadError: string | undefined;

const root = contextModeRoot();
if (root) {
  try {
    const module = (await import(
      pathToFileURL(join(root, "build", "adapters", "pi", "extension.js")).href
    )) as { default?: UpstreamExtension };
    upstreamExtension = module.default;
    if (typeof upstreamExtension !== "function")
      upstreamLoadError =
        "Pinned Context Mode Pi lifecycle module has no default extension export.";
  } catch (error) {
    upstreamLoadError = error instanceof Error ? error.message : String(error);
  }
} else {
  upstreamLoadError = contextModeDiagnostic();
}

const ROUTING_ANCHOR =
  "context-mode active. Hierarchy: ctx_batch_execute > ctx_execute > ctx_execute_file > ctx_search. " +
  "Read/analyze one file → ctx_execute_file. Multi-command research → ctx_batch_execute. " +
  "Web pages → ctx_fetch_and_index then ctx_search. Index docs → ctx_index. " +
  "Stats → ctx_stats. Diagnostics → ctx_doctor.";

export function sanitizeInjectedRouting(messages: unknown): void {
  if (!Array.isArray(messages)) return;
  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    const record = message as { role?: unknown; content?: unknown };
    if (record.role !== "user" || typeof record.content !== "string") continue;
    if (!record.content.startsWith("context-mode active.")) continue;
    const [, ...rest] = record.content.split("\n\n");
    record.content = [ROUTING_ANCHOR, ...rest].join("\n\n");
  }
}

async function withoutUpstreamBridge<T>(operation: () => T | Promise<T>): Promise<T> {
  const previous = process.env.CONTEXT_MODE_BRIDGE_DEPTH;
  process.env.CONTEXT_MODE_BRIDGE_DEPTH = "1";
  try {
    return await operation();
  } finally {
    if (previous === undefined) delete process.env.CONTEXT_MODE_BRIDGE_DEPTH;
    else process.env.CONTEXT_MODE_BRIDGE_DEPTH = previous;
  }
}

export function normalizeLifecycleToolResult(event: unknown): unknown {
  if (!event || typeof event !== "object") return event;
  const record = event as { toolName?: unknown; tool_name?: unknown };
  const raw = String(record.toolName ?? record.tool_name ?? "");
  if (!raw.startsWith("ctx_")) return event;
  return { ...record, toolName: `context_mode_${raw}` };
}

function lifecycleApi(pi: ExtensionAPI): ExtensionAPI {
  return new Proxy(pi, {
    get(target, property, receiver) {
      if (property === "registerTool") return () => undefined;
      if (property === "logger") {
        const logger = Reflect.get(target as object, property, receiver) as
          | {
              debug?: (message: string, context?: Record<string, unknown>) => void;
              info?: (message: string, context?: Record<string, unknown>) => void;
              warn?: (message: string, context?: Record<string, unknown>) => void;
              error?: (message: string, context?: Record<string, unknown>) => void;
            }
          | undefined;
        if (!logger) return undefined;
        const keep = (callback: typeof logger.warn) =>
          callback
            ? (message: string, context?: Record<string, unknown>) => {
                if (/CONTEXT_MODE_BRIDGE_DEPTH|skipping MCP bridge/iu.test(message)) return;
                callback.call(logger, message, context);
              }
            : undefined;
        return {
          debug: keep(logger.debug),
          info: keep(logger.info),
          warn: keep(logger.warn),
          error: keep(logger.error),
        };
      }
      if (property === "on") {
        return (event: string, handler: Handler) => {
          if (event === "before_agent_start") {
            return pi.on(
              event as never,
              ((...args: unknown[]) => withoutUpstreamBridge(() => handler(...args))) as never,
            );
          }
          if (event === "tool_result") {
            return pi.on(
              event as never,
              ((toolEvent: unknown, ...args: unknown[]) =>
                handler(normalizeLifecycleToolResult(toolEvent), ...args)) as never,
            );
          }
          if (event === "context") {
            return pi.on(
              event as never,
              ((...args: unknown[]) => {
                const result = handler(...args);
                if (result && typeof result.then === "function") {
                  return Promise.resolve(result).then((value) => {
                    sanitizeInjectedRouting(
                      (args[0] as { messages?: unknown } | undefined)?.messages,
                    );
                    sanitizeInjectedRouting(
                      (value as { messages?: unknown } | undefined)?.messages,
                    );
                    return value;
                  });
                }
                sanitizeInjectedRouting((args[0] as { messages?: unknown } | undefined)?.messages);
                sanitizeInjectedRouting((result as { messages?: unknown } | undefined)?.messages);
                return result;
              }) as never,
            );
          }
          return pi.on(event as never, handler as never);
        };
      }
      const value = Reflect.get(target as object, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** Register the pinned upstream session lifecycle while suppressing its duplicate MCP tool bridge. */
export function registerContextLifecycle(pi: ExtensionAPI): void {
  if (!upstreamExtension) {
    const logger = (pi as unknown as { logger?: { warn?: (message: string) => void } }).logger;
    logger?.warn?.(
      `Context Mode session continuity is unavailable: ${upstreamLoadError ?? "unknown lifecycle load error"}`,
    );
    return;
  }
  upstreamExtension(lifecycleApi(pi));
}

export { ROUTING_ANCHOR };
