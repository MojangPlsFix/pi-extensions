import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { contextModeDiagnostic, contextModeRoot } from "./resolver.js";
import type { ContextLanguage } from "./runner.js";

type SecurityModule = {
  readBashPolicies(projectDir?: string): unknown[];
  evaluateCommandDenyOnly(
    command: string,
    policies: unknown[],
    caseInsensitive?: boolean,
  ): { decision: "deny" | "allow"; matchedPattern?: string };
  extractShellCommands(code: string, language: string): string[];
  readToolDenyPatterns(toolName: string, projectDir?: string): string[][];
  evaluateFilePath(
    filePath: string,
    denyGlobs: string[][],
    caseInsensitive?: boolean,
    projectRoot?: string,
  ): { denied: boolean; matchedPattern?: string };
};

let loaded: Promise<SecurityModule> | undefined;

async function securityModule(projectRoot: string): Promise<SecurityModule> {
  if (loaded) return loaded;
  const root = contextModeRoot(projectRoot);
  if (!root) throw new Error(contextModeDiagnostic(projectRoot));
  loaded = import(
    pathToFileURL(join(root, "build", "security.js")).href
  ) as Promise<SecurityModule>;
  return loaded;
}

function deniedMessage(kind: string, pattern: string | undefined): string {
  return `${kind} denied by Context Mode policy${pattern ? `: ${pattern}` : "."}`;
}

/** Apply the pinned upstream deny-only policy before native execution. */
export async function enforceExecutionPolicy(input: {
  projectRoot: string;
  language: ContextLanguage;
  code: string;
  path?: string;
}): Promise<void> {
  const security = await securityModule(input.projectRoot);
  const caseInsensitive = process.platform === "win32";

  if (input.path) {
    const patterns = security.readToolDenyPatterns("Read", input.projectRoot);
    const decision = security.evaluateFilePath(
      input.path,
      patterns,
      caseInsensitive,
      input.projectRoot,
    );
    if (decision.denied) throw new Error(deniedMessage("File read", decision.matchedPattern));
  }

  const commands =
    input.language === "shell"
      ? [input.code]
      : security.extractShellCommands(input.code, input.language);
  if (commands.length === 0) return;
  const policies = security.readBashPolicies(input.projectRoot);
  for (const command of commands) {
    const decision = security.evaluateCommandDenyOnly(command, policies, caseInsensitive);
    if (decision.decision === "deny")
      throw new Error(deniedMessage("Command", decision.matchedPattern));
  }
}

/** Test-only reset for isolated external-runtime fixtures. */
export function resetSecurityModuleForTests(): void {
  loaded = undefined;
}
