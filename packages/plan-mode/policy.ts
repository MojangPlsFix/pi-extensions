import { bashBlockReason } from "./bash-policy.js";

export { bashBlockReason } from "./bash-policy.js";

const directlyMutatingTools = new Set([
  "edit",
  "write",
  "apply_patch",
  "ctx_purge",
  "ctx_upgrade",
  "memory_write",
  "memory_update",
  "memory_delete",
  "memory_forget",
]);

const readOnlyTools = new Set([
  "read",
  "grep",
  "find",
  "ls",
  "bash",
  "ask_user_question",
  "ctx_execute",
  "ctx_execute_file",
  "ctx_batch_execute",
  "ctx_search",
  "ctx_fetch_and_index",
  "ctx_index",
  "ctx_stats",
  "ctx_doctor",
  "search",
  "subagent_spawn",
  "subagent_list",
  "subagent_read",
  "subagent_wait",
  "subagent_send",
  "subagent_interrupt",
]);

function normalizedToolName(toolName: string): string {
  return toolName.split(".").pop() ?? toolName;
}

export function isDirectlyDisabledInPlanMode(toolName: string): boolean {
  return directlyMutatingTools.has(normalizedToolName(toolName));
}

function action(input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const candidate = (input as Record<string, unknown>).action;
  return typeof candidate === "string" ? candidate : undefined;
}

export function planModeToolBlockReason(toolName: string, input: unknown): string | undefined {
  const name = normalizedToolName(toolName);
  if (isDirectlyDisabledInPlanMode(name))
    return `${name} is disabled because Plan Mode must not mutate project or environment state.`;
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
  if (readOnlyTools.has(name)) return undefined;
  return `Unreviewed third-party tool '${name}' is blocked in Plan Mode. Add a narrowly reviewed read-only policy before using it.`;
}
