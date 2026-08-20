import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  type CapabilityDefinition,
  type EffectiveCapabilityPolicy,
  selectEffectiveCapabilities,
  validateCapabilityCatalog,
} from "./capabilities.js";
import { HerdrClient } from "./herdr-client.js";
import type { AgentDefinition } from "./types.js";

export const PI_AGENT_DIR =
  process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent");
export const MAX_ACTIVE = 4;
export const MAX_SHARED_WRITERS = 1;
export const MAX_DEPTH = 2;
export const DEFAULT_RETENTION_DAYS = 30;
export const DEFAULT_RETENTION_ENTRIES = 200;
export const SUBAGENT_ROOT = join(PI_AGENT_DIR, "subagents");
export const AGENT_DIR = join(SUBAGENT_ROOT, "agents");
export const CONFIG_PATH = join(SUBAGENT_ROOT, "config.json");
export const SESSION_ROOT = join(SUBAGENT_ROOT, "sessions");

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingPolicy = (typeof THINKING_LEVELS)[number] | "inherit";
export type ModelPolicy = string | "inherit";
export type ModelSelection = { model?: ModelPolicy; thinking?: ThinkingPolicy };
export type RuntimeLimits = { maxActive: number; maxSharedWriters: number; maxDepth: number };
export type RetentionPolicy = { days: number; entries: number };
export type ModelDefaults = {
  default?: ModelSelection;
  overrides: Record<string, ModelSelection>;
};
export type ExternalRunnerDefinition = {
  command: string;
  args: string[];
  envAllowlist: string[];
  timeoutMs: number;
  maxOutputBytes: number;
};
export type HerdrInspectorSettings = {
  enabled: boolean;
  direction: "right" | "down";
  maxOutputBytes: number;
};
export type ProfileControl = {
  enabled?: boolean;
  disabled?: boolean;
  ejected?: boolean;
  note?: string;
};
export type SubagentConfig = {
  schemaVersion: 2;
  runtime: RuntimeLimits;
  retention: RetentionPolicy;
  models: ModelDefaults;
  capabilities: Record<string, CapabilityDefinition>;
  runners: Record<string, ExternalRunnerDefinition>;
  herdr: HerdrInspectorSettings;
  profiles: Record<string, ProfileControl>;
};

export function herdrEnvironmentAvailable(env: NodeJS.ProcessEnv = process.env): boolean {
  return HerdrClient.environmentState(env) === "complete";
}

export const DEFAULT_SUBAGENT_CONFIG: SubagentConfig = {
  schemaVersion: 2,
  runtime: { maxActive: MAX_ACTIVE, maxSharedWriters: MAX_SHARED_WRITERS, maxDepth: MAX_DEPTH },
  retention: { days: DEFAULT_RETENTION_DAYS, entries: DEFAULT_RETENTION_ENTRIES },
  models: { overrides: {} },
  capabilities: {},
  runners: {},
  herdr: { enabled: herdrEnvironmentAvailable(), direction: "right", maxOutputBytes: 1_000_000 },
  profiles: {},
};

function cloneDefault(): SubagentConfig {
  return {
    ...DEFAULT_SUBAGENT_CONFIG,
    runtime: { ...DEFAULT_SUBAGENT_CONFIG.runtime },
    retention: { ...DEFAULT_SUBAGENT_CONFIG.retention },
    models: { overrides: {} },
    capabilities: {},
    runners: {},
    herdr: { ...DEFAULT_SUBAGENT_CONFIG.herdr },
    profiles: {},
  };
}

