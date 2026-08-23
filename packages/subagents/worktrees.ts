import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";

export type GitRepositoryState = {
  root: string;
  cwdRelative: string;
  head: string;
  dirty: boolean;
  status: string;
};

export type MissionWorktree = {
  missionId: string;
  root: string;
  cwd: string;
  baseCommit: string;
  sourceRoot: string;
};

export type WorktreeCandidate = {
  patch: string;
  files: string[];
  hasChanges: boolean;
};

type CommandResult = { stdout: string; stderr: string; code: number };
type AbortOptions = { signal?: AbortSignal };

type OwnedCommand = {
  child: ChildProcessWithoutNullStreams;
  closed: boolean;
};

function optionSignal(value: AbortSignal | AbortOptions | undefined): AbortSignal | undefined {
  return value && "aborted" in value ? value : value?.signal;
}

function cancellationError(signal: AbortSignal | undefined): Error {
  return signal?.reason instanceof Error ? signal.reason : new Error("Git operation was aborted.");
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw cancellationError(signal);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await fs.lstat(path);
    return true;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw cause;
  }
}

function processGroupAlive(command: OwnedCommand): boolean {
  if (process.platform === "win32" || !command.child.pid) return !command.closed;
  try {
    process.kill(-command.child.pid, 0);
    return true;
  } catch (cause) {
    return (cause as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function signalProcessGroup(command: OwnedCommand, signal: NodeJS.Signals): void {
  if (process.platform !== "win32" && command.child.pid) {
    try {
      process.kill(-command.child.pid, signal);
      return;
    } catch {
      // Fall back to the direct child when the group has already gone or cannot be signalled.
    }
  }
  if (command.child.exitCode === null && command.child.signalCode === null)
    command.child.kill(signal);
}

async function waitForProcessGroup(command: OwnedCommand, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (command.closed && !processGroupAlive(command)) return true;
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 20));
  }
  return command.closed && !processGroupAlive(command);
}

async function terminateProcessGroup(command: OwnedCommand): Promise<void> {
  if (command.closed && !processGroupAlive(command)) return;
  for (const [signal, timeoutMs] of [
    ["SIGINT", 250],
    ["SIGTERM", 500],
    ["SIGKILL", 1_000],
  ] as const) {
    signalProcessGroup(command, signal);
    if (await waitForProcessGroup(command, timeoutMs)) return;
  }
  throw new Error(
    `owned process group ${command.child.pid ?? "unknown"} could not be proven terminated`,
  );
}

function run(
  command: string,
  args: string[],
  options: { cwd: string; input?: string; timeoutMs?: number; signal?: AbortSignal },
): Promise<CommandResult> {
  throwIfAborted(options.signal);
  return new Promise((resolveResult, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      detached: process.platform !== "win32",
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const owned: OwnedCommand = { child, closed: false };
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;
    let stopping = false;

    const cleanup = () => {
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", onAbort);
    };
    const finishError = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const stop = (error: Error) => {
      if (settled || stopping) return;
      stopping = true;
      void terminateProcessGroup(owned).then(
        () => finishError(error),
        (terminationCause: unknown) => {
          const detail =
            terminationCause instanceof Error ? terminationCause.message : String(terminationCause);
          finishError(
            new Error(`${error.message} Git state was retained because ${detail}.`, {
              cause: error,
            }),
          );
        },
      );
    };
    const onAbort = () => stop(cancellationError(options.signal));
    const timeout = setTimeout(
      () => stop(new Error(`${command} ${args.join(" ")} timed out.`)),
      options.timeoutMs ?? 30_000,
    );
    timeout.unref?.();
    options.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.stdin.on("error", (error: NodeJS.ErrnoException) => {
      // Short-lived Git commands can exit before EOF reaches their unused stdin pipe.
      if (error.code !== "EPIPE") stop(error);
    });
    child.once("error", (error) => {
      owned.closed = true;
      if (!stopping) finishError(error);
    });
    child.once("close", (code) => {
      owned.closed = true;
      if (settled || stopping) return;
      settled = true;
      cleanup();
      resolveResult({
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        code: code ?? -1,
      });
    });
    child.stdin.end(options.input);
    // Close the race between the pre-spawn check and listener installation.
    if (options.signal?.aborted) onAbort();
  });
}

async function git(
  cwd: string,
  args: string[],
  input?: string,
  signal?: AbortSignal,
): Promise<string> {
  const result = await run("git", args, { cwd, input, signal });
  if (result.code !== 0)
    throw new Error(
      result.stderr.trim() || result.stdout.trim() || `git ${args.join(" ")} failed.`,
    );
  return result.stdout;
}

