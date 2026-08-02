import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type BashOperations,
  createBashTool,
  createLocalBashOperations,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { commandPrefix, getBlockedCommandMessage } from "../uv/index.js";

export const RTK_REWRITE_TIMEOUT_MS = 1_500;
export const RESOURCE_PROBE_TIMEOUT_MS = 1_500;
export const TERMINATION_ESCALATION_MS = 100;
export const RTK_MIN_VERSION = { major: 0, minor: 23, patch: 0 } as const;

export type ProbeResult = { ok: boolean; output: string; error?: string };
export type ResourceProbeCache = Map<string, Promise<boolean>>;

function versionFrom(output: string): { major: number; minor: number; patch: number } | undefined {
  const match = /\b(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?\b/u.exec(output);
  return match
    ? { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) }
    : undefined;
}

export function isSupportedRtkVersion(output: string): boolean {
  const version = versionFrom(output);
  if (!version) return false;
  if (version.major !== RTK_MIN_VERSION.major) return version.major > RTK_MIN_VERSION.major;
  if (version.minor !== RTK_MIN_VERSION.minor) return version.minor > RTK_MIN_VERSION.minor;
  return version.patch >= RTK_MIN_VERSION.patch;
}

/** Execute a fixed executable with an argv array; never uses a shell for probes or rewrites. */
export function runExecutable(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<ProbeResult> {
  const timeoutMs = Math.max(1, options.timeoutMs ?? RESOURCE_PROBE_TIMEOUT_MS);
  if (options.signal?.aborted) return Promise.resolve({ ok: false, output: "", error: "aborted" });
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let errorOutput = "";
    let settled = false;
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    let escalationTimer: ReturnType<typeof setTimeout> | undefined;
    let terminationResult: ProbeResult | undefined;
    let abort = () => {};
    const finish = (result: ProbeResult) => {
      if (settled) return;
      settled = true;
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (escalationTimer) clearTimeout(escalationTimer);
      options.signal?.removeEventListener("abort", abort);
      resolve(result);
    };
    const terminate = (result: ProbeResult) => {
      if (settled || terminationResult) return;
      terminationResult = result;
      try {
        child.kill("SIGTERM");
      } catch {
        /* Escalation below still attempts a forceful kill. */
      }
      escalationTimer = setTimeout(() => {
        if (settled) return;
        try {
          if (!child.kill("SIGKILL")) child.kill();
        } catch {
          try {
            child.kill();
          } catch {
            /* The process may have exited between escalation checks. */
          }
        }
        // Do not wait indefinitely for a broken close event after SIGKILL.
        finish(result);
      }, TERMINATION_ESCALATION_MS);
    };
    abort = () => terminate({ ok: false, output, error: "aborted" });
    timeoutTimer = setTimeout(
      () => terminate({ ok: false, output, error: `timed out after ${timeoutMs}ms` }),
      timeoutMs,
    );
    options.signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(0, 64 * 1024);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      errorOutput = (errorOutput + chunk.toString()).slice(0, 16 * 1024);
    });
    child.once("error", (error) => finish({ ok: false, output, error: error.message }));
    child.once("close", (code) =>
      finish(
        terminationResult ?? {
          ok: code === 0,
          output,
          error: code === 0 ? undefined : errorOutput.trim() || `exit code ${code ?? "null"}`,
        },
      ),
    );
  });
}

export async function probeRtk(
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<boolean> {
  const result = await runExecutable("rtk", ["--version"], options);
  return result.ok && isSupportedRtkVersion(result.output);
}

export async function probeUv(
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<boolean> {
  return (await runExecutable("uv", ["--version"], options)).ok;
}

/** Rewrite one command, failing open for disabled, missing, malformed, slow, or failing RTK. */
export async function rewriteWithRtk(
  command: string,
  options: { cwd: string; env: NodeJS.ProcessEnv; signal?: AbortSignal },
): Promise<string> {
  if (options.env.RTK_DISABLED === "1") return command;
  try {
    const result = await runExecutable("rtk", ["rewrite", command], {
      cwd: options.cwd,
      env: options.env,
      timeoutMs: RTK_REWRITE_TIMEOUT_MS,
      signal: options.signal,
    });
    const rewritten = result.ok ? result.output.trim() : "";
    // Preserve RTK's full shell language; only reject NUL, which cannot be a valid shell protocol value.
    if (!rewritten || rewritten.includes("\0")) return command;
    return rewritten;
  } catch {
    return command;
  }
}

function uvShimsDirectory(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "uv", "shims");
}

export type BashComposition = {
  rtk: boolean;
  uv: boolean;
};

export type BashCompositionOverrides = {
  native?: BashOperations;
  rewrite?: typeof rewriteWithRtk;
  validate?: (command: string) => string | undefined;
  uvPrefix?: (path: string) => string;
};

export function composeBashOperations(
  composition: BashComposition,
  overrides: BashCompositionOverrides = {},
): BashOperations {
  const native = overrides.native ?? createLocalBashOperations();
  const rewrite = overrides.rewrite ?? rewriteWithRtk;
  const validate = overrides.validate ?? getBlockedCommandMessage;
  const uvPrefix = overrides.uvPrefix ?? commandPrefix;
  return {
    async exec(command, cwd, options) {
      // The order is intentional: RTK sees the original command; UV validates the rewritten one.
      const rewritten = composition.rtk
        ? await rewrite(command, { cwd, env: options.env ?? {}, signal: options.signal })
        : command;
      if (composition.uv) {
        const blocked = validate(rewritten);
        if (blocked) throw new Error(blocked);
      }
      const executable = composition.uv
        ? `${uvPrefix(uvShimsDirectory())}\n${rewritten}`
        : rewritten;
      return native.exec(executable, cwd, options);
    },
  };
}

/** The only Bash owner when RTK is effective; UV validation is composed inside it. */
export default function childRtkExtension(pi: ExtensionAPI): void {
  const rtk = process.env.PI_SUBAGENT_RTK === "1";
  const uv = process.env.PI_SUBAGENT_UV === "1";
  pi.registerTool(
    createBashTool(process.cwd(), {
      operations: composeBashOperations({ rtk, uv }),
      exposeSessionEnvironment: true,
    }),
  );
}
