import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { probeRtk, probeUv, type ResourceProbeCache } from "./child-rtk.js";
import {
  CONTEXT_EXECUTION_TOOLS,
  CONTEXT_TOOLS,
  EXPLORER_TOOLS,
  effectiveAgentResources,
  WORKER_TOOLS,
} from "./config.js";
import { contextModeAvailable } from "./context-mode-resolver.js";
import type {
  AgentDefinition,
  ChildDetectedResources,
  ChildEffectiveResources,
  ManagedAgent,
  ResolvedChildResourcePolicy,
} from "./types.js";

export type { ResourceProbeCache } from "./child-rtk.js";

export function piInvocation(): { command: string; args: string[] } {
  const script = process.argv[1];
  if (script && !script.startsWith("/$bunfs/root/") && existsSync(script))
    return { command: process.execPath, args: [script] };
  if (!/^(node|bun)(\.exe)?$/u.test(basename(process.execPath).toLowerCase()))
    return { command: process.execPath, args: [] };
  return { command: "pi", args: [] };
}

export function extensionDirectory(): string {
  return fileURLToPath(new URL(".", import.meta.url));
}
export function packageRoot(): string {
  return join(extensionDirectory(), "..", "..");
}
function packageExtension(...parts: string[]): string {
  return join(packageRoot(), "packages", ...parts);
}

export function reviewedResourcePaths(): {
  todos: string;
  webSearch: string;
  webSearchSkill: string;
  uv: string;
} {
  return {
    todos: packageExtension("todos", "index.ts"),
    webSearch: packageExtension("web-search", "index.ts"),
    webSearchSkill: packageExtension("web-search", "skills", "web-search", "SKILL.md"),
    uv: packageExtension("uv", "index.ts"),
  };
}

function falseDetected(): ChildDetectedResources {
  return {
    contextMode: false,
    contextExecution: false,
    webSearch: false,
    todos: false,
    rtk: false,
    uv: false,
  };
}

export type ChildResourceProbeOverrides = {
  contextModeAvailable?: (cwd: string) => boolean;
  exists?: (path: string) => boolean;
  probeRtk?: (options: { cwd?: string }) => Promise<boolean>;
  probeUv?: (options: { cwd?: string }) => Promise<boolean>;
};

function cachedProbe(
  cache: ResourceProbeCache | undefined,
  key: string,
  probe: () => Promise<boolean>,
): Promise<boolean> {
  if (!cache) return probe().catch(() => false);
  const existing = cache.get(key);
  if (existing) return existing;
  const result = probe().catch(() => false);
  cache.set(key, result);
  return result;
}

/** Probe only requested optional integrations; disabled resources never execute a probe. */
export async function detectChildResources(
  requested: ResolvedChildResourcePolicy,
  cwd = process.cwd(),
  cache?: ResourceProbeCache,
  overrides: ChildResourceProbeOverrides = {},
): Promise<ChildDetectedResources> {
  const paths = reviewedResourcePaths();
  const detected = falseDetected();
  const exists = overrides.exists ?? existsSync;
  const contextAvailable = overrides.contextModeAvailable ?? contextModeAvailable;
  const rtkProbe = overrides.probeRtk ?? probeRtk;
  const uvProbe = overrides.probeUv ?? probeUv;
  if (requested.contextMode !== "disabled") detected.contextMode = contextAvailable(cwd);
  detected.contextExecution = detected.contextMode;
  if (requested.webSearch)
    detected.webSearch = exists(paths.webSearch) && exists(paths.webSearchSkill);
  if (requested.todos) detected.todos = exists(paths.todos);
  if (requested.rtk !== "disabled")
    detected.rtk = await cachedProbe(cache, `rtk:${cwd}`, () => rtkProbe({ cwd }));
  if (requested.uv !== "disabled") {
    detected.uv =
      exists(paths.uv) && (await cachedProbe(cache, `uv:${cwd}`, () => uvProbe({ cwd })));
  }
  return detected;
}

function unavailableWarning(
  name: string,
  requested: string | boolean,
  detected: boolean,
): string | undefined {
  if (requested === false || requested === "disabled" || detected) return undefined;
  const severity = requested === "auto" ? "informational" : "warning";
  return `${severity}: ${name} unavailable; skipped.`;
}

export function childResourceWarnings(
  requested: ResolvedChildResourcePolicy,
  detected: ChildDetectedResources,
): string[] {
  return [
    unavailableWarning("Context Mode", requested.contextMode, detected.contextMode),
    unavailableWarning("Web Search", requested.webSearch, detected.webSearch),
    unavailableWarning("Todos", requested.todos, detected.todos),
    unavailableWarning("RTK", requested.rtk, detected.rtk),
    unavailableWarning("UV", requested.uv, detected.uv),
  ].filter((warning): warning is string => Boolean(warning));
}

export function resourceState(agent: ManagedAgent): ChildEffectiveResources {
  if (agent.effectiveResources) return agent.effectiveResources;
  // Compatibility for callers constructing pre-resource ManagedAgents in tests.
  const requested: ResolvedChildResourcePolicy = agent.requestedResources ?? {
    contextMode: "auto",
    contextExecution: agent.definition.mode === "worker",
    webSearch: agent.definition.mode === "explorer",
    todos: agent.definition.mode === "worker",
    rtk: agent.definition.mode === "worker" ? "auto" : "disabled",
    uv: agent.definition.mode === "worker" ? "auto" : "disabled",
  };
  return effectiveAgentResources(
    requested,
    agent.detectedResources ?? {
      contextMode: contextModeAvailable(),
      contextExecution: contextModeAvailable(),
      webSearch: false,
      todos: true,
      rtk: false,
      uv: false,
    },
  );
}

