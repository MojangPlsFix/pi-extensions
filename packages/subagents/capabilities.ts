import { isAbsolute } from "node:path";
import type { AgentDefinition, AgentSource } from "./types.js";

export type CapabilityState = "isolated" | "shared-read" | "shared-write";
export type CapabilityApproval = "allow" | "ask" | "deny";

export type CapabilityDefinition = {
  name: string;
  description?: string;
  /** A trusted extension may be identified by a local path or an installed package. */
  extensionPath?: string;
  extensionPackage?: string;
  toolPatterns?: string[];
  executableArgvPrefixes?: string[][];
  skills?: string[];
  envAllowlist?: string[];
  state: CapabilityState;
  approval: CapabilityApproval;
  source?: AgentSource;
};

export type CapabilityDiagnostic = {
  path?: string;
  capability?: string;
  code: "unknown" | "invalid" | "not-allowed";
  message: string;
};

export type EffectiveCapability = CapabilityDefinition & {
  matchedTools: string[];
  matchedExecutables: string[][];
};

export type EffectiveCapabilityPolicy = {
  requested: string[];
  capabilities: EffectiveCapability[];
  tools: string[];
  executableArgvPrefixes: string[][];
  skills: string[];
  envAllowlist: string[];
  state: CapabilityState;
  approval: CapabilityApproval;
  diagnostics: CapabilityDiagnostic[];
};

function globRegex(pattern: string): RegExp {
  // Do not use an unanchored RegExp supplied by a profile: capability patterns always describe
  // complete tool names. `*` and `?` are the only wildcard operators.
  let expression = "";
  for (const character of pattern) {
    if (character === "*") expression += ".*";
    else if (character === "?") expression += ".";
    else expression += character.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
  }
  return new RegExp(`^${expression}$`, "u");
}

export function matchesToolPattern(toolName: string, pattern: string): boolean {
  if (!toolName || !pattern) return false;
  return globRegex(pattern).test(toolName);
}

export function matchesAnyToolPattern(toolName: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => matchesToolPattern(toolName, pattern));
}

/** Prefix matching is token based, so `git status` cannot accidentally authorize `git status-all`. */
export function matchesExecutableArgvPrefix(
  argv: readonly string[],
  prefix: readonly string[],
): boolean {
  return (
    prefix.length > 0 &&
    argv.length >= prefix.length &&
    prefix.every((token, index) => argv[index] === token)
  );
}

export function matchesAnyExecutableArgvPrefix(
  argv: readonly string[],
  prefixes: readonly (readonly string[])[],
): boolean {
  return prefixes.some((prefix) => matchesExecutableArgvPrefix(argv, prefix));
}

function rankState(states: CapabilityState[]): CapabilityState {
  if (states.includes("shared-write")) return "shared-write";
  if (states.includes("shared-read")) return "shared-read";
  return "isolated";
}
function rankApproval(approvals: CapabilityApproval[]): CapabilityApproval {
  if (approvals.includes("deny")) return "deny";
  if (approvals.includes("ask")) return "ask";
  return "allow";
}

/**
 * Resolve named capabilities into a flattened, auditable policy. Unknown names are diagnostics
 * (rather than silently disappearing), which lets list/spawn callers display the exact issue.
 */
export function capabilityCeilingDiagnostics(
  profile: Pick<AgentDefinition, "name" | "class" | "workspace">,
  policy: EffectiveCapabilityPolicy,
): CapabilityDiagnostic[] {
  const diagnostics: CapabilityDiagnostic[] = [];
  const mutatingTools = [
    "bash",
    "edit",
    "write",
    "apply_patch",
    "todo",
    "ctx_execute",
    "ctx_execute_file",
    "ctx_batch_execute",
  ];
  for (const capability of policy.capabilities) {
    if (
      profile.class !== "write" &&
      (capability.toolPatterns ?? []).some((pattern) =>
        mutatingTools.some((tool) => matchesToolPattern(tool, pattern)),
      )
    )
      diagnostics.push({
        capability: capability.name,
        code: "not-allowed",
        message: `${profile.class} profile '${profile.name}' may not activate mutating tools through capability '${capability.name}'.`,
      });
    if (capability.state === "shared-write" && profile.class !== "write")
      diagnostics.push({
        capability: capability.name,
        code: "not-allowed",
        message: `${profile.class} profile '${profile.name}' may not select shared-write capability '${capability.name}'.`,
      });
    if (capability.state === "shared-write" && profile.workspace === "read-only")
      diagnostics.push({
        capability: capability.name,
        code: "not-allowed",
        message: `Read-only workspace profile '${profile.name}' may not select shared-write capability '${capability.name}'.`,
      });
  }
  return diagnostics;
}

export function selectEffectiveCapabilities(
  requested: readonly string[],
  catalog: Readonly<Record<string, CapabilityDefinition>>,
  options: { allowedCapabilities?: readonly string[]; path?: string } = {},
): EffectiveCapabilityPolicy {
  const diagnostics: CapabilityDiagnostic[] = [];
  const capabilities: EffectiveCapability[] = [];
  const allowed = options.allowedCapabilities && new Set(options.allowedCapabilities);
  for (const name of requested) {
    const definition = catalog[name];
    if (!definition) {
      diagnostics.push({
        path: options.path,
        capability: name,
        code: "unknown",
        message: `Unknown capability '${name}'.`,
      });
      continue;
    }
    if (allowed && !allowed.has(name)) {
      diagnostics.push({
        path: options.path,
        capability: name,
        code: "not-allowed",
        message: `Capability '${name}' is not allowed by the project profile.`,
      });
      continue;
    }
    capabilities.push({
      ...definition,
      matchedTools: [...(definition.toolPatterns ?? [])],
      matchedExecutables: (definition.executableArgvPrefixes ?? []).map((prefix) => [...prefix]),
    });
  }
  const unique = <T>(items: T[]): T[] => [...new Set(items)];
  const tools = unique(capabilities.flatMap((capability) => capability.toolPatterns ?? []));
  const executableArgvPrefixes = capabilities
    .flatMap((capability) => capability.executableArgvPrefixes ?? [])
    .map((prefix) => [...prefix]);
  return {
    requested: [...requested],
    capabilities,
    tools,
    executableArgvPrefixes,
    skills: unique(capabilities.flatMap((capability) => capability.skills ?? [])),
    envAllowlist: unique(capabilities.flatMap((capability) => capability.envAllowlist ?? [])),
    state: rankState(capabilities.map((capability) => capability.state)),
    approval: rankApproval(capabilities.map((capability) => capability.approval)),
    diagnostics,
  };
}

