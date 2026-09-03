import { spawn } from "node:child_process";
import { type Dirent, promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import {
  isRepositoryReference,
  type RepositoryReference,
  type RepositoryReferenceDiagnostics,
  type RepositoryReferencePhase,
  type RepositoryReferenceProgress,
  sanitizeGitOutput,
  validateReferenceId,
  validateRemote,
  validateRevision,
} from "./model.js";

const METADATA_FILE = ".pi-repository-reference.json";
export const REPOSITORY_REFERENCE_ROOT = join(tmpdir(), "pi-repository-references");
export const DEFAULT_GIT_TIMEOUT_MS = 10 * 60 * 1000;
export const DEFAULT_REMOTE_PREFLIGHT_TIMEOUT_MS = 30 * 1000;
export const DEFAULT_CLEANUP_TIMEOUT_MS = 5 * 1000;
export const ARBITRARY_LOCAL_REF = "refs/pi-repository-reference/arbitrary";
export const PROCESS_TERMINATION_GRACE_MS = 250;
export const PROCESS_SETTLEMENT_FALLBACK_MS = 1000;
const MAX_CAPTURE_BYTES = 2 * 1024 * 1024;
const MAX_DIAGNOSTIC_BYTES = 16 * 1024;
const MAX_PROGRESS_LINES = 24;
const PROGRESS_INTERVAL_MS = 150;
const GIT_ENV = {
  ...process.env,
  GIT_TERMINAL_PROMPT: "0",
  GIT_OPTIONAL_LOCKS: "0",
};

export type GitOutputStream = "stdout" | "stderr";

export type GitRunOptions = {
  signal?: AbortSignal;
  timeoutMs?: number;
  verbose?: boolean;
  onOutput?: (stream: GitOutputStream, text: string) => void;
};

export type GitResult = {
  stdout: string;
  stderr: string;
  code: number;
};

export type GitRunner = (
  args: string[],
  cwd?: string,
  options?: GitRunOptions,
) => Promise<GitResult>;

export type GitSpawner = typeof spawn;

export type RemoveDirectory = (path: string) => Promise<void>;

export type RepositoryReferenceCleanupOptions = {
  timeoutMs?: number;
  remove?: RemoveDirectory;
};

export type CloneRepositoryReferenceOptions = {
  onProgress?: (progress: RepositoryReferenceProgress) => void;
  signal?: AbortSignal;
  timeoutMs?: number;
  verbose?: boolean;
  cleanup?: RepositoryReferenceCleanupOptions;
};

export class GitCommandError extends Error {
  readonly args: string[];
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | undefined;
  readonly signal: NodeJS.Signals | null | undefined;
  readonly timedOut: boolean;
  readonly cancelled: boolean;

  constructor(
    message: string,
    details: {
      args: string[];
      stdout?: string;
      stderr?: string;
      exitCode?: number;
      signal?: NodeJS.Signals | null;
      timedOut?: boolean;
      cancelled?: boolean;
    },
  ) {
    super(message);
    this.name = "GitCommandError";
    this.args = [...details.args];
    this.stdout = details.stdout ?? "";
    this.stderr = details.stderr ?? "";
    this.exitCode = details.exitCode;
    this.signal = details.signal;
    this.timedOut = details.timedOut ?? false;
    this.cancelled = details.cancelled ?? false;
  }
}

class RevisionResolutionError extends Error {
  readonly attemptedRefs: string[];
  readonly failures: string[];

  constructor(revision: string, attemptedRefs: string[], failures: string[]) {
    super(`revision ${revision} could not be resolved to a commit`);
    this.name = "RevisionResolutionError";
    this.attemptedRefs = [...attemptedRefs];
    this.failures = [...failures];
  }
}

function appendBounded(current: string, chunk: string, maxBytes: number): string {
  const combined = Buffer.concat([Buffer.from(current), Buffer.from(chunk)]);
  if (combined.byteLength <= maxBytes) return combined.toString("utf8");
  return combined.subarray(combined.byteLength - maxBytes).toString("utf8");
}

function tailText(value: string, maxBytes = MAX_DIAGNOSTIC_BYTES): string {
  return appendBounded("", value.trim(), maxBytes).trim();
}

function commandName(args: string[]): string {
  return args[0] ? `git ${args[0]}` : "git";
}

function boundedTimeout(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) ? Math.max(1, value) : fallback;
}