/** Only reviewed, provider-neutral child resources are inherited. */
export function childUtilityExtensions(agent?: ManagedAgent): string[] {
  const resources = agent ? resourceState(agent) : undefined;
  const paths = reviewedResourcePaths();
  const extensions: string[] = [];
  if (resources?.contextMode ?? contextModeAvailable())
    extensions.push(join(extensionDirectory(), "child-context-mode.ts"));
  // Keep the legacy helper useful for callers that do not yet have a ManagedAgent; real children
  // always pass their resolved resource state and therefore never give Explorer Todos.
  if (resources ? resources.todos : existsSync(paths.todos)) extensions.push(paths.todos);
  if (resources?.webSearch) extensions.push(paths.webSearch);
  if (resources?.rtk) extensions.push(join(extensionDirectory(), "child-rtk.ts"));
  else if (resources?.uv) extensions.push(paths.uv);
  return [...new Set(extensions)].filter((path) => existsSync(path));
}

export function childSkillPaths(agent?: ManagedAgent): string[] {
  const resources = agent ? resourceState(agent) : undefined;
  const paths = reviewedResourcePaths();
  return resources?.webSearch && existsSync(paths.webSearchSkill) ? [paths.webSearchSkill] : [];
}

export function isolatedChildEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env))
    if (typeof value === "string") env[key] = value;
  for (const key of Object.keys(env)) {
    if (
      key.startsWith("HERDR_") ||
      [
        "PI_SESSION_ID",
        "PI_SESSION_FILE",
        "PI_PROVIDER",
        "PI_MODEL",
        "PI_REASONING_LEVEL",
        "PI_SUBAGENT_CONTEXT_EXECUTION",
        "PI_SUBAGENT_RTK",
        "PI_SUBAGENT_UV",
      ].includes(key)
    )
      delete env[key];
  }
  return env;
}

/** Paths and resource switches owned by a child only. */
export function childIsolationOverrides(
  contextDirectory: string,
  agent?: ManagedAgent,
): Record<string, string> {
  const overrides: Record<string, string> = {
    CONTEXT_MODE_DIR: join(contextDirectory, "context-mode"),
    PI_TODO_PATH: join(contextDirectory, "todos"),
  };
  if (agent) {
    const resources = resourceState(agent);
    // Explicit zeroes matter for Herdr panes, whose ambient shell environment is not scrubbed.
    overrides.PI_SUBAGENT_CONTEXT_EXECUTION = resources.contextExecution ? "1" : "0";
    overrides.PI_SUBAGENT_RTK = resources.rtk ? "1" : "0";
    overrides.PI_SUBAGENT_UV = resources.uv ? "1" : "0";
  }
  return overrides;
}

/** RPC children inherit normal process authentication, but never parent session or state paths. */
export function childEnvironment(
  contextDirectory: string,
  agent?: ManagedAgent,
): Record<string, string> {
  return { ...isolatedChildEnv(), ...childIsolationOverrides(contextDirectory, agent) };
}

export function childPrompt(agent: AgentDefinition, resources?: ChildEffectiveResources): string {
  const resourceNote = resources
    ? `Reviewed child resources: Context Mode ${resources.contextMode ? "available" : "unavailable"}; Context execution ${resources.contextExecution ? "available" : "disabled"}; Web Search ${resources.webSearch ? "available" : "unavailable"}; Todos ${resources.todos ? "available" : "disabled"}; RTK ${resources.rtk ? "available" : "disabled"}; UV ${resources.uv ? "available" : "native Bash"}.`
    : "Context Mode is optional. If it is available, use it for large material; otherwise use Pi's built-in read-only tools.";
  return [
    "You are an isolated persistent Pi subagent.",
    agent.prompt,
    "Do not ask the user directly. Return exact questions or blockers to the parent.",
    "Do not invoke, load, or suggest recursive subagents. The subagent tools are intentionally unavailable.",
    "Do not invoke interactive user-question tooling. Return the question or required decision to the parent instead.",
    "Use only the reviewed resources provided to this child. Do not load arbitrary parent extensions or skills.",
    resourceNote,
    "Do not assume access to parent-only state, interactive user tools, or external work systems.",
    "Finish with a self-contained report including evidence, changed files, validation, and blockers.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function childSystemPromptPath(agent: Pick<ManagedAgent, "sessionDir">): string {
  return join(agent.sessionDir, "subagent-system-prompt.md");
}

/** Build only shell-safe child Pi arguments; multiline policy lives at childSystemPromptPath(). */
export function childPiArgs(agent: ManagedAgent): string[] {
  const resources = resourceState(agent);
  const baseTools = agent.definition.mode === "worker" ? WORKER_TOOLS : EXPLORER_TOOLS;
  const tools = [
    ...baseTools,
    ...(resources.contextMode ? CONTEXT_TOOLS : []),
    ...(resources.contextMode && resources.contextExecution ? CONTEXT_EXECUTION_TOOLS : []),
    ...(resources.webSearch ? ["search"] : []),
  ];
  const args = [
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-context-files",
    "--session-dir",
    agent.sessionDir,
    "--name",
    agent.id,
    "--append-system-prompt",
    childSystemPromptPath(agent),
    "--tools",
    [...new Set(tools)].join(","),
  ];
  for (const skill of childSkillPaths(agent)) args.push("--skill", skill);
  for (const extension of childUtilityExtensions(agent)) args.push("--extension", extension);
  if (agent.requestedModel) args.push("--model", agent.requestedModel);
  if (agent.requestedThinking) args.push("--thinking", agent.requestedThinking);
  return args;
}