function object(value: unknown, location: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${location} must be an object.`);
  return value as Record<string, unknown>;
}

function integer(value: unknown, location: string, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max)
    throw new Error(`${location} must be an integer between ${min} and ${max}.`);
  return value;
}

function nonEmptyString(value: unknown, location: string): string {
  if (typeof value !== "string" || !value.trim())
    throw new Error(`${location} must be a non-empty string.`);
  return value.trim();
}

function only(value: Record<string, unknown>, keys: readonly string[], location: string): void {
  const allowed = new Set(keys);
  for (const key of Object.keys(value))
    if (!allowed.has(key)) throw new Error(`${location}.${key} is not supported.`);
}

function parseRuntime(value: unknown, location = "runtime"): RuntimeLimits {
  const candidate = object(value, location);
  only(candidate, ["maxActive", "maxSharedWriters", "maxDepth"], location);
  return {
    maxActive: integer(candidate.maxActive ?? MAX_ACTIVE, `${location}.maxActive`, 1, 32),
    maxSharedWriters: integer(
      candidate.maxSharedWriters ?? MAX_SHARED_WRITERS,
      `${location}.maxSharedWriters`,
      0,
      8,
    ),
    maxDepth: integer(candidate.maxDepth ?? MAX_DEPTH, `${location}.maxDepth`, 0, MAX_DEPTH),
  };
}

function parseRetention(value: unknown, location = "retention"): RetentionPolicy {
  const candidate = object(value, location);
  only(candidate, ["days", "entries"], location);
  return {
    days: integer(candidate.days ?? DEFAULT_RETENTION_DAYS, `${location}.days`, 1, 3650),
    entries: integer(
      candidate.entries ?? DEFAULT_RETENTION_ENTRIES,
      `${location}.entries`,
      1,
      10_000,
    ),
  };
}

function parseModelSelection(value: unknown, location: string): ModelSelection {
  const candidate = object(value, location);
  only(candidate, ["model", "thinking"], location);
  const result: ModelSelection = {};
  if (candidate.model !== undefined)
    result.model = nonEmptyString(candidate.model, `${location}.model`);
  if (candidate.thinking !== undefined) {
    const thinking = nonEmptyString(candidate.thinking, `${location}.thinking`);
    if (thinking !== "inherit" && !(THINKING_LEVELS as readonly string[]).includes(thinking))
      throw new Error(`${location}.thinking is not a supported thinking level.`);
    result.thinking = thinking as ThinkingPolicy;
  }
  return result;
}

function parseModels(value: unknown): ModelDefaults {
  const candidate = object(value, "models");
  only(candidate, ["default", "overrides"], "models");
  const overrides: Record<string, ModelSelection> = {};
  if (candidate.overrides !== undefined)
    for (const [name, selection] of Object.entries(object(candidate.overrides, "models.overrides")))
      overrides[name] = parseModelSelection(selection, `models.overrides.${name}`);
  return {
    ...(candidate.default === undefined
      ? {}
      : { default: parseModelSelection(candidate.default, "models.default") }),
    overrides,
  };
}

function stringList(value: unknown, location: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || !entry.trim()))
    throw new Error(`${location} must be an array of non-empty strings.`);
  return value.map((entry) => (entry as string).trim());
}

function parseRunners(value: unknown): Record<string, ExternalRunnerDefinition> {
  const result: Record<string, ExternalRunnerDefinition> = {};
  for (const [name, raw] of Object.entries(object(value, "runners"))) {
    const runner = object(raw, `runners.${name}`);
    only(
      runner,
      ["command", "args", "envAllowlist", "timeoutMs", "maxOutputBytes"],
      `runners.${name}`,
    );
    result[name] = {
      command: nonEmptyString(runner.command, `runners.${name}.command`),
      args: runner.args === undefined ? [] : stringList(runner.args, `runners.${name}.args`),
      envAllowlist:
        runner.envAllowlist === undefined
          ? []
          : stringList(runner.envAllowlist, `runners.${name}.envAllowlist`),
      timeoutMs: integer(runner.timeoutMs ?? 300_000, `runners.${name}.timeoutMs`, 1, 86_400_000),
      maxOutputBytes: integer(
        runner.maxOutputBytes ?? 1_000_000,
        `runners.${name}.maxOutputBytes`,
        1,
        100_000_000,
      ),
    };
  }
  return result;
}

function parseHerdr(value: unknown): HerdrInspectorSettings {
  const candidate = object(value, "herdr");
  only(candidate, ["enabled", "direction", "maxOutputBytes"], "herdr");
  if (candidate.enabled !== undefined && typeof candidate.enabled !== "boolean")
    throw new Error("herdr.enabled must be a boolean.");
  const direction = candidate.direction ?? "right";
  if (direction !== "right" && direction !== "down")
    throw new Error("herdr.direction must be right or down.");
  return {
    enabled:
      candidate.enabled === undefined ? herdrEnvironmentAvailable() : candidate.enabled === true,
    direction,
    maxOutputBytes: integer(
      candidate.maxOutputBytes ?? 1_000_000,
      "herdr.maxOutputBytes",
      1,
      100_000_000,
    ),
  };
}

function parseProfiles(value: unknown): Record<string, ProfileControl> {
  const profiles: Record<string, ProfileControl> = {};
  for (const [name, raw] of Object.entries(object(value, "profiles"))) {
    const control = object(raw, `profiles.${name}`);
    only(control, ["enabled", "disabled", "ejected", "note"], `profiles.${name}`);
    for (const key of ["enabled", "disabled", "ejected"] as const)
      if (control[key] !== undefined && typeof control[key] !== "boolean")
        throw new Error(`profiles.${name}.${key} must be a boolean.`);
    if (
      typeof control.enabled === "boolean" &&
      typeof control.disabled === "boolean" &&
      control.enabled === control.disabled
    )
      throw new Error(
        `profiles.${name}.enabled and profiles.${name}.disabled must describe the same state.`,
      );
    if (control.note !== undefined && typeof control.note !== "string")
      throw new Error(`profiles.${name}.note must be a string.`);
    profiles[name] = {
      ...(typeof control.enabled === "boolean" ? { enabled: control.enabled } : {}),
      ...(typeof control.disabled === "boolean" ? { disabled: control.disabled } : {}),
      ...(typeof control.ejected === "boolean" ? { ejected: control.ejected } : {}),
      ...(typeof control.note === "string" && control.note.trim()
        ? { note: control.note.trim() }
        : {}),
    };
  }
  return profiles;
}

export async function loadSubagentConfig(
  path = CONFIG_PATH,
  options: { source?: "global" | "project" } = {},
): Promise<SubagentConfig> {
  let source: string;
  try {
    source = await fs.readFile(path, "utf8");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return cloneDefault();
    throw cause;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(source);
  } catch (cause) {
    throw new Error(
      `Invalid Subagent configuration at ${path}: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
  const config = object(raw, `Invalid Subagent configuration at ${path}`);
  only(
    config,
    [
      "schemaVersion",
      "runtime",
      "retention",
      "models",
      "capabilities",
      "runners",
      "herdr",
      "profiles",
    ],
    path,
  );
  if (config.schemaVersion !== 2)
    throw new Error(`Invalid Subagent configuration at ${path}: schemaVersion must be 2.`);
  return {
    schemaVersion: 2,
    runtime:
      config.runtime === undefined
        ? { ...DEFAULT_SUBAGENT_CONFIG.runtime }
        : parseRuntime(config.runtime),
    retention:
      config.retention === undefined
        ? { ...DEFAULT_SUBAGENT_CONFIG.retention }
        : parseRetention(config.retention),
    models: config.models === undefined ? { overrides: {} } : parseModels(config.models),
    capabilities:
      config.capabilities === undefined
        ? {}
        : validateCapabilityCatalog(config.capabilities, {
            source: options.source === "project" ? "project" : "user",
          }),
    runners: config.runners === undefined ? {} : parseRunners(config.runners),
    herdr:
      config.herdr === undefined ? { ...DEFAULT_SUBAGENT_CONFIG.herdr } : parseHerdr(config.herdr),
    profiles: config.profiles === undefined ? {} : parseProfiles(config.profiles),
  };
}

