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

const ROUTING_PREFIX = "context-mode active.";

/** Build routing guidance from one authoritative Pi active-tool snapshot. */
export function contextRoutingAnchor(activeTools: readonly string[]): string {
  const active = new Set(activeTools);
  const guidance: string[] = [];

  if (active.has("read")) guidance.push("Exact file reads → read.");
  if (active.has("ctx_execute_file"))
    guidance.push(
      "Code-driven analysis of one file → ctx_execute_file (not for exact file retrieval).",
    );
  if (active.has("ctx_execute")) guidance.push("General code-driven analysis → ctx_execute.");
  if (active.has("ctx_batch_execute")) guidance.push("Multi-command research → ctx_batch_execute.");
  if (active.has("ctx_search")) guidance.push("Search indexed material → ctx_search.");
  if (active.has("ctx_fetch_and_index") && active.has("ctx_search"))
    guidance.push("Web pages → ctx_fetch_and_index then ctx_search.");
  if (active.has("ctx_index")) guidance.push("Index documents → ctx_index.");
  if (active.has("ctx_stats")) guidance.push("Index and search statistics → ctx_stats.");
  if (active.has("ctx_doctor")) guidance.push("Runtime diagnostics → ctx_doctor.");

  return guidance.length === 0 ? ROUTING_PREFIX : `${ROUTING_PREFIX} ${guidance.join(" ")}`;
}

export const ROUTING_ANCHOR = contextRoutingAnchor([
  "read",
  "ctx_execute_file",
  "ctx_execute",
  "ctx_batch_execute",
  "ctx_search",
  "ctx_fetch_and_index",
  "ctx_index",
  "ctx_stats",
  "ctx_doctor",
]);

/** Replace only the first routing paragraph; any memory/content suffix remains byte-for-byte. */
export function sanitizeInjectedRouting(messages: unknown, routingAnchor = ROUTING_ANCHOR): void {
  if (!Array.isArray(messages)) return;
  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    const record = message as { role?: unknown; content?: unknown };
    if (record.role !== "user" || typeof record.content !== "string") continue;
    if (!record.content.startsWith(ROUTING_PREFIX)) continue;
    const paragraphBreak = /\r?\n\r?\n/u.exec(record.content);
    const suffix = paragraphBreak ? record.content.slice(paragraphBreak.index) : "";
    record.content = `${routingAnchor}${suffix}`;
  }
}

function activeRoutingAnchor(pi: ExtensionAPI): string {
  try {
    return contextRoutingAnchor(pi.getActiveTools());
  } catch {
    // A stale/replaced runtime can make the active-tool lookup unavailable. Never guess visibility.
    return ROUTING_PREFIX;
  }
}

function applySettledRouting(pi: ExtensionAPI, event: unknown, result: unknown): void {
  // Use exactly one snapshot for the mutable event and any separately returned message array.
  const routingAnchor = activeRoutingAnchor(pi);
  sanitizeInjectedRouting((event as { messages?: unknown } | undefined)?.messages, routingAnchor);
  sanitizeInjectedRouting(
    Array.isArray(result) ? result : (result as { messages?: unknown } | undefined)?.messages,
    routingAnchor,
  );
}

/** Run an upstream context hook and route only after its synchronous/async work has settled. */
export function runContextHandlerWithRouting(
  pi: ExtensionAPI,
  handler: Handler,
  args: unknown[],
): unknown {
  let result: unknown;
  try {
    result = handler(...args);
  } catch (error) {
    applySettledRouting(pi, args[0], undefined);
    throw error;
  }
  if (result && typeof (result as { then?: unknown }).then === "function") {
    return Promise.resolve(result).then(
      (value) => {
        applySettledRouting(pi, args[0], value);
        return value;
      },
      (error: unknown) => {
        applySettledRouting(pi, args[0], undefined);
        throw error;
      },
    );
  }
  applySettledRouting(pi, args[0], result);
  return result;
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
              ((...args: unknown[]) => runContextHandlerWithRouting(pi, handler, args)) as never,
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
