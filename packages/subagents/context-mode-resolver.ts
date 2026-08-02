import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function contextModeServer(root: string): string | undefined {
  for (const candidate of [
    join(root, "server.bundle.mjs"),
    join(root, "build", "server.bundle.mjs"),
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

export function contextModeRoot(cwd = process.cwd()): string | undefined {
  const configured = process.env.PI_SUBAGENT_CONTEXT_MODE_DIR?.trim();
  for (const candidate of [
    configured,
    join(homedir(), ".pi", "agent", "npm", "node_modules", "context-mode"),
    join(cwd, "node_modules", "context-mode"),
  ]) {
    if (typeof candidate === "string" && candidate && contextModeServer(candidate))
      return candidate;
  }
  return undefined;
}

export function contextModeAvailable(cwd = process.cwd()): boolean {
  return Boolean(contextModeRoot(cwd));
}