function safeId(value: string): string {
  const safe = value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  if (!safe) throw new Error("Mission id must contain a letter or number.");
  return safe.slice(0, 64);
}

export async function inspectGitRepository(
  cwd: string,
  options?: AbortSignal | AbortOptions,
): Promise<GitRepositoryState | undefined> {
  const signal = optionSignal(options);
  throwIfAborted(signal);
  let root: string;
  try {
    root = (await git(cwd, ["rev-parse", "--show-toplevel"], undefined, signal)).trim();
  } catch (cause) {
    if (signal?.aborted) throw cause;
    return undefined;
  }
  const head = (await git(root, ["rev-parse", "HEAD"], undefined, signal)).trim();
  const status = await git(
    root,
    ["status", "--porcelain=v1", "--untracked-files=normal"],
    undefined,
    signal,
  );
  return {
    root,
    cwdRelative: relative(root, resolve(cwd)),
    head,
    dirty: Boolean(status.trim()),
    status: status.trimEnd(),
  };
}

export async function createMissionWorktree(
  cwd: string,
  missionId: string,
  baseDirectoryOrOptions:
    | string
    | {
        baseDirectory?: string;
        signal?: AbortSignal;
        onPrepared?: (worktree: MissionWorktree) => void;
      } = tmpdir(),
  explicitSignal?: AbortSignal,
): Promise<MissionWorktree> {
  const baseDirectory =
    typeof baseDirectoryOrOptions === "string"
      ? baseDirectoryOrOptions
      : (baseDirectoryOrOptions.baseDirectory ?? tmpdir());
  const signal =
    typeof baseDirectoryOrOptions === "string" ? explicitSignal : baseDirectoryOrOptions.signal;
  const state = await inspectGitRepository(cwd, signal);
  if (!state) throw new Error("An isolated mission requires a Git repository.");
  if (state.dirty)
    throw new Error(
      "The repository has uncommitted changes. Clean it, cancel, or explicitly choose one shared-tree writer; Hackler never stash or copy local changes automatically.",
    );
  const id = safeId(missionId);
  const root = join(resolve(baseDirectory), `pi-mission-${id}`);
  const prepared: MissionWorktree = {
    missionId: id,
    root,
    cwd: state.cwdRelative ? join(root, state.cwdRelative) : root,
    baseCommit: state.head,
    sourceRoot: state.root,
  };
  if (typeof baseDirectoryOrOptions !== "string")
    baseDirectoryOrOptions.onPrepared?.({ ...prepared });
  throwIfAborted(signal);
  await fs.mkdir(baseDirectory, { recursive: true });
  throwIfAborted(signal);
  try {
    const result = await run("git", ["worktree", "add", "--detach", root, state.head], {
      cwd: state.root,
      timeoutMs: 60_000,
      signal,
    });
    if (result.code !== 0)
      throw new Error(result.stderr.trim() || `Failed to create mission worktree ${root}.`);
  } catch (cause) {
    if (signal?.aborted)
      throw new Error(
        `${cancellationError(signal).message} Mission worktree state, if created, is retained at ${root}.`,
        { cause },
      );
    throw cause;
  }
  return prepared;
}

/** Stage only inside the isolated worktree to produce a binary-safe candidate patch. */
export async function captureWorktreeCandidate(
  worktree: MissionWorktree,
  options?: AbortSignal | AbortOptions,
): Promise<WorktreeCandidate> {
  const signal = optionSignal(options);
  await git(worktree.root, ["add", "-A"], undefined, signal);
  try {
    const [patch, names] = await Promise.all([
      git(
        worktree.root,
        ["diff", "--cached", "--binary", "--full-index", worktree.baseCommit],
        undefined,
        signal,
      ),
      git(
        worktree.root,
        ["diff", "--cached", "--name-only", "-z", worktree.baseCommit],
        undefined,
        signal,
      ),
    ]);
    const files = names.split("\0").filter(Boolean);
    return { patch, files, hasChanges: files.length > 0 };
  } finally {
    // Reset is part of capture and uses the same cancellation contract. On cancellation the
    // isolated worktree is retained, making any staged state inspectable rather than hidden.
    await git(worktree.root, ["reset", "--mixed", worktree.baseCommit], undefined, signal);
  }
}