function resolvePolicy(
  values: Array<string | undefined>,
  inherited: string | undefined,
): string | undefined {
  for (const value of values)
    if (value !== undefined) return value === "inherit" ? inherited : value;
  return inherited;
}

export function resolveAgentModelPolicy(
  definition: AgentDefinition,
  config: SubagentConfig,
  parentModel: string | undefined,
  parentThinking: string | undefined,
  explicit?: string | ModelSelection,
): { model?: string; thinking?: string } {
  const override = config.models.overrides[definition.name];
  const requested = typeof explicit === "string" ? { model: explicit } : explicit;
  return {
    model: resolvePolicy(
      [requested?.model, override?.model, definition.model, config.models.default?.model],
      parentModel,
    ),
    thinking: resolvePolicy(
      [
        requested?.thinking,
        override?.thinking,
        definition.thinking,
        config.models.default?.thinking,
      ],
      parentThinking,
    ),
  };
}

export function resolveAgentCapabilities(
  definition: AgentDefinition,
  config: SubagentConfig,
  allowedCapabilities?: readonly string[],
): EffectiveCapabilityPolicy {
  return selectEffectiveCapabilities(definition.capabilities, config.capabilities, {
    allowedCapabilities,
    path: definition.path,
  });
}

/** Atomically update manager-owned profile controls without rewriting unrelated v2 settings. */
export async function updateProfileControl(
  name: string,
  change: ProfileControl,
  path = CONFIG_PATH,
): Promise<SubagentConfig> {
  const config = await loadSubagentConfig(path);
  const normalized = { ...(config.profiles[name] ?? {}), ...change };
  if (change.enabled !== undefined && change.disabled === undefined)
    normalized.disabled = !change.enabled;
  if (change.disabled !== undefined && change.enabled === undefined)
    normalized.enabled = !change.disabled;
  config.profiles[name] = normalized;
  await fs.mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temporary, path);
  return config;
}
