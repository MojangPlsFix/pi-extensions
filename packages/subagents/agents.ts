import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import {
  type AgentDefinition,
  type AgentSource,
  PROFILE_CLASSES,
  type ProfileClass,
  RUNNER_KINDS,
  type RunnerKind,
  type WorkspacePolicy,
} from "./types.js";

const THINKING = ["inherit", "off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const FRONTMATTER_KEYS = new Set([
  "schemaVersion",
  "name",
  "description",
  "class",
  "model",
  "thinking",
  "runner",
  "tools",
  "capabilities",
  "skills",
  "defaultContext",
  "allowedNestedProfiles",
  "maxDepth",
  "workspace",
  "timeout",
  "turnBudget",
  "tokenBudget",
  "costBudget",
  "infer",
  "hidden",
]);

export type AgentDiagnostic = {
  path: string;
  code: "malformed" | "duplicate" | "read-error" | "config-error" | "policy" | "lifecycle";
  message: string;
};
export type DiscoveryOptions = {
  cwd?: string;
  piConfigDir?: string;
  userDir?: string;
  projectDir?: string;
  trustedProject?: boolean;
};
export type AgentDiscoveryResult = {
  profiles: AgentDefinition[];
  diagnostics: AgentDiagnostic[];
};

const builtinSpecs = [
  [
    "scout",
    "Fast read-only codebase reconnaissance that returns compressed, evidence-backed context.",
    "read",
    "Map only the delegated scope. Return exact paths and symbols, key architecture, constraints, risks, and the best starting point. Do not edit files or duplicate another owner's scope.",
  ],
  [
    "researcher",
    "Focused web and documentation researcher that prefers current primary sources.",
    "advisory",
    "Research the delegated question through distinct angles. Prefer official and primary sources, cite URLs, distinguish evidence from inference, and state remaining gaps.",
  ],
  [
    "worker",
    "Focused implementation profile for one explicitly owned code slice.",
    "write",
    "Implement only the delegated ownership. Preserve unrelated work, escalate unapproved decisions, run local checks, and report exact changed files and validation.",
  ],
  [
    "reviewer",
    "Evidence-based reviewer for code, plans, diffs, tests, and regressions.",
    "review",
    "Review only the assigned angle. Verify findings against code and requirements, cite exact paths, rank actionable issues, and do not edit files.",
  ],
  [
    "oracle",
    "High-context advisor that detects decision drift, contradictions, and hidden assumptions.",
    "advisory",
    "Reconstruct inherited decisions before advising. Protect consistency, identify drift and hidden assumptions, recommend the narrowest justified correction, and explain uncertainty.",
  ],
  [
    "orchestrator",
    "In-session sidecar coordinator for one explicit, exclusively owned mission scope.",
    "orchestrator",
    "Decompose the mission into a dependency-aware task graph, assign disjoint owners in batches, avoid doing specialist work yourself, verify every phase, and contact the supervisor only for decisions, approvals, blockers, meaningful progress, or integration readiness.",
  ],
  [
    "plan-reviewer",
    "Hidden read-only plan reviewer.",
    "review",
    "Review the plan against the repository and return findings, risks, and missing work.",
  ],
] as const;
const builtinProfiles: AgentDefinition[] = builtinSpecs.map(
  ([name, description, profileClass, prompt]) =>
    makeProfile(
      name,
      description,
      profileClass,
      prompt,
      "builtin",
      undefined,
      name === "plan-reviewer",
    ),
);

const READ_ONLY_BUILTIN_TOOLS = new Set(["read", "grep", "find", "ls", "search"]);
const WRITE_BUILTIN_TOOLS = new Set([...READ_ONLY_BUILTIN_TOOLS, "bash", "edit", "write"]);
const MUTATING_TOOLS = new Set([
  "bash",
  "edit",
  "write",
  "apply_patch",
  "todo",
  "ctx_execute",
  "ctx_execute_file",
  "ctx_batch_execute",
]);

