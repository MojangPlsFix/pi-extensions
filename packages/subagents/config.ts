import { homedir } from "node:os";
import { join } from "node:path";

const agentRoot = process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent");

export const MAX_ACTIVE = 4;
export const MAX_WORKERS = 1;
export const SUBAGENT_ROOT = join(agentRoot, "subagents");
/** Trusted user-global agent definitions; project configuration is intentionally not loaded. */
export const AGENT_DIR = join(SUBAGENT_ROOT, "agents");
export const SESSION_ROOT = join(agentRoot, "sessions", "subagents");
/** Added only when Context Mode is positively available to the child. */
export const CONTEXT_TOOLS = [
  "ctx_execute_file",
  "ctx_index",
  "ctx_search",
  "ctx_fetch_and_index",
  "ctx_stats",
];
/** Explorers receive only read-only tools. Todo mutates shared state and is worker-only. */
export const EXPLORER_TOOLS = ["read", "grep", "find", "ls"];
export const WORKER_TOOLS = [...EXPLORER_TOOLS, "todo", "bash", "edit", "write"];
