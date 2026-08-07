import { execFileSync } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface PlanModeConfig {
  readOnlyTools: string[];
  readOnlyCommands: Record<string, string[]>;
}

export interface LoadedPlanModeConfig extends PlanModeConfig {
  warnings: string[];
  globalPath: string;
  projectPath?: string;
}

const mutators = new Set([
  "edit",
  "write",
  "apply_patch",
  "memory_write",
  "memory_update",
  "memory_delete",
  "memory_forget",
  "ctx_purge",
  "ctx_upgrade",
  "ctx_execute",
  "ctx_execute_file",
  "ctx_batch_execute",
  "subagent_close",
  "subagent_interrupt",
]);
const namePattern = /^[A-Za-z][A-Za-z0-9_.-]*$/;
const emptyConfig = (): PlanModeConfig => ({ readOnlyTools: [], readOnlyCommands: {} });

export function normalizeToolName(name: string): string {
  return name.trim().split(".").pop() ?? name.trim();
}

function validName(value: unknown): value is string {
  return typeof value === "string" && namePattern.test(value.trim());
}

function validate(raw: unknown, source: string, warnings: string[]): PlanModeConfig {
  const result = emptyConfig();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    warnings.push(`${source}: configuration must be a JSON object.`);
    return result;
  }
  const input = raw as Record<string, unknown>;
  if (input.readOnlyTools !== undefined) {
    if (!Array.isArray(input.readOnlyTools))
      warnings.push(`${source}: readOnlyTools must be an array.`);
    else
      for (const entry of input.readOnlyTools) {
        const normalized = typeof entry === "string" ? normalizeToolName(entry) : "";
        if (!validName(normalized)) warnings.push(`${source}: ignored invalid tool name.`);
        else if (mutators.has(normalized))
          warnings.push(`${source}: rejected directly mutating tool '${normalized}'.`);
        else result.readOnlyTools.push(normalized);
      }
  }
  if (input.readOnlyCommands !== undefined) {
    if (
      !input.readOnlyCommands ||
      typeof input.readOnlyCommands !== "object" ||
      Array.isArray(input.readOnlyCommands)
    ) {
      warnings.push(`${source}: readOnlyCommands must be an object.`);
    } else
      for (const [program, commands] of Object.entries(
        input.readOnlyCommands as Record<string, unknown>,
      )) {
        if (!validName(program)) {
          warnings.push(`${source}: ignored invalid CLI program name.`);
          continue;
        }
        if (!Array.isArray(commands)) {
          warnings.push(`${source}: commands for '${program}' must be an array.`);
          continue;
        }
        const valid: string[] = [];
        for (const command of commands) {
          if (!validName(command))
            warnings.push(`${source}: ignored invalid subcommand for '${program}'.`);
          else if (!valid.includes(command)) valid.push(command);
        }
        if (valid.length) result.readOnlyCommands[program] = valid;
      }
  }
  result.readOnlyTools = [...new Set(result.readOnlyTools)];
  return result;
}

export function resolvePlanModePaths(
  cwd = process.cwd(),
  trusted = false,
): { globalPath: string; projectPath?: string } {
  const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
  return {
    globalPath: join(agentDir, "plan-mode.json"),
    ...(trusted ? { projectPath: join(cwd, ".pi", "plan-mode.json") } : {}),
  };
}

function merge(into: PlanModeConfig, other: PlanModeConfig): void {
  into.readOnlyTools = [...new Set([...into.readOnlyTools, ...other.readOnlyTools])];
  for (const [program, commands] of Object.entries(other.readOnlyCommands))
    into.readOnlyCommands[program] = [
      ...new Set([...(into.readOnlyCommands[program] ?? []), ...commands]),
    ];
}

function isAvailable(program: string): boolean {
  try {
    execFileSync("which", [program], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export async function loadPlanModeConfig(
  options: { cwd?: string; trusted?: boolean; checkAvailability?: boolean } = {},
): Promise<LoadedPlanModeConfig> {
  const paths = resolvePlanModePaths(options.cwd, options.trusted ?? false);
  const config = emptyConfig();
  const warnings: string[] = [];
  for (const path of [paths.globalPath, paths.projectPath].filter((value): value is string =>
    Boolean(value),
  )) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(path, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        warnings.push(`${path}: invalid JSON or unreadable configuration.`);
      continue;
    }
    merge(config, validate(parsed, path, warnings));
  }
  if (options.checkAvailability !== false) {
    for (const program of Object.keys(config.readOnlyCommands)) {
      if (!isAvailable(program)) {
        warnings.push(`Command '${program}' is unavailable and was ignored for this session.`);
        delete config.readOnlyCommands[program];
      }
    }
  }
  return {
    ...config,
    warnings,
    globalPath: paths.globalPath,
    ...(paths.projectPath ? { projectPath: paths.projectPath } : {}),
  };
}

export async function writePlanModeConfig(path: string, config: PlanModeConfig): Promise<void> {
  const warnings: string[] = [];
  const clean = validate(config, path, warnings);
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(clean, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, path);
  } catch (error) {
    try {
      await access(path, constants.F_OK);
    } catch {
      /* preserve the absence of the original */
    }
    throw error;
  }
}

export async function updatePlanModeConfig(
  path: string,
  changes: {
    addTools?: string[];
    removeTools?: string[];
    addCommands?: Record<string, string[]>;
    removeCommands?: Record<string, string[]>;
  },
): Promise<void> {
  let current: PlanModeConfig = emptyConfig();
  try {
    current = validate(JSON.parse(await readFile(path, "utf8")), path, []);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !(error instanceof SyntaxError))
      throw error;
  }
  current.readOnlyTools = [
    ...new Set([...current.readOnlyTools, ...(changes.addTools ?? []).map(normalizeToolName)]),
  ].filter((name) => !(changes.removeTools ?? []).map(normalizeToolName).includes(name));
  for (const [program, commands] of Object.entries(changes.addCommands ?? {}))
    current.readOnlyCommands[program] = [
      ...new Set([...(current.readOnlyCommands[program] ?? []), ...commands]),
    ];
  for (const [program, commands] of Object.entries(changes.removeCommands ?? {})) {
    const remove = new Set(commands);
    current.readOnlyCommands[program] = (current.readOnlyCommands[program] ?? []).filter(
      (command) => !remove.has(command),
    );
    if (!current.readOnlyCommands[program].length) delete current.readOnlyCommands[program];
  }
  await writePlanModeConfig(path, current);
}
