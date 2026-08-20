import { spawn } from "node:child_process";
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

function run(
  command: string,
  args: string[],
  options: { cwd: string; input?: string; timeoutMs?: number },
): Promise<CommandResult> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    };
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      fail(new Error(`${command} ${args.join(" ")} timed out.`));
    }, options.timeoutMs ?? 30_000);
    timeout.unref?.();
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.stdin.on("error", (error: NodeJS.ErrnoException) => {
      // Short-lived Git commands can exit before EOF reaches their unused stdin pipe.
      if (error.code !== "EPIPE") fail(error);
    });
    child.once("error", fail);
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolveResult({
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        code: code ?? -1,
      });
    });
    child.stdin.end(options.input);
  });
}

async function git(cwd: string, args: string[], input?: string): Promise<string> {
  const result = await run("git", args, { cwd, input });
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

export async function inspectGitRepository(cwd: string): Promise<GitRepositoryState | undefined> {
  let root: string;
  try {
    root = (await git(cwd, ["rev-parse", "--show-toplevel"])).trim();
  } catch {
    return undefined;
  }
  const head = (await git(root, ["rev-parse", "HEAD"])).trim();
  const status = await git(root, ["status", "--porcelain=v1", "--untracked-files=normal"]);
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
  baseDirectory = tmpdir(),
): Promise<MissionWorktree> {
  const state = await inspectGitRepository(cwd);
  if (!state) throw new Error("An isolated mission requires a Git repository.");
  if (state.dirty)
    throw new Error(
      "The repository has uncommitted changes. Clean it, cancel, or explicitly choose one shared-tree writer; Subagents never stash or copy local changes automatically.",
    );
  const id = safeId(missionId);
  const root = join(resolve(baseDirectory), `pi-mission-${id}`);
  await fs.mkdir(baseDirectory, { recursive: true });
  const result = await run("git", ["worktree", "add", "--detach", root, state.head], {
    cwd: state.root,
    timeoutMs: 60_000,
  });
  if (result.code !== 0)
    throw new Error(result.stderr.trim() || `Failed to create mission worktree ${root}.`);
  return {
    missionId: id,
    root,
    cwd: state.cwdRelative ? join(root, state.cwdRelative) : root,
    baseCommit: state.head,
    sourceRoot: state.root,
  };
}

/** Stage only inside the isolated worktree to produce a binary-safe candidate patch. */
export async function captureWorktreeCandidate(
  worktree: MissionWorktree,
): Promise<WorktreeCandidate> {
  await git(worktree.root, ["add", "-A"]);
  try {
    const [patch, names] = await Promise.all([
      git(worktree.root, ["diff", "--cached", "--binary", "--full-index", worktree.baseCommit]),
      git(worktree.root, ["diff", "--cached", "--name-only", "-z", worktree.baseCommit]),
    ]);
    const files = names.split("\0").filter(Boolean);
    return { patch, files, hasChanges: files.length > 0 };
  } finally {
    await git(worktree.root, ["reset", "--mixed", worktree.baseCommit]);
  }
}

export async function checkCandidateApplies(
  sourceRoot: string,
  candidate: Pick<WorktreeCandidate, "patch" | "hasChanges">,
): Promise<void> {
  if (!candidate.hasChanges) return;
  const result = await run("git", ["apply", "--check", "--binary", "-"], {
    cwd: sourceRoot,
    input: candidate.patch,
  });
  if (result.code !== 0)
    throw new Error(
      `The integration candidate no longer applies cleanly: ${result.stderr.trim() || result.stdout.trim()}`,
    );
}

export async function applyCandidate(
  sourceRoot: string,
  candidate: Pick<WorktreeCandidate, "patch" | "hasChanges">,
): Promise<void> {
  if (!candidate.hasChanges) return;
  await checkCandidateApplies(sourceRoot, candidate);
  const result = await run("git", ["apply", "--binary", "--whitespace=nowarn", "-"], {
    cwd: sourceRoot,
    input: candidate.patch,
  });
  if (result.code !== 0)
    throw new Error(
      result.stderr.trim() || result.stdout.trim() || "Failed to apply candidate patch.",
    );
}

export async function validateMissionWorktree(
  worktree: MissionWorktree,
  expectedCwd: string,
): Promise<MissionWorktree> {
  if (!isAbsolute(worktree.root) || !isAbsolute(worktree.cwd) || !isAbsolute(worktree.sourceRoot))
    throw new Error("Persisted worktree paths must be absolute.");
  if (!/^[0-9a-f]{40,64}$/iu.test(worktree.baseCommit))
    throw new Error("Persisted worktree base commit is invalid.");
  const [root, cwd, sourceRoot] = await Promise.all([
    fs.realpath(worktree.root),
    fs.realpath(worktree.cwd),
    fs.realpath(worktree.sourceRoot),
  ]);
  const cwdWithinRoot = relative(root, cwd);
  if (
    cwdWithinRoot === ".." ||
    cwdWithinRoot.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)
  )
    throw new Error("Persisted worktree cwd is outside its worktree root.");
  const expected = await inspectGitRepository(expectedCwd);
  if (!expected || (await fs.realpath(expected.root)) !== sourceRoot)
    throw new Error("Persisted worktree belongs to a different source repository.");
  const registered = (await git(sourceRoot, ["worktree", "list", "--porcelain"]))
    .split(/\r?\n/u)
    .filter((line) => line.startsWith("worktree "))
    .map((line) => resolve(line.slice("worktree ".length)));
  if (!registered.includes(root))
    throw new Error("Persisted worktree is no longer registered with Git.");
  return { ...worktree, root, cwd, sourceRoot };
}

export async function removeMissionWorktree(
  worktree: MissionWorktree,
  options: { force?: boolean } = {},
): Promise<void> {
  const args = ["worktree", "remove"];
  if (options.force) args.push("--force");
  args.push(worktree.root);
  const result = await run("git", args, { cwd: worktree.sourceRoot, timeoutMs: 60_000 });
  if (result.code !== 0 && !/not a working tree|does not exist/iu.test(result.stderr))
    throw new Error(
      result.stderr.trim() || `Failed to remove worktree ${basename(worktree.root)}.`,
    );
  await run("git", ["worktree", "prune"], { cwd: worktree.sourceRoot }).catch(() => ({
    stdout: "",
    stderr: "",
    code: 0,
  }));
}
