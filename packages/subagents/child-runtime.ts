import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CONTEXT_TOOLS, EXPLORER_TOOLS, WORKER_TOOLS } from "./config.js";
import { contextModeAvailable } from "./context-mode-resolver.js";
import type { AgentDefinition, ManagedAgent } from "./types.js";

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

/** Only reviewed, provider-neutral child resources are inherited. */
export function childUtilityExtensions(): string[] {
  const extensions = [packageExtension("todos", "index.ts")];
  if (contextModeAvailable()) extensions.push(join(extensionDirectory(), "child-context-mode.ts"));
  return extensions.filter((path) => existsSync(path));
}

export function childSkillPaths(): string[] {
  return [];
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
      ].includes(key)
    )
      delete env[key];
  }
  return env;
}

/** Paths owned by a child only. These are the sole values sent to Herdr as CLI overrides. */
export function childIsolationOverrides(contextDirectory: string): Record<string, string> {
  return {
    CONTEXT_MODE_DIR: join(contextDirectory, "context-mode"),
    PI_TODO_PATH: join(contextDirectory, "todos"),
  };
}

/** RPC children inherit normal process authentication, but never parent session or state paths. */
export function childEnvironment(contextDirectory: string): Record<string, string> {
  return { ...isolatedChildEnv(), ...childIsolationOverrides(contextDirectory) };
}

export function childPrompt(agent: AgentDefinition): string {
  return [
    "You are an isolated persistent Pi subagent.",
    agent.prompt,
    "Do not ask the user directly. Return exact questions or blockers to the parent.",
    "Do not invoke, load, or suggest recursive subagents. The subagent tools are intentionally unavailable.",
    "Do not invoke interactive user-question tooling. Return the question or required decision to the parent instead.",
    "Use only the reviewed resources provided to this child. Do not load arbitrary parent extensions or skills.",
    "Context Mode is optional. If it is available, use it for large material; otherwise use Pi's built-in read-only tools.",
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
  const baseTools = agent.definition.mode === "worker" ? WORKER_TOOLS : EXPLORER_TOOLS;
  const tools = contextModeAvailable() ? [...baseTools, ...CONTEXT_TOOLS] : baseTools;
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
    tools.join(","),
  ];
  for (const skill of childSkillPaths()) args.push("--skill", skill);
  for (const extension of childUtilityExtensions()) args.push("--extension", extension);
  if (agent.requestedModel) args.push("--model", agent.requestedModel);
  if (agent.requestedThinking) args.push("--thinking", agent.requestedThinking);
  return args;
}
