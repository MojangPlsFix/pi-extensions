import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** The runtime is deliberately installed and updated outside this repository. */
export const CONTEXT_MODE_PACKAGE = "context-mode";
export const CONTEXT_MODE_VERSION = "1.0.169";

function packageVersion(root: string): string | undefined {
  try {
    const value = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      version?: unknown;
    };
    return typeof value.version === "string" ? value.version : undefined;
  } catch {
    return undefined;
  }
}

function candidateRoots(cwd: string): string[] {
  const configured =
    process.env.PI_CONTEXT_MODE_DIR?.trim() || process.env.PI_SUBAGENT_CONTEXT_MODE_DIR?.trim();
  return configured
    ? [configured]
    : [
        join(homedir(), ".pi", "agent", "npm", "node_modules", CONTEXT_MODE_PACKAGE),
        join(cwd, "node_modules", CONTEXT_MODE_PACKAGE),
      ];
}

/** Resolve only an installed, exactly pinned external Context Mode package. */
export function contextModeRoot(cwd = process.cwd()): string | undefined {
  for (const candidate of candidateRoots(cwd)) {
    if (!candidate || !contextModeServer(candidate)) continue;
    if (packageVersion(candidate) !== CONTEXT_MODE_VERSION) continue;
    return candidate;
  }
  return undefined;
}

export function contextModeServer(root: string): string | undefined {
  for (const candidate of [
    join(root, "server.bundle.mjs"),
    join(root, "build", "server.bundle.mjs"),
  ])
    if (existsSync(candidate)) return candidate;
  return undefined;
}

export function contextModeVersion(root: string): string | undefined {
  return packageVersion(root);
}

/** Explain why an otherwise discovered external package cannot be used. */
export function contextModeDiagnostic(cwd = process.cwd()): string {
  for (const candidate of candidateRoots(cwd)) {
    if (!candidate || !contextModeServer(candidate)) continue;
    const version = packageVersion(candidate);
    if (!version)
      return `Context Mode package at ${candidate} has no readable package.json version; install the pinned ${CONTEXT_MODE_VERSION} runtime.`;
    if (version !== CONTEXT_MODE_VERSION)
      return `Context Mode runtime ${version} at ${candidate} is unsupported; install the pinned ${CONTEXT_MODE_VERSION} runtime.`;
  }
  return `Context Mode runtime ${CONTEXT_MODE_VERSION} is not installed. Install it with: pi install context-mode@${CONTEXT_MODE_VERSION}`;
}

export function contextModeAvailable(cwd = process.cwd()): boolean {
  return Boolean(contextModeRoot(cwd));
}
