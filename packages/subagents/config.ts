import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentDefinition } from "./types.js";

const agentRoot = process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent");

export const MAX_ACTIVE = 4;
export const MAX_WORKERS = 1;
export const SUBAGENT_ROOT = join(agentRoot, "subagents");
/** Trusted user-global agent definitions; project configuration is intentionally not loaded. */
export const AGENT_DIR = join(SUBAGENT_ROOT, "agents");
export const CONFIG_PATH = join(SUBAGENT_ROOT, "config.json");
/** Hidden from Pi's built-in /resume picker. */
export const SESSION_ROOT = join(SUBAGENT_ROOT, "sessions");
/** Previous transcript location, retained for Stats and optional manual migration. */
export const LEGACY_SESSION_ROOT = join(agentRoot, "sessions", "subagents");

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingPolicy = (typeof THINKING_LEVELS)[number] | "inherit";
export type ModelPolicy = string | "inherit";
export type AgentModelPolicy = { model?: ModelPolicy; thinking?: ThinkingPolicy };
export type SubagentConfig = {
  defaults?: AgentModelPolicy;
  agents?: Record<string, AgentModelPolicy>;
};

export const DEFAULT_SUBAGENT_CONFIG: Required<SubagentConfig> = {
  defaults: { model: "inherit", thinking: "inherit" },
  agents: {
    explorer: { model: "inherit", thinking: "inherit" },
    worker: { model: "inherit", thinking: "inherit" },
  },
};

function policy(value: unknown, location: string): AgentModelPolicy {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${location} must be an object.`);
  const candidate = value as Record<string, unknown>;
  const model = candidate.model;
  const thinking = candidate.thinking;
  if (model !== undefined && (typeof model !== "string" || !model.trim()))
    throw new Error(`${location}.model must be a model id or "inherit".`);
  if (
    thinking !== undefined &&
    (typeof thinking !== "string" ||
      !["inherit", ...THINKING_LEVELS].includes(thinking as ThinkingPolicy))
  )
    throw new Error(`${location}.thinking is not a supported thinking level.`);
  return {
    ...(typeof model === "string" ? { model: model.trim() } : {}),
    ...(typeof thinking === "string" ? { thinking: thinking as ThinkingPolicy } : {}),
  };
}

export async function loadSubagentConfig(path = CONFIG_PATH): Promise<SubagentConfig> {
  let source: string;
  try {
    source = await fs.readFile(path, "utf8");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return DEFAULT_SUBAGENT_CONFIG;
    throw cause;
  }
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch (cause) {
    throw new Error(
      `Invalid Subagent configuration at ${path}: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`Invalid Subagent configuration at ${path}: root must be an object.`);
  const config = value as Record<string, unknown>;
  if (
    config.agents !== undefined &&
    (!config.agents || typeof config.agents !== "object" || Array.isArray(config.agents))
  )
    throw new Error(`Invalid Subagent configuration at ${path}: agents must be an object.`);
  const agents = Object.fromEntries(
    Object.entries((config.agents as Record<string, unknown> | undefined) ?? {}).map(
      ([name, entry]) => [name, policy(entry, `agents.${name}`)],
    ),
  );
  return {
    ...(config.defaults === undefined ? {} : { defaults: policy(config.defaults, "defaults") }),
    ...(config.agents === undefined ? {} : { agents }),
  };
}

function resolvePolicy(
  values: Array<string | undefined>,
  inherited: string | undefined,
): string | undefined {
  for (const value of values) {
    if (value === undefined) continue;
    return value === "inherit" ? inherited : value;
  }
  return inherited;
}

/** Resolve once at spawn: role config → custom frontmatter → defaults → parent. */
export function resolveAgentModelPolicy(
  definition: AgentDefinition,
  config: SubagentConfig,
  parentModel: string | undefined,
  parentThinking: string | undefined,
): { model?: string; thinking?: string } {
  const configured = config.agents?.[definition.name];
  return {
    model: resolvePolicy(
      [
        configured?.model,
        definition.source === "user" ? definition.model : undefined,
        config.defaults?.model,
      ],
      parentModel,
    ),
    thinking: resolvePolicy(
      [
        configured?.thinking,
        definition.source === "user" ? definition.thinking : undefined,
        config.defaults?.thinking,
      ],
      parentThinking,
    ),
  };
}

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
