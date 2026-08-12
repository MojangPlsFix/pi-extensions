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
const DEFAULT_GIT_TIMEOUT_MS = 10 * 60 * 1000;
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

export type CloneRepositoryReferenceOptions = {
  onProgress?: (progress: RepositoryReferenceProgress) => void;
  signal?: AbortSignal;
  timeoutMs?: number;
  verbose?: boolean;
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

function killChild(child: ReturnType<typeof spawn>): void {
  if (!child.killed) child.kill();
}

export const runGit: GitRunner = (args, cwd, options = {}) => {
  const timeoutMs = Math.max(1, options.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS);

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

    const child = spawn("git", args, {
      cwd,
      env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let cancelled = false;
    let timeout: NodeJS.Timeout | undefined;

    const cleanup = (): void => {
      if (timeout) clearTimeout(timeout);
      options.signal?.removeEventListener("abort", onAbort);
    };

    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    };

    const onAbort = (): void => {
      cancelled = true;
      killChild(child);
    };

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

    child.once("close", (code, signal) => {
      finish(() => {
        if (cancelled) {
          rejectPromise(
            new GitCommandError(`${commandName(args)} was cancelled`, {
              args,
              stdout,
              stderr,
              exitCode: code ?? undefined,
              signal,
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
              exitCode: code ?? undefined,
              signal,
              timedOut: true,
            }),
          );
          return;
        }
        if (code !== 0) {
          const status = signal ? `signal ${signal}` : `exit code ${code ?? "unknown"}`;
          rejectPromise(
            new GitCommandError(`${commandName(args)} failed with ${status}`, {
              args,
              stdout,
              stderr,
              exitCode: code ?? undefined,
              signal,
            }),
          );
          return;
        }
        resolvePromise({ stdout, stderr, code: 0 });
      });
    });

    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) onAbort();

    timeout = setTimeout(() => {
      timedOut = true;
      killChild(child);
    }, timeoutMs);
  });
};

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

function revisionCandidates(revision: string): string[] {
  if (revision === "HEAD" || /^[0-9a-f]{7,64}$/i.test(revision)) return [revision];
  if (revision.startsWith("refs/heads/"))
    return [`refs/remotes/origin/${revision.slice("refs/heads/".length)}`];
  if (revision.startsWith("refs/")) return [revision];
  return [`refs/remotes/origin/${revision}`, `refs/tags/${revision}`, revision];
}

function failureText(error: unknown): string {
  if (error instanceof GitCommandError) return error.stderr.trim() || error.message;
  return error instanceof Error ? error.message : String(error);
}

async function resolveRevision(
  path: string,
  revision: string,
  git: (args: string[]) => Promise<GitResult>,
): Promise<string> {
  const candidates = revisionCandidates(revision);
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

const COMMIT_SHA = /^[0-9a-f]{40}$/i;

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
  return lines.join("\n");
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
  const path = await fs.mkdtemp(join(managedRoot, "ref-"));
  const id = basename(path);
  let phase: RepositoryReferencePhase = "clone";
  const deadline = Date.now() + (cloneOptions.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS);
  const progressLines: string[] = [];

  const publish = (progress: RepositoryReferenceProgress): void => {
    const message = sanitizeGitOutput(progress.message, remoteResult.remote).trim();
    if (!message) return;
    progressLines.push(message);
    while (progressLines.length > MAX_PROGRESS_LINES) progressLines.shift();
    cloneOptions.onProgress?.({
      ...progress,
      message,
      output: progress.output
        ? sanitizeGitOutput(progress.output, remoteResult.remote).trim()
        : undefined,
    });
  };

  const run = async (
    args: string[],
    cwd: string | undefined,
    commandPhase: RepositoryReferencePhase,
    announce?: string,
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
        timeoutMs: remaining,
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
    await run(
      ["clone", "--no-checkout", "--progress", remoteResult.remote, path],
      undefined,
      "clone",
      "Cloning repository…",
    );
    publish({
      phase: "resolve-revision",
      message: `Resolving revision ${revisionResult.revision}…`,
    });
    const resolvedRevision = await resolveRevision(path, revisionResult.revision, (args) =>
      run(args, path, "resolve-revision"),
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
      id,
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
    publish({ phase, message: `Repository reference ${id} is ready.` });
    return reference;
  } catch (error) {
    const diagnostics = diagnosticsFor(
      error,
      phase,
      revisionResult.revision,
      cloneOptions.verbose ?? false,
    );
    const diagnosticText = formatDiagnostics(diagnostics, remoteResult.remote);
    const baseMessage = sanitizeGitOutput(failureText(error), remoteResult.remote);
    const message = diagnosticText ? `${baseMessage}\n${diagnosticText}` : baseMessage;
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
      },
    });
    await fs.rm(path, { recursive: true, force: true }).catch(() => undefined);
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
  await fs.rm(referencePath(managedRoot, idResult.id), { recursive: true, force: true });
}

export async function cleanupRepositoryReferences(
  root = REPOSITORY_REFERENCE_ROOT,
): Promise<RepositoryReference[]> {
  const references = await listRepositoryReferences(root);
  for (const reference of references) await removeRepositoryReference(reference.id, root);
  return references;
}

export const repositoryReferenceMetadataFile = METADATA_FILE;