/** Enforce the class ceiling independently of prompt wording or project trust. */
export function profileAuthorityDiagnostics(profile: AgentDefinition): string[] {
  const diagnostics: string[] = [];
  const unsupported = profile.tools.filter(
    (tool) =>
      !(profile.class === "write" ? WRITE_BUILTIN_TOOLS : READ_ONLY_BUILTIN_TOOLS).has(tool),
  );
  if (unsupported.length)
    diagnostics.push(
      `Profile '${profile.name}' must select extension tools through capabilities, not tools: ${unsupported.join(", ")}.`,
    );
  if (profile.class !== "write") {
    const mutating = profile.tools.filter((tool) => MUTATING_TOOLS.has(tool));
    if (mutating.length)
      diagnostics.push(
        `${profile.class} profile '${profile.name}' may not select mutating tools: ${mutating.join(", ")}.`,
      );
  }
  if (profile.class === "write" && profile.workspace === "read-only")
    diagnostics.push(`Write profile '${profile.name}' cannot use a read-only workspace.`);
  if (profile.class !== "orchestrator" && profile.allowedNestedProfiles.length)
    diagnostics.push(`Only orchestrator profiles may allow nested profiles.`);
  if (profile.class !== "orchestrator" && profile.maxDepth !== 0)
    diagnostics.push(`Only orchestrator profiles may set maxDepth above zero.`);
  return diagnostics;
}

function makeProfile(
  name: string,
  description: string,
  profileClass: ProfileClass,
  prompt: string,
  source: AgentSource,
  path?: string,
  hidden = false,
): AgentDefinition {
  return {
    schemaVersion: 2,
    name,
    description,
    class: profileClass,
    runner: "native",
    tools:
      profileClass === "write"
        ? ["read", "grep", "find", "ls", "bash", "edit", "write"]
        : ["read", "grep", "find", "ls", ...(name === "researcher" ? ["search"] : [])],
    capabilities: [],
    skills: [],
    defaultContext: name === "oracle" ? "decisions" : "fresh",
    allowedNestedProfiles:
      profileClass === "orchestrator"
        ? ["scout", "researcher", "worker", "reviewer", "oracle"]
        : [],
    maxDepth: profileClass === "orchestrator" ? 2 : 0,
    workspace: profileClass === "write" ? "shared" : "read-only",
    infer: profileClass !== "orchestrator" && name !== "plan-reviewer",
    hidden,
    prompt,
    source,
    path,
  };
}

function cloneProfile(profile: AgentDefinition): AgentDefinition {
  return {
    ...profile,
    tools: [...profile.tools],
    capabilities: [...profile.capabilities],
    skills: [...profile.skills],
    allowedNestedProfiles: [...profile.allowedNestedProfiles],
    metadata: profile.metadata ? { ...profile.metadata } : undefined,
  };
}

export const BUILTIN_PROFILES = builtinProfiles.map(cloneProfile);

export function safeName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function scalar(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (
    (trimmed.startsWith("[") && trimmed.endsWith("]")) ||
    (trimmed.startsWith("{") && trimmed.endsWith("}"))
  ) {
    try {
      return JSON.parse(trimmed);
    } catch {
      if (trimmed.startsWith("[") && trimmed.endsWith("]"))
        return trimmed
          .slice(1, -1)
          .split(",")
          .map((part) => scalar(part));
      /* Object syntax is intentionally not a profile-frontmatter feature. */
    }
  }
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  )
    return trimmed.slice(1, -1);
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (/^-?\d+(?:\.\d+)?$/u.test(trimmed)) return Number(trimmed);
  if (trimmed.includes(",")) return trimmed.split(",").map((part) => scalar(part));
  return trimmed;
}

function invalid(file: string, message: string): never {
  throw new Error(`${file}: ${message}`);
}