/** Alias with a descriptive name for manager-facing callers. */
export const resolveEffectiveCapabilities = selectEffectiveCapabilities;

export function validateCapabilityDefinition(
  value: unknown,
  path: string,
  options: { source?: AgentSource } = {},
): CapabilityDefinition {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${path} must be an object.`);
  const candidate = value as Record<string, unknown>;
  const allowedKeys = new Set([
    "name",
    "description",
    "extensionPath",
    "extensionPackage",
    "toolPatterns",
    "executableArgvPrefixes",
    "skills",
    "envAllowlist",
    "state",
    "approval",
    "source",
  ]);
  for (const key of Object.keys(candidate))
    if (!allowedKeys.has(key)) throw new Error(`${path}.${key} is not supported.`);
  const source = options.source ?? (candidate.source as AgentSource | undefined);
  if (candidate.extensionPath !== undefined && candidate.extensionPackage !== undefined)
    throw new Error(`${path} must select either extensionPath or extensionPackage, not both.`);
  if (
    source === "project" &&
    (candidate.extensionPath !== undefined ||
      candidate.extensionPackage !== undefined ||
      candidate.executableArgvPrefixes !== undefined)
  )
    throw new Error(`${path} project capabilities may not define extension or executable paths.`);
  if (candidate.extensionPath !== undefined) {
    if (typeof candidate.extensionPath !== "string" || !isAbsolute(candidate.extensionPath))
      throw new Error(`${path}.extensionPath must be an absolute trusted path.`);
  }
  if (candidate.extensionPackage !== undefined) {
    if (
      typeof candidate.extensionPackage !== "string" ||
      !/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/iu.test(candidate.extensionPackage)
    )
      throw new Error(`${path}.extensionPackage must be an installed package name.`);
  }
  const name = candidate.name;
  if (typeof name !== "string" || !name.trim())
    throw new Error(`${path}.name must be a non-empty string.`);
  const list = (key: string): string[] | undefined => {
    const valueForKey = candidate[key];
    if (valueForKey === undefined) return undefined;
    if (
      !Array.isArray(valueForKey) ||
      valueForKey.some((item) => typeof item !== "string" || !item.trim())
    )
      throw new Error(`${path}.${key} must be an array of non-empty strings.`);
    return valueForKey.map((item) => (item as string).trim());
  };
  const prefixesValue = candidate.executableArgvPrefixes;
  if (
    prefixesValue !== undefined &&
    (!Array.isArray(prefixesValue) ||
      prefixesValue.some(
        (prefix) =>
          !Array.isArray(prefix) ||
          prefix.length === 0 ||
          prefix.some((token) => typeof token !== "string" || !token),
      ))
  )
    throw new Error(`${path}.executableArgvPrefixes must be an array of argv prefixes.`);
  const envAllowlist = list("envAllowlist");
  if (envAllowlist?.some((name) => !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)))
    throw new Error(`${path}.envAllowlist contains an invalid environment variable name.`);
  const state = candidate.state;
  const approval = candidate.approval;
  if (state !== "isolated" && state !== "shared-read" && state !== "shared-write")
    throw new Error(`${path}.state must be isolated, shared-read, or shared-write.`);
  if (approval !== "allow" && approval !== "ask" && approval !== "deny")
    throw new Error(`${path}.approval must be allow, ask, or deny.`);
  return {
    name: name.trim(),
    ...(typeof candidate.description === "string" ? { description: candidate.description } : {}),
    ...(typeof candidate.extensionPath === "string"
      ? { extensionPath: candidate.extensionPath }
      : {}),
    ...(typeof candidate.extensionPackage === "string"
      ? { extensionPackage: candidate.extensionPackage }
      : {}),
    ...(list("toolPatterns") ? { toolPatterns: list("toolPatterns") } : {}),
    ...(prefixesValue
      ? { executableArgvPrefixes: (prefixesValue as string[][]).map((prefix) => [...prefix]) }
      : {}),
    ...(list("skills") ? { skills: list("skills") } : {}),
    ...(envAllowlist ? { envAllowlist } : {}),
    state,
    approval,
    ...(source ? { source } : {}),
  };
}

export function validateCapabilityCatalog(
  value: unknown,
  options: { source?: AgentSource } = {},
): Record<string, CapabilityDefinition> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("capabilities must be an object.");
  const result: Record<string, CapabilityDefinition> = {};
  for (const [name, definition] of Object.entries(value)) {
    const candidate =
      definition && typeof definition === "object" && !Array.isArray(definition)
        ? { ...(definition as Record<string, unknown>), name }
        : definition;
    const parsed = validateCapabilityDefinition(candidate, `capabilities.${name}`, options);
    result[name] = parsed;
  }
  return result;
}
