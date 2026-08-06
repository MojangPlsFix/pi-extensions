import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  AgentDefinition,
  ChildDetectedResources,
  ChildEffectiveResources,
  ChildResourcePolicy,
  Mode,
  OptionalIntegrationPolicy,
  ResolvedChildResourcePolicy,
} from "./types.js";

export type {
  ChildDetectedResources,
  ChildEffectiveResources,
  ChildResourcePolicy,
  OptionalIntegrationPolicy,
  ResolvedChildResourcePolicy,
} from "./types.js";

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
export type AgentResourceOverrides = ChildResourcePolicy;
export type AgentModelPolicy = {
  model?: ModelPolicy;
  thinking?: ThinkingPolicy;
  resources?: AgentResourceOverrides;
};
export type SubagentConfig = {
  defaults?: AgentModelPolicy;
  agents?: Record<string, AgentModelPolicy>;
};

export const BUILTIN_RESOURCE_PROFILES: Record<Mode, ResolvedChildResourcePolicy> = {
  explorer: {
    contextMode: "auto",
    contextExecution: false,
    webSearch: true,
    todos: false,
    rtk: "disabled",
    uv: "disabled",
  },
  worker: {
    contextMode: "auto",
    contextExecution: true,
    webSearch: false,
    todos: true,
    rtk: "auto",
    uv: "auto",
  },
};

export const DEFAULT_SUBAGENT_CONFIG: Required<SubagentConfig> = {
  defaults: { model: "inherit", thinking: "inherit" },
  agents: {
    explorer: { model: "inherit", thinking: "inherit" },
    worker: { model: "inherit", thinking: "inherit" },
  },
};

const RESOURCE_KEYS = [
  "contextMode",
  "contextExecution",
  "webSearch",
  "todos",
  "rtk",
  "uv",
] as const;
const POLICY_KEYS = new Set(["contextMode", "rtk", "uv"]);
const BOOLEAN_RESOURCE_KEYS = new Set(["contextExecution", "webSearch", "todos"]);
const MODELS_KEYS = new Set(["model", "thinking", "resources"]);

function policy(value: unknown, location: string): AgentModelPolicy {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${location} must be an object.`);
  const candidate = value as Record<string, unknown>;
  for (const key of Object.keys(candidate))
    if (!MODELS_KEYS.has(key)) throw new Error(`${location}.${key} is not supported.`);
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
  const resources =
    candidate.resources === undefined
      ? undefined
      : resourceOverrides(candidate.resources, `${location}.resources`);
  return {
    ...(typeof model === "string" ? { model: model.trim() } : {}),
    ...(typeof thinking === "string" ? { thinking: thinking as ThinkingPolicy } : {}),
    ...(resources ? { resources } : {}),
  };
}

function resourceOverrides(value: unknown, location: string): AgentResourceOverrides {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${location} must be an object.`);
  const candidate = value as Record<string, unknown>;
  for (const key of Object.keys(candidate))
    if (!RESOURCE_KEYS.includes(key as (typeof RESOURCE_KEYS)[number]))
      throw new Error(`${location}.${key} is not a supported child resource.`);
  const result: AgentResourceOverrides = {};
  for (const key of RESOURCE_KEYS) {
    const valueForKey = candidate[key];
    if (valueForKey === undefined) continue;
    if (POLICY_KEYS.has(key)) {
      if (typeof valueForKey !== "string" || !["auto", "enabled", "disabled"].includes(valueForKey))
        throw new Error(`${location}.${key} must be "auto", "enabled", or "disabled".`);
      if (key === "contextMode" || key === "rtk" || key === "uv")
        result[key] = valueForKey as OptionalIntegrationPolicy;
    } else if (BOOLEAN_RESOURCE_KEYS.has(key)) {
      if (typeof valueForKey !== "boolean")
        throw new Error(`${location}.${key} must be a boolean.`);
      if (key === "contextExecution") result.contextExecution = valueForKey;
      else if (key === "webSearch") result.webSearch = valueForKey;
      else if (key === "todos") result.todos = valueForKey;
    }
  }
  return result;
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
  for (const key of Object.keys(config))
    if (key !== "defaults" && key !== "agents")
      throw new Error(`Invalid Subagent configuration at ${path}: ${key} is not supported.`);
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
  const parsed: SubagentConfig = {
    ...(config.defaults === undefined ? {} : { defaults: policy(config.defaults, "defaults") }),
    ...(config.agents === undefined ? {} : { agents }),
  };
  // Validate mode-specific capability boundaries while loading, before spawn allocation.
  resolveAgentResourcePolicy(
    {
      name: "explorer",
      description: "builtin",
      mode: "explorer",
      prompt: "",
      source: "builtin",
    },
    parsed,
  );
  resolveAgentResourcePolicy(
    {
      name: "worker",
      description: "builtin",
      mode: "worker",
      prompt: "",
      source: "builtin",
    },
    parsed,
  );
  return parsed;
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

/** Resolve once at spawn: exact agent config → custom frontmatter → defaults → parent. */
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

function mergeResourceOverrides(
  base: ResolvedChildResourcePolicy,
  ...overrides: Array<AgentResourceOverrides | undefined>
): ResolvedChildResourcePolicy {
  const result = { ...base };
  for (const override of overrides) Object.assign(result, override ?? {});
  return result;
}

/** Resolve resource policy in the documented mode-profile/default/mode/exact order. */
export function resolveAgentResourcePolicy(
  definition: AgentDefinition,
  config: SubagentConfig,
): ResolvedChildResourcePolicy {
  const modeEntry = config.agents?.[definition.mode]?.resources;
  const exactEntry = config.agents?.[definition.name]?.resources;
  const result = mergeResourceOverrides(
    BUILTIN_RESOURCE_PROFILES[definition.mode],
    config.defaults?.resources,
    modeEntry,
    exactEntry,
  );
  if (result.contextMode === "disabled" && result.contextExecution)
    throw new Error("contextExecution cannot be enabled when contextMode is disabled.");
  if (definition.mode === "explorer") {
    if (result.contextExecution) throw new Error("Explorer contextExecution cannot be enabled.");
    if (result.todos) throw new Error("Explorer todos cannot be enabled.");
    if (result.rtk !== "disabled") throw new Error("Explorer rtk cannot be enabled.");
    if (result.uv !== "disabled") throw new Error("Explorer uv cannot be enabled.");
  }
  return result;
}

export function effectiveAgentResources(
  requested: ResolvedChildResourcePolicy,
  detected: ChildDetectedResources,
): ChildEffectiveResources {
  const contextMode = requested.contextMode !== "disabled" && detected.contextMode;
  return {
    contextMode,
    contextExecution: requested.contextExecution && contextMode && detected.contextExecution,
    webSearch: requested.webSearch && detected.webSearch,
    todos: requested.todos && detected.todos,
    rtk: requested.rtk !== "disabled" && detected.rtk,
    uv: requested.uv !== "disabled" && detected.uv,
  };
}

/** Added only when Context Mode is positively available to the child. */
export const CONTEXT_TOOLS = [
  "ctx_execute_file",
  "ctx_index",
  "ctx_search",
  "ctx_fetch_and_index",
  "ctx_stats",
] as const;
export const CONTEXT_EXECUTION_TOOLS = ["ctx_execute", "ctx_batch_execute"] as const;
/** Explorers receive only read-only tools. Todo mutates shared state and is worker-only. */
export const EXPLORER_TOOLS = ["read", "grep", "find", "ls"] as const;
export const WORKER_TOOLS = [...EXPLORER_TOOLS, "todo", "bash", "edit", "write"] as const;