function terminateProcessTree(
  child: ReturnType<typeof spawn>,
  signal: NodeJS.Signals,
  spawnProcess: GitSpawner,
): void {
  const pid = child.pid;
  if (pid === undefined || pid === null) {
    try {
      child.kill(signal);
    } catch {
      // The child may have exited between the operation and termination request.
    }
    return;
  }

  if (process.platform === "win32") {
    try {
      child.kill(signal);
    } catch {
      // taskkill below is the process-tree fallback on Windows.
    }
    try {
      const killer = spawnProcess(
        "taskkill",
        ["/PID", String(pid), "/T", ...(signal === "SIGKILL" ? ["/F"] : [])],
        { shell: false, stdio: "ignore", windowsHide: true },
      );
      killer.once("error", () => undefined);
      killer.unref();
    } catch {
      // The direct child termination above remains the best available fallback.
    }
    return;
  }

  // A detached child is the leader of its own process group on POSIX. Killing the
  // group reaches Git's SSH/remote-helper descendants without involving a shell.
  try {
    process.kill(-pid, signal);
  } catch {
    // Fall back to the direct child if a platform does not expose the group.
    try {
      child.kill(signal);
    } catch {
      // The child may already have exited.
    }
  }
}

export function createGitRunner(spawnProcess: GitSpawner = spawn): GitRunner {
  return (args, cwd, options = {}) => {
    const timeoutMs = boundedTimeout(options.timeoutMs, DEFAULT_GIT_TIMEOUT_MS);

    return new Promise<GitResult>((resolvePromise, rejectPromise) => {
      if (options.signal?.aborted) {
        rejectPromise(
          new GitCommandError(`${commandName(args)} was cancelled`, {
            args,
            cancelled: true,
          }),
        );
        return;
      }

      const env: NodeJS.ProcessEnv = { ...GIT_ENV };
      if (options.verbose) {
        env.GIT_TRACE = "1";
        env.GIT_TRACE_PERFORMANCE = "1";
      }

      let child: ReturnType<typeof spawn>;
      try {
        child = spawnProcess("git", args, {
          cwd,
          env,
          shell: false,
          detached: process.platform !== "win32",
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (error) {
        rejectPromise(
          new GitCommandError(
            `${commandName(args)} could not start: ${error instanceof Error ? error.message : String(error)}`,
            { args },
          ),
        );
        return;
      }

      let stdout = "";
      let stderr = "";
      let settled = false;
      let timedOut = false;
      let cancelled = false;
      let terminationStarted = false;
      let timeout: NodeJS.Timeout | undefined;
      let escalationTimer: NodeJS.Timeout | undefined;
      let settlementFallbackTimer: NodeJS.Timeout | undefined;
      let closeGraceTimer: NodeJS.Timeout | undefined;
      let exitCode: number | undefined;
      let exitSignal: NodeJS.Signals | null | undefined;

      const cleanup = (): void => {
        if (timeout) clearTimeout(timeout);
        if (escalationTimer) clearTimeout(escalationTimer);
        if (settlementFallbackTimer) clearTimeout(settlementFallbackTimer);
        if (closeGraceTimer) clearTimeout(closeGraceTimer);
        options.signal?.removeEventListener("abort", onAbort);
      };

      const finish = (callback: () => void): void => {
        if (settled) return;
        settled = true;
        cleanup();
        // Do not let descendant-held pipes keep the extension alive after the
        // result has been decided. The process group has already been terminated
        // for cancellation/timeout; unref is the last-resort parent safeguard.
        child.stdout?.removeAllListeners("data");
        child.stderr?.removeAllListeners("data");
        child.stdout?.destroy();
        child.stderr?.destroy();
        if (terminationStarted) child.unref();
        callback();
      };

      const rejectForChildExit = (): void => {
        finish(() => {
          if (cancelled) {
            rejectPromise(
              new GitCommandError(`${commandName(args)} was cancelled`, {
                args,
                stdout,
                stderr,
                exitCode,
                signal: exitSignal,
                cancelled: true,
              }),
            );
            return;
          }
          if (timedOut) {
            rejectPromise(
              new GitCommandError(`${commandName(args)} timed out after ${timeoutMs}ms`, {
                args,
                stdout,
                stderr,
                exitCode,
                signal: exitSignal,
                timedOut: true,
              }),
            );
            return;
          }
          if (exitCode !== 0) {
            const status = exitSignal
              ? `signal ${exitSignal}`
              : `exit code ${exitCode ?? "unknown"}`;
            rejectPromise(
              new GitCommandError(`${commandName(args)} failed with ${status}`, {
                args,
                stdout,
                stderr,
                exitCode,
                signal: exitSignal,
              }),
            );
            return;
          }
          resolvePromise({ stdout, stderr, code: 0 });
        });
      };

      const beginTermination = (reason: "cancelled" | "timedOut"): void => {
        if (settled || terminationStarted) return;
        terminationStarted = true;
        if (reason === "cancelled") cancelled = true;
        else timedOut = true;
        terminateProcessTree(child, "SIGTERM", spawnProcess);
        if (settled) return;
        escalationTimer = setTimeout(() => {
          terminateProcessTree(child, "SIGKILL", spawnProcess);
        }, PROCESS_TERMINATION_GRACE_MS);
        settlementFallbackTimer = setTimeout(rejectForChildExit, PROCESS_SETTLEMENT_FALLBACK_MS);
      };

      const onAbort = (): void => beginTermination("cancelled");
      const emitOutput = (stream: GitOutputStream, chunk: Buffer | string): void => {
        const text = chunk.toString();
        if (stream === "stdout") stdout = appendBounded(stdout, text, MAX_CAPTURE_BYTES);
        else stderr = appendBounded(stderr, text, MAX_CAPTURE_BYTES);
        try {
          options.onOutput?.(stream, text);
        } catch {
          // Progress callbacks must not terminate the Git process.
        }
      };

      child.stdout?.on("data", (chunk: Buffer | string) => emitOutput("stdout", chunk));
      child.stderr?.on("data", (chunk: Buffer | string) => emitOutput("stderr", chunk));

      child.once("error", (error) => {
        finish(() =>
          rejectPromise(
            new GitCommandError(`${commandName(args)} could not start: ${error.message}`, {
              args,
              stdout,
              stderr,
              timedOut,
              cancelled,
            }),
          ),
        );
      });

      child.once("exit", (code, signal) => {
        exitCode = code ?? undefined;
        exitSignal = signal;
        if (terminationStarted) {
          rejectForChildExit();
          return;
        }
        // `close` normally follows quickly, but a descendant can retain one of
        // Git's pipes. Wait briefly for buffered diagnostics, never indefinitely.
        closeGraceTimer = setTimeout(rejectForChildExit, PROCESS_SETTLEMENT_FALLBACK_MS);
      });

      child.once("close", (code, signal) => {
        exitCode = code ?? exitCode;
        exitSignal = signal ?? exitSignal;
        rejectForChildExit();
      });

      timeout = setTimeout(() => beginTermination("timedOut"), timeoutMs);
      options.signal?.addEventListener("abort", onAbort, { once: true });
      if (options.signal?.aborted) onAbort();
      if (settled && timeout) clearTimeout(timeout);
    });
  };
}

export const runGit: GitRunner = createGitRunner();

function referenceRoot(root = REPOSITORY_REFERENCE_ROOT): string {
  return resolve(root);
}

function referencePath(root: string, id: string): string {
  return join(root, id);
}

async function ensureManagedRoot(root: string): Promise<string> {
  const managedRoot = referenceRoot(root);
  await fs.mkdir(managedRoot, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(managedRoot);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error("managed repository reference root is not a directory");
  return managedRoot;
}

async function readReference(root: string, id: string): Promise<RepositoryReference | undefined> {
  const path = referencePath(root, id);
  let stat: Awaited<ReturnType<typeof fs.lstat>> | undefined;
  try {
    stat = await fs.lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(await fs.readFile(join(path, METADATA_FILE), "utf8"));
  } catch {
    return undefined;
  }
  if (!isRepositoryReference(value) || resolve(value.path) !== path) return undefined;
  return value;
}

export async function listRepositoryReferences(
  root = REPOSITORY_REFERENCE_ROOT,
): Promise<RepositoryReference[]> {
  const managedRoot = await ensureManagedRoot(root);
  let entries: Dirent[];
  try {
    entries = await fs.readdir(managedRoot, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const references: RepositoryReference[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const idResult = validateReferenceId(entry.name);
    if ("error" in idResult) continue;
    const reference = await readReference(managedRoot, idResult.id);
    if (reference) references.push(reference);
  }
  return references.sort((left, right) => left.id.localeCompare(right.id));
}

const COMMIT_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
const COMMIT_REVISION = /^[0-9a-f]{7,64}$/i;

type AdvertisedRemote = {
  refs: Map<string, string>;
  headTarget?: string;
};

type ClonePlan = {
  singleBranch?: string;
  fetchRef?: string;
  localRef?: string;
};

export class RemoteRevisionNotFoundError extends Error {
  readonly attemptedRefs: string[];

  constructor(revision: string, attemptedRefs: string[]) {
    super(`remote revision ${revision} was not advertised by the remote`);
    this.name = "RemoteRevisionNotFoundError";
    this.attemptedRefs = [...attemptedRefs];
  }
}

function revisionCandidates(revision: string): string[] {
  if (revision === "HEAD" || COMMIT_REVISION.test(revision)) return [revision];
  if (revision.startsWith("refs/heads/"))
    return [`refs/remotes/origin/${revision.slice("refs/heads/".length)}`];
  if (revision.startsWith("refs/")) return [revision];
  return [`refs/remotes/origin/${revision}`, `refs/tags/${revision}`, revision];
}

function parseAdvertisedRemote(stdout: string): AdvertisedRemote {
  const refs = new Map<string, string>();
  let headTarget: string | undefined;

  for (const line of stdout.split(/\r?\n/)) {
    const separator = line.indexOf("\t");
    if (separator < 0) continue;
    const value = line.slice(0, separator);
    const ref = line.slice(separator + 1).trim();
    if (!ref) continue;
    if (value.startsWith("ref: ")) {
      if (ref === "HEAD") headTarget = value.slice("ref: ".length);
      continue;
    }
    if (!COMMIT_SHA.test(value)) continue;
    if (ref === "HEAD") continue;
    refs.set(ref, value);
  }

  return { refs, headTarget };
}

function singleBranchForRef(ref: string): string | undefined {
  if (ref.startsWith("refs/heads/")) return ref.slice("refs/heads/".length) || undefined;
  if (ref.startsWith("refs/tags/")) return ref.slice("refs/tags/".length) || undefined;
  return undefined;
}

function matchingCommitRef(remote: AdvertisedRemote, revision: string): string | undefined {
  const normalizedRevision = revision.toLowerCase();
  const matches = [...remote.refs.entries()]
    .filter(([, value]) => value.toLowerCase().startsWith(normalizedRevision))
    .map(([ref]) => (ref.endsWith("^{}") ? ref.slice(0, -3) : ref));
  const singleBranch = matches.find((ref) => ref.startsWith("refs/heads/"));
  const tag = matches.find((ref) => ref.startsWith("refs/tags/"));
  // A commit SHA may only be advertised through a provider-specific ref such as
  // refs/pull/* or refs/notes/*. Such refs need the explicit fetch below rather
  // than the normal clone refspecs, which only establish heads and tags.
  return singleBranch ?? tag ?? matches.find((ref) => ref.startsWith("refs/"));
}

function advertisedTagRef(remote: AdvertisedRemote, tagRef: string): string | undefined {
  return remote.refs.has(tagRef) || remote.refs.has(`${tagRef}^{}`) ? tagRef : undefined;
}

function advertisedRefForRevision(remote: AdvertisedRemote, revision: string): string | undefined {
  if (revision === "HEAD") return remote.headTarget;
  if (COMMIT_REVISION.test(revision)) return matchingCommitRef(remote, revision);

  if (revision.startsWith("refs/heads/")) {
    return remote.refs.has(revision) ? revision : undefined;
  }
  if (revision.startsWith("refs/tags/")) return advertisedTagRef(remote, revision);
  if (revision.startsWith("refs/remotes/origin/")) {
    // Keep accepting the historical origin-tracking spelling for branches, but
    // prefer an exact advertised ref if a remote uses this namespace itself.
    if (remote.refs.has(revision)) return revision;
    const branchRef = `refs/heads/${revision.slice("refs/remotes/origin/".length)}`;
    return remote.refs.has(branchRef) ? branchRef : undefined;
  }
  if (revision.startsWith("refs/")) return remote.refs.has(revision) ? revision : undefined;

  const branchRef = `refs/heads/${revision}`;
  if (remote.refs.has(branchRef)) return branchRef;
  return advertisedTagRef(remote, `refs/tags/${revision}`);
}

function clonePlanForRevision(remote: AdvertisedRemote, revision: string): ClonePlan {
  const advertisedRef = advertisedRefForRevision(remote, revision);
  if (advertisedRef) {
    const singleBranch = singleBranchForRef(advertisedRef);
    if (singleBranch) return { singleBranch };
    return { fetchRef: advertisedRef, localRef: ARBITRARY_LOCAL_REF };
  }

  // A commit can be reachable from an advertised ref without being the ref tip.
  // Keep the historical full clone fallback for those revisions rather than
  // incorrectly rejecting a valid commit that ls-remote cannot enumerate.
  if (revision === "HEAD" || COMMIT_REVISION.test(revision)) return {};

  throw new RemoteRevisionNotFoundError(revision, revisionCandidates(revision));
}

function failureText(error: unknown): string {
  if (error instanceof GitCommandError) return error.stderr.trim() || error.message;
  return error instanceof Error ? error.message : String(error);
}

async function resolveRevision(
  path: string,
  revision: string,
  git: (args: string[]) => Promise<GitResult>,
  resolutionCandidates = revisionCandidates(revision),
): Promise<string> {
  const candidates = resolutionCandidates;
  const failures: string[] = [];
  for (const candidate of candidates) {
    try {
      const resolved = (
        await git([
          "-C",
          path,
          "rev-parse",
          "--verify",
          "--end-of-options",
          `${candidate}^{commit}`,
        ])
      ).stdout.trim();
      if (COMMIT_SHA.test(resolved)) return resolved;
      failures.push(`${candidate}: no commit was returned`);
    } catch (error) {
      if (error instanceof GitCommandError && (error.cancelled || error.timedOut)) throw error;
      failures.push(`${candidate}: ${failureText(error)}`);
    }
  }
  throw new RevisionResolutionError(revision, candidates, failures);
}

function diagnosticsFor(
  error: unknown,
  phase: RepositoryReferencePhase,
  revision: string,
  verbose: boolean,
): RepositoryReferenceDiagnostics {
  if (error instanceof RevisionResolutionError) {
    return {
      phase,
      attemptedRefs: error.attemptedRefs,
      stderr: tailText(error.failures.join("\n")),
    };
  }
  if (error instanceof RemoteRevisionNotFoundError) {
    return {
      phase,
      attemptedRefs: error.attemptedRefs,
      stderr: tailText(error.message),
    };
  }
  if (error instanceof GitCommandError) {
    const diagnostics: RepositoryReferenceDiagnostics = {
      phase,
      stderr: tailText(error.stderr),
      exitCode: error.exitCode,
      signal: error.signal ?? undefined,
      timedOut: error.timedOut || undefined,
      cancelled: error.cancelled || undefined,
    };
    if (verbose && error.stdout.trim()) diagnostics.stdout = tailText(error.stdout);
    return diagnostics;
  }
  return {
    phase,
    attemptedRefs: phase === "resolve-revision" ? revisionCandidates(revision) : undefined,
    stderr: tailText(failureText(error)),
  };
}

function formatDiagnostics(diagnostics: RepositoryReferenceDiagnostics, remote: string): string {
  const lines: string[] = [];
  if (diagnostics.attemptedRefs?.length) {
    lines.push(`Attempted refs: ${diagnostics.attemptedRefs.join(", ")}`);
  }
  if (diagnostics.stderr) {
    lines.push(`Git diagnostics:\n${sanitizeGitOutput(diagnostics.stderr, remote)}`);
  }
  if (diagnostics.stdout) {
    lines.push(`Git output:\n${sanitizeGitOutput(diagnostics.stdout, remote)}`);
  }
  if (diagnostics.exitCode !== undefined) lines.push(`Exit code: ${diagnostics.exitCode}`);
  if (diagnostics.signal) lines.push(`Signal: ${diagnostics.signal}`);
  if (diagnostics.timedOut) lines.push("The Git operation timed out.");
  if (diagnostics.cancelled) lines.push("The Git operation was cancelled.");
  if (diagnostics.cleanup) {
    if (diagnostics.cleanup.completed) {
      lines.push("Incomplete clone directory cleanup completed.");
    } else if (diagnostics.cleanup.timedOut) {
      lines.push("Incomplete clone directory cleanup timed out; it was not confirmed removed.");
    } else {
      lines.push(
        `Incomplete clone directory cleanup failed${diagnostics.cleanup.error ? `: ${diagnostics.cleanup.error}` : "."}`,
      );
    }
    lines.push(
      `Incomplete clone directory retained for safe follow-up (removal was not confirmed): ${diagnostics.cleanup.path}`,
    );
  }
  return lines.join("\n");
}

export type RepositoryReferenceCleanupResult = {
  completed: boolean;
  timedOut: boolean;
  error?: unknown;
};

const removeDirectory: RemoveDirectory = (path) =>
  fs.rm(path, { recursive: true, force: true }).then(() => undefined);

export async function removeDirectoryBounded(
  path: string,
  options: RepositoryReferenceCleanupOptions = {},
): Promise<RepositoryReferenceCleanupResult> {
  const timeoutMs = boundedTimeout(options.timeoutMs, DEFAULT_CLEANUP_TIMEOUT_MS);
  const removal = Promise.resolve().then(() => (options.remove ?? removeDirectory)(path));
  // The race below intentionally does not await the underlying fs operation after
  // its deadline. Attach a rejection handler so a late failure is never unhandled.
  const observedRemoval = removal.then(
    () => "completed" as const,
    (error: unknown) => ({ kind: "failed" as const, error }),
  );
  let timeout: NodeJS.Timeout | undefined;
  const deadline = new Promise<"timedOut">((resolvePromise) => {
    timeout = setTimeout(() => resolvePromise("timedOut"), timeoutMs);
  });
  const outcome = await Promise.race([observedRemoval, deadline]);
  if (timeout) clearTimeout(timeout);
  if (outcome === "timedOut") return { completed: false, timedOut: true };
  if (outcome === "completed") return { completed: true, timedOut: false };
  return { completed: false, timedOut: false, error: outcome.error };
}

function normalizeCloneArguments(
  rootOrOptions: string | CloneRepositoryReferenceOptions,
  git: GitRunner,
  options: CloneRepositoryReferenceOptions,
): { root: string; git: GitRunner; options: CloneRepositoryReferenceOptions } {
  if (typeof rootOrOptions === "string") return { root: rootOrOptions, git, options };
  return { root: REPOSITORY_REFERENCE_ROOT, git: runGit, options: rootOrOptions };
}

export function cloneRepositoryReference(
  remoteInput: unknown,
  revisionInput: unknown,
  options?: CloneRepositoryReferenceOptions,
): Promise<RepositoryReference>;
export function cloneRepositoryReference(
  remoteInput: unknown,
  revisionInput: unknown,
  root?: string,
  git?: GitRunner,
  options?: CloneRepositoryReferenceOptions,
): Promise<RepositoryReference>;
export async function cloneRepositoryReference(
  remoteInput: unknown,
  revisionInput: unknown,
  rootOrOptions: string | CloneRepositoryReferenceOptions = REPOSITORY_REFERENCE_ROOT,
  git: GitRunner = runGit,
  options: CloneRepositoryReferenceOptions = {},
): Promise<RepositoryReference> {
  const remoteResult = validateRemote(remoteInput);
  if ("error" in remoteResult) throw new Error(remoteResult.error);
  const revisionResult = validateRevision(revisionInput);
  if ("error" in revisionResult) throw new Error(revisionResult.error);

  const normalized = normalizeCloneArguments(rootOrOptions, git, options);
  const { root, options: cloneOptions } = normalized;
  const managedRoot = await ensureManagedRoot(root);
  const operationTimeoutMs = boundedTimeout(cloneOptions.timeoutMs, DEFAULT_GIT_TIMEOUT_MS);
  const deadline = Date.now() + operationTimeoutMs;
  let phase: RepositoryReferencePhase = "preflight";
  let path: string | undefined;
  const progressLines: string[] = [];

  const publish = (progress: RepositoryReferenceProgress): void => {
    const message = sanitizeGitOutput(progress.message, remoteResult.remote).trim();
    if (!message) return;
    progressLines.push(message);
    while (progressLines.length > MAX_PROGRESS_LINES) progressLines.shift();
    try {
      cloneOptions.onProgress?.({
        ...progress,
        message,
        output: progress.output
          ? sanitizeGitOutput(progress.output, remoteResult.remote).trim()
          : undefined,
      });
    } catch {
      // Progress is best-effort; a renderer must not alter Git semantics.
    }
  };

  const run = async (
    args: string[],
    cwd: string | undefined,
    commandPhase: RepositoryReferencePhase,
    announce?: string,
    timeoutCapMs?: number,
  ): Promise<GitResult> => {
    phase = commandPhase;
    if (announce) publish({ phase, message: announce });
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new GitCommandError(`git ${args[0] ?? "command"} timed out`, {
        args,
        timedOut: true,
      });
    }
    const commandTimeoutMs = Math.min(remaining, timeoutCapMs ?? remaining);

    let pending = "";
    let pendingOutput: string | undefined;
    let lastOutputAt = 0;
    const emitLine = (line: string, force = false): void => {
      const cleaned = line.trim();
      if (!cleaned) return;
      const now = Date.now();
      if (!force && now - lastOutputAt < PROGRESS_INTERVAL_MS) {
        pendingOutput = cleaned;
        return;
      }
      pendingOutput = undefined;
      lastOutputAt = now;
      publish({ phase, message: cleaned, output: cleaned });
    };
    const onOutput = (stream: GitOutputStream, text: string): void => {
      if (stream === "stdout" && !cloneOptions.verbose) return;
      const parts = `${pending}${text}`.split(/[\r\n]/);
      pending = parts.pop() ?? "";
      for (const part of parts) emitLine(part);
    };
    const flushOutput = (): void => {
      if (pending.trim()) emitLine(pending);
      pending = "";
      if (pendingOutput) emitLine(pendingOutput, true);
      pendingOutput = undefined;
    };

    try {
      const result = await normalized.git(args, cwd, {
        signal: cloneOptions.signal,
        timeoutMs: commandTimeoutMs,
        verbose: cloneOptions.verbose,
        onOutput,
      });
      flushOutput();
      return result;
    } catch (error) {
      flushOutput();
      throw error;
    }
  };

  try {
    const remoteRefs = await run(
      ["ls-remote", "--symref", remoteResult.remote],
      undefined,
      "preflight",
      `Checking remote revision ${revisionResult.revision}…`,
      DEFAULT_REMOTE_PREFLIGHT_TIMEOUT_MS,
    );
    const clonePlan = clonePlanForRevision(
      parseAdvertisedRemote(remoteRefs.stdout),
      revisionResult.revision,
    );

    path = await fs.mkdtemp(join(managedRoot, "ref-"));
    const cloneArgs = ["clone", "--no-checkout", "--progress"];
    if (clonePlan.singleBranch) {
      cloneArgs.push("--single-branch", "--branch", clonePlan.singleBranch);
    }
    cloneArgs.push(remoteResult.remote, path);
    await run(cloneArgs, undefined, "clone", "Cloning repository…");
    if (clonePlan.fetchRef && clonePlan.localRef) {
      await run(
        ["-C", path, "fetch", "--no-tags", "origin", `${clonePlan.fetchRef}:${clonePlan.localRef}`],
        undefined,
        "clone",
        "Fetching requested remote ref…",
      );
    }
    publish({
      phase: "resolve-revision",
      message: `Resolving revision ${revisionResult.revision}…`,
    });
    const resolvedRevision = await resolveRevision(
      path,
      revisionResult.revision,
      (args) => run(args, path, "resolve-revision"),
      clonePlan.localRef ? [clonePlan.localRef] : undefined,
    );
    await run(
      ["-C", path, "checkout", "--detach", "--quiet", resolvedRevision],
      undefined,
      "checkout",
      "Checking out resolved commit…",
    );
    phase = "metadata";
    publish({ phase, message: "Writing repository reference metadata…" });
    const reference: RepositoryReference = {
      id: basename(path),
      remote: remoteResult.remote,
      revision: revisionResult.revision,
      resolvedRevision,
      path,
      createdAt: new Date().toISOString(),
    };
    await fs.writeFile(join(path, METADATA_FILE), `${JSON.stringify(reference, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    publish({ phase, message: `Repository reference ${reference.id} is ready.` });
    return reference;
  } catch (error) {
    const diagnostics = diagnosticsFor(
      error,
      phase,
      revisionResult.revision,
      cloneOptions.verbose ?? false,
    );
    let cleanupResult: RepositoryReferenceCleanupResult | undefined;
    if (path) {
      try {
        cleanupResult = await removeDirectoryBounded(path, cloneOptions.cleanup);
      } catch (cleanupError) {
        cleanupResult = { completed: false, timedOut: false, error: cleanupError };
      }
      if (cleanupResult && !cleanupResult.completed) {
        const cleanupError = cleanupResult.error
          ? sanitizeGitOutput(failureText(cleanupResult.error), remoteResult.remote)
          : undefined;
        diagnostics.cleanup = {
          path,
          completed: false,
          timedOut: cleanupResult.timedOut || undefined,
          error: cleanupError,
        };
      }
    }
    const diagnosticText = formatDiagnostics(diagnostics, remoteResult.remote);
    const baseMessage = sanitizeGitOutput(failureText(error), remoteResult.remote);
    const message = diagnosticText ? `${baseMessage}\n${diagnosticText}` : baseMessage;
    try {
      cloneOptions.onProgress?.({
        phase,
        message,
        diagnostics: {
          ...diagnostics,
          stderr: diagnostics.stderr
            ? sanitizeGitOutput(diagnostics.stderr, remoteResult.remote)
            : undefined,
          stdout: diagnostics.stdout
            ? sanitizeGitOutput(diagnostics.stdout, remoteResult.remote)
            : undefined,
          cleanup: diagnostics.cleanup
            ? {
                ...diagnostics.cleanup,
                error: diagnostics.cleanup.error
                  ? sanitizeGitOutput(diagnostics.cleanup.error, remoteResult.remote)
                  : undefined,
              }
            : undefined,
        },
      });
    } catch {
      // Preserve the primary clone failure when a renderer rejects progress.
    }
    throw new Error(`repository reference clone failed: ${message}`);
  }
}

export async function removeRepositoryReference(
  idInput: unknown,
  root = REPOSITORY_REFERENCE_ROOT,
): Promise<void> {
  const idResult = validateReferenceId(idInput);
  if ("error" in idResult) throw new Error(idResult.error);
  const managedRoot = await ensureManagedRoot(root);
  const reference = await readReference(managedRoot, idResult.id);
  if (!reference) throw new Error(`repository reference ${idResult.id} was not found`);
  const cleanup = await removeDirectoryBounded(referencePath(managedRoot, idResult.id));
  if (!cleanup.completed) {
    const reason = cleanup.timedOut
      ? `cleanup timed out after ${DEFAULT_CLEANUP_TIMEOUT_MS}ms`
      : `cleanup failed${cleanup.error ? `: ${failureText(cleanup.error)}` : ""}`;
    throw new Error(
      `repository reference ${idResult.id} could not be removed (${reason}); its directory was retained`,
    );
  }
}

export async function cleanupRepositoryReferences(
  root = REPOSITORY_REFERENCE_ROOT,
): Promise<RepositoryReference[]> {
  const references = await listRepositoryReferences(root);
  for (const reference of references) await removeRepositoryReference(reference.id, root);
  return references;
}

export const repositoryReferenceMetadataFile = METADATA_FILE;
