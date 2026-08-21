import { bashBlockReason } from "./bash-policy.js";

export { bashBlockReason } from "./bash-policy.js";

/** Tools that must remain unavailable regardless of local Plan Mode configuration. */
export const ALWAYS_DISABLED_TOOLS = new Set([
  "edit",
  "write",
  "apply_patch",
  "memory_update",
  "memory_delete",
  "memory_forget",
  "ctx_execute",
  "ctx_execute_file",
  "ctx_batch_execute",
  "ctx_upgrade",
  "ctx_purge",
]);

let configuredTools = new Set<string>();

export function configurePlanModePolicy(config: { readOnlyTools?: string[] }): void {
  configuredTools = new Set((config.readOnlyTools ?? []).map(normalizedToolName));
}

const readOnlyTools = new Set([
  "read",
  "grep",
  "find",
  "ls",
  "bash",
  "ask_user_question",
  "memory_read",
  "memory_search",
  "ctx_search",
  "ctx_fetch_and_index",
  "ctx_index",
  "ctx_stats",
  "ctx_doctor",
  "search",
  "subagent_dispatch",
  "subagent_status",
  "subagent_collect",
  "subagent_steer",
  "subagent_stop",
  "repository_reference",
]);

function normalizedToolName(toolName: string): string {
  return toolName.split(".").pop() ?? toolName;
}

export function isDirectlyDisabledInPlanMode(toolName: string): boolean {
  return ALWAYS_DISABLED_TOOLS.has(normalizedToolName(toolName));
}

function action(input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const candidate = (input as Record<string, unknown>).action;
  return typeof candidate === "string" ? candidate : undefined;
}

function memoryWriteAllowed(input: unknown): boolean {
  if (!input || typeof input !== "object") return false;
  const value = input as Record<string, unknown>;
  const target = value.target;
  // memory_write defaults to append, but an explicit overwrite must never pass the guardrail.
  return (
    (target === "daily" || target === "long_term") &&
    (value.mode === undefined || value.mode === "append")
  );
}

export function planModeToolBlockReason(toolName: string, input: unknown): string | undefined {
  const name = normalizedToolName(toolName);
  if (isDirectlyDisabledInPlanMode(name))
    return `${name} is disabled because Plan Mode must not mutate project or environment state.`;
  if (name === "memory_write")
    return memoryWriteAllowed(input)
      ? undefined
      : "memory_write is limited to explicit append-only daily or long-term memory in Plan Mode.";
  if (name === "bash") {
    const command =
      input && typeof input === "object" ? (input as Record<string, unknown>).command : undefined;
    return typeof command === "string"
      ? bashBlockReason(command)
      : "Invalid Bash command in Plan Mode.";
  }
  if (name === "todo")
    return ["list", "list-all", "get"].includes(action(input) ?? "")
      ? undefined
      : "Todo mutation is blocked in Plan Mode; todos are not the authoritative plan state.";
  if (name === "scratchpad")
    return action(input) === "list" ? undefined : "Scratchpad mutation is blocked in Plan Mode.";
  if (readOnlyTools.has(name) || (configuredTools.has(name) && !isDirectlyDisabledInPlanMode(name)))
    return undefined;
  return `Unreviewed third-party tool '${name}' is blocked in Plan Mode. Add a narrowly reviewed read-only policy before using it.`;
}