function parseFrontmatterDetailed(
  source: string,
  file: string,
  sourceKind: AgentSource = "user",
): AgentDefinition {
  const match = /^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/u.exec(source);
  if (!match) invalid(file, "missing YAML frontmatter.");
  const fields: Record<string, unknown> = {};
  const lines = match![1]!.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const field = /^([A-Za-z][\w-]*):\s*(.*?)\s*$/u.exec(line);
    if (!field) invalid(file, `malformed frontmatter line ${index + 1}.`);
    const key = field![1]!;
    if (fields[key] !== undefined) invalid(file, `duplicate field '${key}'.`);
    if (!FRONTMATTER_KEYS.has(key)) invalid(file, `unsupported field '${key}'.`);
    if (!field![2]!.trim()) {
      const items: unknown[] = [];
      while (index + 1 < lines.length && /^\s+-\s+.+$/u.test(lines[index + 1]!)) {
        index += 1;
        items.push(scalar(lines[index]!.replace(/^\s+-\s+/u, "")));
      }
      fields[key] = items;
    } else fields[key] = scalar(field![2]!);
  }
  if (fields.schemaVersion !== 2) invalid(file, "schemaVersion must be 2.");
  const name = safeName(typeof fields.name === "string" ? fields.name : "");
  const description = typeof fields.description === "string" ? fields.description.trim() : "";
  const profileClass = fields.class;
  if (!name) invalid(file, "name is required.");
  if (!description) invalid(file, "description is required.");
  if (!PROFILE_CLASSES.includes(profileClass as ProfileClass))
    invalid(file, "class must be read, write, review, advisory, or orchestrator.");
  if (fields.model !== undefined && (typeof fields.model !== "string" || !fields.model.trim()))
    invalid(file, "model must be a non-empty string.");
  if (
    fields.thinking !== undefined &&
    !THINKING.includes(fields.thinking as (typeof THINKING)[number])
  )
    invalid(file, "thinking is not supported.");
  if (fields.runner !== undefined && !RUNNER_KINDS.includes(fields.runner as RunnerKind))
    invalid(file, "runner is not native, rpc, or external.");
  const list = (key: string): string[] => {
    const value = fields[key];
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || !entry.trim()))
      invalid(file, `${key} must be an array of strings.`);
    return value.map((entry) => (entry as string).trim());
  };
  const numberField = (key: string): number | undefined => {
    const value = fields[key];
    if (value === undefined) return undefined;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
      invalid(file, `${key} must be a non-negative number.`);
    return value;
  };
  const workspace = fields.workspace ?? (profileClass === "write" ? "shared" : "read-only");
  if (workspace !== "shared" && workspace !== "isolated" && workspace !== "read-only")
    invalid(file, "workspace must be shared, isolated, or read-only.");
  const maxDepth = numberField("maxDepth") ?? (profileClass === "orchestrator" ? 2 : 0);
  if (!Number.isInteger(maxDepth) || maxDepth > 2)
    invalid(file, "maxDepth must be an integer no greater than 2.");
  const allowedNestedProfiles = list("allowedNestedProfiles");
  if (allowedNestedProfiles.some((entry) => safeName(entry) !== entry))
    invalid(file, "allowedNestedProfiles must contain normalized profile names.");
  const context = fields.defaultContext;
  if (context !== undefined && context !== "fresh" && context !== "decisions" && context !== "plan")
    invalid(file, "defaultContext must be fresh, decisions, or plan.");
  const infer = fields.infer ?? false;
  const hidden = fields.hidden ?? false;
  if (typeof infer !== "boolean" || typeof hidden !== "boolean")
    invalid(file, "infer and hidden must be booleans.");
  const timeout = numberField("timeout");
  const turnBudget = numberField("turnBudget");
  const tokenBudget = numberField("tokenBudget");
  const costBudget = numberField("costBudget");
  if (timeout !== undefined && timeout <= 0) invalid(file, "timeout must be greater than zero.");
  if (turnBudget !== undefined && !Number.isInteger(turnBudget))
    invalid(file, "turnBudget must be an integer.");
  if (tokenBudget !== undefined && !Number.isInteger(tokenBudget))
    invalid(file, "tokenBudget must be an integer.");
  const prompt = match![2]!.trim();
  if (!prompt) invalid(file, "profile prompt must not be empty.");
  const profile: AgentDefinition = {
    schemaVersion: 2,
    name,
    description,
    class: profileClass as ProfileClass,
    ...(typeof fields.model === "string" ? { model: fields.model.trim() } : {}),
    ...(typeof fields.thinking === "string" ? { thinking: fields.thinking } : {}),
    runner: (fields.runner as RunnerKind | undefined) ?? "native",
    tools: list("tools"),
    capabilities: list("capabilities"),
    skills: list("skills"),
    ...(typeof context === "string" ? { defaultContext: context } : {}),
    allowedNestedProfiles,
    maxDepth,
    workspace: workspace as WorkspacePolicy,
    timeout,
    turnBudget,
    tokenBudget,
    costBudget,
    infer,
    hidden,
    prompt,
    source: sourceKind,
    path: file,
  };
  const authority = profileAuthorityDiagnostics(profile);
  if (authority.length) invalid(file, authority.join(" "));
  return profile;
}

/** Parse a v2 profile. Invalid input returns undefined for small, synchronous callers. */
export function parseFrontmatter(source: string, file: string): AgentDefinition | undefined {
  try {
    return parseFrontmatterDetailed(source, file);
  } catch {
    return undefined;
  }
}

export function parseFrontmatterOrThrow(
  source: string,
  file: string,
  sourceKind: AgentSource = "user",
): AgentDefinition {
  return parseFrontmatterDetailed(source, file, sourceKind);
}