export async function checkCandidateApplies(
  sourceRoot: string,
  candidate: Pick<WorktreeCandidate, "patch" | "hasChanges">,
  options?: AbortSignal | AbortOptions,
): Promise<void> {
  const signal = optionSignal(options);
  throwIfAborted(signal);
  if (!candidate.hasChanges) return;
  const result = await run("git", ["apply", "--check", "--binary", "-"], {
    cwd: sourceRoot,
    input: candidate.patch,
    signal,
  });
  if (result.code !== 0)
    throw new Error(
      `The integration candidate no longer applies cleanly: ${result.stderr.trim() || result.stdout.trim()}`,
    );
}

export async function applyCandidate(
  sourceRoot: string,
  candidate: Pick<WorktreeCandidate, "patch" | "hasChanges">,
  options?: AbortSignal | AbortOptions,
): Promise<void> {
  const signal = optionSignal(options);
  throwIfAborted(signal);
  if (!candidate.hasChanges) return;
  await checkCandidateApplies(sourceRoot, candidate, signal);
  const result = await run("git", ["apply", "--binary", "--whitespace=nowarn", "-"], {
    cwd: sourceRoot,
    input: candidate.patch,
    signal,
  });
  if (result.code !== 0)
    throw new Error(
      result.stderr.trim() || result.stdout.trim() || "Failed to apply candidate patch.",
    );
}

export async function validateMissionWorktree(
  worktree: MissionWorktree,
  expectedCwd: string,
  options?: AbortSignal | AbortOptions,
): Promise<MissionWorktree> {
  const signal = optionSignal(options);
  throwIfAborted(signal);
  if (!isAbsolute(worktree.root) || !isAbsolute(worktree.cwd) || !isAbsolute(worktree.sourceRoot))
    throw new Error("Persisted worktree paths must be absolute.");
  if (!/^[0-9a-f]{40,64}$/iu.test(worktree.baseCommit))
    throw new Error("Persisted worktree base commit is invalid.");
  const [root, cwd, sourceRoot] = await Promise.all([
    fs.realpath(worktree.root),
    fs.realpath(worktree.cwd),
    fs.realpath(worktree.sourceRoot),
  ]);
  throwIfAborted(signal);
  const cwdWithinRoot = relative(root, cwd);
  if (
    cwdWithinRoot === ".." ||
    cwdWithinRoot.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)
  )
    throw new Error("Persisted worktree cwd is outside its worktree root.");
  const expected = await inspectGitRepository(expectedCwd, signal);
  throwIfAborted(signal);
  if (!expected || (await fs.realpath(expected.root)) !== sourceRoot)
    throw new Error("Persisted worktree belongs to a different source repository.");
  throwIfAborted(signal);
  const registered = (await git(sourceRoot, ["worktree", "list", "--porcelain"], undefined, signal))
    .split(/\r?\n/u)
    .filter((line) => line.startsWith("worktree "))
    .map((line) => resolve(line.slice("worktree ".length)));
  if (!registered.includes(root))
    throw new Error("Persisted worktree is no longer registered with Git.");
  return { ...worktree, root, cwd, sourceRoot };
}

export async function removeMissionWorktree(
  worktree: MissionWorktree,
  options: { force?: boolean; signal?: AbortSignal } = {},
): Promise<void> {
  throwIfAborted(options.signal);
  const args = ["worktree", "remove"];
  if (options.force) args.push("--force");
  args.push(worktree.root);
  const result = await run("git", args, {
    cwd: worktree.sourceRoot,
    timeoutMs: 60_000,
    signal: options.signal,
  });
  if (result.code !== 0) {
    if (!/not a working tree|does not exist/iu.test(result.stderr))
      throw new Error(
        `${result.stderr.trim() || `Failed to remove worktree ${basename(worktree.root)}.`} Worktree retained at ${worktree.root}.`,
      );
    if (await pathExists(worktree.root))
      throw new Error(
        `Git no longer recognizes ${basename(worktree.root)} as a worktree, but its directory still exists. Safe cleanup cannot be proven; worktree retained at ${worktree.root}.`,
      );
  }
  if (await pathExists(worktree.root))
    throw new Error(
      `Git reported that ${basename(worktree.root)} was removed, but its directory still exists. Safe cleanup cannot be proven; worktree retained at ${worktree.root}.`,
    );
  try {
    await run("git", ["worktree", "prune"], {
      cwd: worktree.sourceRoot,
      signal: options.signal,
    });
  } catch (cause) {
    if (options.signal?.aborted) throw cause;
    // Removal is already proven; pruning stale administrative entries is best effort.
  }
}