async function readDirectory(
  directory: string,
  source: AgentSource,
  diagnostics: AgentDiagnostic[],
): Promise<AgentDefinition[]> {
  let names: string[];
  try {
    names = await fs.readdir(directory);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT")
      diagnostics.push({
        path: directory,
        code: "read-error",
        message: cause instanceof Error ? cause.message : String(cause),
      });
    return [];
  }
  const profiles: AgentDefinition[] = [];
  for (const name of names.filter((entry) => entry.endsWith(".md")).sort()) {
    const path = join(directory, name);
    try {
      const profile = parseFrontmatterOrThrow(await fs.readFile(path, "utf8"), path, source);
      profiles.push(profile);
    } catch (cause) {
      diagnostics.push({
        path,
        code: "malformed",
        message: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }
  return profiles;
}

function result(profiles: AgentDefinition[], diagnostics: AgentDiagnostic[]): AgentDiscoveryResult {
  return { profiles: [...profiles], diagnostics: [...diagnostics] };
}

/** Reload-on-call discovery. Project definitions are considered only with an explicit trust flag. */
export async function discoverAgents(
  options: DiscoveryOptions = {},
): Promise<AgentDiscoveryResult> {
  const diagnostics: AgentDiagnostic[] = [];
  const profiles: AgentDefinition[] = BUILTIN_PROFILES.map(cloneProfile);
  const cwd = options.cwd ?? process.cwd();
  const userDir = options.userDir ?? join(homedir(), ".pi", "agent", "subagents", "agents");
  const piConfigDir = options.piConfigDir ?? CONFIG_DIR_NAME;
  const projectDir =
    options.projectDir ??
    join(isAbsolute(piConfigDir) ? piConfigDir : join(cwd, piConfigDir), "agents");
  const layers: Array<{ directory: string; source: AgentSource }> = [
    { directory: userDir, source: "user" },
  ];
  if (options.trustedProject === true) layers.push({ directory: projectDir, source: "project" });
  const known = new Map(profiles.map((profile) => [profile.name, profile]));
  for (const layer of layers) {
    for (const profile of await readDirectory(layer.directory, layer.source, diagnostics)) {
      const previous = known.get(profile.name);
      if (previous)
        diagnostics.push({
          path: profile.path ?? layer.directory,
          code: "duplicate",
          message: `Profile '${profile.name}' overrides ${previous.source} profile '${previous.path ?? previous.name}'.`,
        });
      const index = profiles.findIndex((item) => item.name === profile.name);
      if (index >= 0) profiles[index] = profile;
      else profiles.push(profile);
      known.set(profile.name, profile);
    }
  }
  return result(profiles, diagnostics);
}

function frontmatterValue(value: unknown): string {
  return JSON.stringify(value);
}

/** Serialize an effective v2 profile without source/control metadata. */
export function serializeProfile(profile: AgentDefinition): string {
  const fields: Array<[string, unknown]> = [
    ["schemaVersion", 2],
    ["name", profile.name],
    ["description", profile.description],
    ["class", profile.class],
    ["runner", profile.runner],
    ["tools", profile.tools],
    ["capabilities", profile.capabilities],
    ["skills", profile.skills],
    ["defaultContext", profile.defaultContext],
    ["allowedNestedProfiles", profile.allowedNestedProfiles],
    ["maxDepth", profile.maxDepth],
    ["workspace", profile.workspace],
    ["timeout", profile.timeout],
    ["turnBudget", profile.turnBudget],
    ["tokenBudget", profile.tokenBudget],
    ["costBudget", profile.costBudget],
    ["model", profile.model],
    ["thinking", profile.thinking],
    ["infer", profile.infer],
    ["hidden", profile.hidden],
  ];
  const header = fields
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}: ${frontmatterValue(value)}`)
    .join("\n");
  return `---\n${header}\n---\n${profile.prompt.trim()}\n`;
}

/** Materialize a built-in for user-controlled customization; existing files are never replaced. */
export async function ejectBuiltinProfile(name: string, directory: string): Promise<string> {
  const profile = BUILTIN_PROFILES.find((candidate) => candidate.name === name);
  if (!profile)
    throw new Error(`Only built-in profiles can be ejected; '${name}' is not built in.`);
  await fs.mkdir(directory, { recursive: true });
  const path = join(directory, `${profile.name}.md`);
  try {
    await fs.writeFile(path, serializeProfile(profile), {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "EEXIST")
      throw new Error(`Profile file already exists: ${path}`);
    throw cause;
  }
  return path;
}
