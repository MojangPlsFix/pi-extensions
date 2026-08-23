import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ValidatorDefinition } from "./config.js";
import {
  type MissionWorktree,
  validateWorktreeCandidate,
  type WorktreeCandidate,
} from "./worktrees.js";

export { deriveCandidateId } from "./worktrees.js";

export type ValidationTarget = { kind: "run" | "mission"; id: string };
export type ValidationStatus = "preparing" | "running" | "completed" | "interrupted";
export type ValidationOutcome =
  | "passed"
  | "failed"
  | "spawn-failure"
  | "timeout"
  | "aborted"
  | "output-overflow"
  | "preparation-failure";
export type ValidationCleanup = "pending" | "removed" | "retained";

export type ValidationRecord = {
  id: string;
  target: ValidationTarget;
  candidateId: string;
  validator: string;
  status: ValidationStatus;
  outcome?: ValidationOutcome;
  preparedAt: string;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  exitCode?: number;
  signal?: string;
  output: string;
  outputBytes: number;
  outputLimitBytes: number;
  outputTruncated: boolean;
  cleanup: ValidationCleanup;
  terminationProven: boolean;
  cleanupError?: string;
  intendedPath: string;
  sourceRoot: string;
  baseCommit: string;
  retainedPath?: string;
  error?: string;
};

export type ValidationRunnerInput = {
  target: ValidationTarget;
  validatorName: string;
  validator: ValidatorDefinition;
  candidate: WorktreeCandidate;
  worktree: MissionWorktree;
  signal?: AbortSignal;
  workspaceRoot?: string;
  onPreparing?: (record: ValidationRecord) => void | Promise<void>;
  onRunning?: (record: ValidationRecord) => void | Promise<void>;
  cleanupWorkspace?: (worktree: MissionWorktree) => Promise<{ removed: boolean; error?: string }>;
};

function iso(): string {
  return new Date().toISOString();
}

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function abortError(signal?: AbortSignal): Error {
  return signal?.reason instanceof Error ? signal.reason : new Error("Validation was aborted.");
}

function pathWithin(root: string, child: string): boolean {
  const value = relative(resolve(root), resolve(child));
  return value === "" || (value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value));
}

type OwnedProcess = { child: ChildProcessWithoutNullStreams; closed: boolean };

function processGroupAlive(owned: OwnedProcess): boolean {
  if (process.platform === "win32" || !owned.child.pid) return !owned.closed;
  try {
    process.kill(-owned.child.pid, 0);
    return true;
  } catch (cause) {
    return (cause as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function waitDead(owned: OwnedProcess, milliseconds: number): Promise<boolean> {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    if (owned.closed && !processGroupAlive(owned)) return true;
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
  return owned.closed && !processGroupAlive(owned);
}

function sendUnix(owned: OwnedProcess, signal: NodeJS.Signals): void {
  if (owned.child.pid) {
    try {
      process.kill(-owned.child.pid, signal);
      return;
    } catch {
      // The group can disappear between the liveness check and the signal.
    }
  }
  owned.child.kill(signal);
}

async function taskkill(pid: number, force: boolean): Promise<void> {
  await new Promise<void>((resolveTask) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveTask();
    };
    const child = spawn("taskkill", ["/PID", String(pid), "/T", ...(force ? ["/F"] : [])], {
      shell: false,
      windowsHide: true,
      stdio: "ignore",
    });
    const timer = setTimeout(() => {
      child.kill();
      finish();
    }, 2_000);
    timer.unref?.();
    child.once("error", finish);
    child.once("close", finish);
  });
}

/** Returns false when termination of the complete tree cannot be proved. */
async function terminateTree(owned: OwnedProcess): Promise<boolean> {
  if (owned.closed && !processGroupAlive(owned)) return true;
  if (process.platform === "win32") {
    if (!owned.child.pid) return false;
    await taskkill(owned.child.pid, false);
    if (!(await waitDead(owned, 500))) {
      await taskkill(owned.child.pid, true);
      await waitDead(owned, 1_000);
    }
    // Windows exposes no reliable process-tree proof after either taskkill path.
    return false;
  }
  for (const [signal, wait] of [
    ["SIGINT", 250],
    ["SIGTERM", 500],
    ["SIGKILL", 1_000],
  ] as const) {
    sendUnix(owned, signal);
    if (await waitDead(owned, wait)) return true;
  }
  return false;
}

type ProcessResult = {
  code?: number;
  signal?: string;
  output: Buffer;
  overflow: boolean;
  reason?: "timeout" | "aborted" | "overflow" | "spawn";
  error?: string;
  terminationProven: boolean;
};

function execute(
  command: string,
  args: string[],
  options: {
    cwd: string;
    input?: string | Buffer;
    timeoutMs: number;
    maxOutputBytes: number;
    signal?: AbortSignal;
    capture?: boolean;
    /** Internal Git helpers do not launch candidate-controlled descendants. */
    trustWindowsNaturalExit?: boolean;
  },
): Promise<ProcessResult> {
  if (options.signal?.aborted)
    return Promise.resolve({
      output: Buffer.alloc(0),
      overflow: false,
      reason: "aborted",
      error: abortError(options.signal).message,
      terminationProven: true,
    });
  return new Promise((resolveResult) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(command, args, {
        cwd: options.cwd,
        detached: process.platform !== "win32",
        shell: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (cause) {
      resolveResult({
        output: Buffer.alloc(0),
        overflow: false,
        reason: "spawn",
        error: errorText(cause),
        terminationProven: true,
      });
      return;
    }
    const owned: OwnedProcess = { child, closed: false };
    const chunks: Buffer[] = [];
    let bytes = 0;
    let overflow = false;
    let stopReason: ProcessResult["reason"];
    let stopError: string | undefined;
    let stopping: Promise<boolean> | undefined;
    let settled = false;
    const append = (chunk: Buffer) => {
      if (!options.capture || overflow) return;
      const remaining = options.maxOutputBytes - bytes;
      if (chunk.length <= remaining) {
        chunks.push(chunk);
        bytes += chunk.length;
        return;
      }
      if (remaining > 0) chunks.push(chunk.subarray(0, remaining));
      bytes += Math.max(0, remaining);
      overflow = true;
      beginStop("overflow", `Validator output exceeded ${options.maxOutputBytes} bytes.`);
    };
    const cleanup = () => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
    };
    const finish = async (code?: number, signal?: string) => {
      if (settled) return;
      settled = true;
      cleanup();
      let terminationProven: boolean;
      if (stopping) terminationProven = await stopping;
      else if (process.platform !== "win32" && processGroupAlive(owned))
        terminationProven = await terminateTree(owned);
      else if (process.platform === "win32")
        terminationProven =
          (options.trustWindowsNaturalExit === true && owned.closed) ||
          (stopReason === "spawn" && !owned.child.pid);
      else terminationProven = owned.closed;
      resolveResult({
        code,
        signal,
        output: Buffer.concat(chunks, bytes),
        overflow,
        reason: stopReason,
        error: stopError,
        terminationProven,
      });
    };
    const beginStop = (reason: NonNullable<ProcessResult["reason"]>, message: string) => {
      if (stopping || settled) return;
      stopReason = reason;
      stopError = message;
      stopping = terminateTree(owned);
      void stopping.then(() => finish(child.exitCode ?? undefined, child.signalCode ?? undefined));
    };
    const onAbort = () => beginStop("aborted", abortError(options.signal).message);
    const timer = setTimeout(
      () => beginStop("timeout", `Validator timed out after ${options.timeoutMs}ms.`),
      options.timeoutMs,
    );
    timer.unref?.();
    options.signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.stdin.on("error", (cause: NodeJS.ErrnoException) => {
      if (cause.code !== "EPIPE") beginStop("spawn", cause.message);
    });
    child.once("error", (cause) => {
      owned.closed = true;
      stopReason ??= "spawn";
      stopError ??= cause.message;
      void finish();
    });
    child.once("close", (code, signal) => {
      owned.closed = true;
      void finish(code ?? undefined, signal ?? undefined);
    });
    child.stdin.end(options.input);
    if (options.signal?.aborted) onAbort();
  });
}

class ProcessFailure extends Error {
  constructor(
    message: string,
    readonly terminationProven: boolean,
  ) {
    super(message);
  }
}

async function git(
  cwd: string,
  args: string[],
  options: { input?: string | Buffer; signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<Buffer> {
  const result = await execute("git", args, {
    cwd,
    input: options.input,
    signal: options.signal,
    timeoutMs: options.timeoutMs ?? 60_000,
    maxOutputBytes: 256_000,
    capture: true,
    trustWindowsNaturalExit: true,
  });
  if (result.reason || result.code !== 0)
    throw new ProcessFailure(
      result.error || result.output.toString("utf8").trim() || `git ${args.join(" ")} failed.`,
      result.terminationProven,
    );
  return result.output;
}

async function exists(path: string): Promise<boolean> {
  try {
    await fs.lstat(path);
    return true;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw cause;
  }
}

type CleanupResult = { removed: boolean; error?: string };

async function registeredWorktree(sourceRoot: string, root: string): Promise<boolean> {
  const output = await git(sourceRoot, ["worktree", "list", "--porcelain", "-z"]);
  const expected = resolve(root);
  return output
    .toString("utf8")
    .split("\0")
    .some((field) => field.startsWith("worktree ") && resolve(field.slice(9)) === expected);
}

async function removeWorkspace(worktree: MissionWorktree): Promise<CleanupResult> {
  try {
    await git(worktree.sourceRoot, ["worktree", "remove", "--force", worktree.root]);
  } catch (cause) {
    return { removed: false, error: `Workspace removal failed: ${errorText(cause)}` };
  }
  return { removed: true };
}

async function reconcileCleanup(
  worktree: MissionWorktree,
  cleanup: CleanupResult,
): Promise<CleanupResult> {
  if (!cleanup.removed || cleanup.error)
    return {
      removed: false,
      error: cleanup.error ?? "Workspace cleanup did not report successful removal.",
    };
  try {
    if (await exists(worktree.root))
      return { removed: false, error: "Cleanup reported removal but the workspace still exists." };
    await git(worktree.sourceRoot, ["worktree", "prune"]);
    if (await registeredWorktree(worktree.sourceRoot, worktree.root))
      return {
        removed: false,
        error: "The workspace directory is absent but remains registered with Git.",
      };
    return { removed: true };
  } catch (cause) {
    return {
      removed: false,
      error: `Workspace cleanup reconciliation failed: ${errorText(cause)}`,
    };
  }
}

async function validateCandidatePatchFiles(
  sourceRoot: string,
  candidate: WorktreeCandidate,
  patchBytes: Buffer,
  signal?: AbortSignal,
): Promise<void> {
  if (!candidate.hasChanges) return;
  const output = await git(sourceRoot, ["apply", "--numstat", "-z", "--binary", "-"], {
    input: patchBytes,
    signal,
  });
  const fields = output.toString("utf8").split("\0");
  while (fields.at(-1) === "") fields.pop();
  const files: string[] = [];
  for (let index = 0; index < fields.length; index += 1) {
    const entry = fields[index]!;
    const firstTab = entry.indexOf("\t");
    const secondTab = entry.indexOf("\t", firstTab + 1);
    if (firstTab < 0 || secondTab < 0)
      throw new Error("Candidate patch produced invalid file metadata.");
    const path = entry.slice(secondTab + 1);
    if (path) files.push(path);
    else {
      // Git's -z rename/copy form stores old and new paths as the next two fields.
      const previousPath = fields[index + 1];
      const nextPath = fields[index + 2];
      if (previousPath === undefined || nextPath === undefined || !previousPath || !nextPath)
        throw new Error("Candidate patch produced invalid rename or copy metadata.");
      files.push(nextPath);
      index += 2;
    }
  }
  if (
    files.length !== candidate.files.length ||
    files.some((file, index) => file !== candidate.files[index])
  )
    throw new Error("Candidate files metadata does not match its exact patch bytes.");
}

function decodeBoundedOutput(
  value: Buffer,
  maxBytes: number,
): { text: string; truncated: boolean } {
  const decoded = value.toString("utf8");
  const encoded = Buffer.from(decoded, "utf8");
  if (encoded.length <= maxBytes) return { text: decoded, truncated: false };
  let end = maxBytes;
  while (end > 0 && encoded[end] !== undefined && (encoded[end]! & 0xc0) === 0x80) end -= 1;
  return { text: encoded.subarray(0, end).toString("utf8"), truncated: true };
}

function outcomeFor(result: ProcessResult): ValidationOutcome {
  if (result.reason === "timeout") return "timeout";
  if (result.reason === "aborted") return "aborted";
  if (result.reason === "overflow") return "output-overflow";
  if (result.reason === "spawn") return "spawn-failure";
  return result.code === 0 ? "passed" : "failed";
}

export async function runPatchValidator(input: ValidationRunnerInput): Promise<ValidationRecord> {
  if (input.candidate.baseCommit !== input.worktree.baseCommit)
    throw new Error("Candidate base commit is inconsistent with its original worktree.");
  const patchBytes = validateWorktreeCandidate(input.candidate);
  await validateCandidatePatchFiles(
    input.worktree.sourceRoot,
    input.candidate,
    patchBytes,
    input.signal,
  );
  const candidateId = input.candidate.candidateId;
  const root = resolve(
    input.workspaceRoot ?? tmpdir(),
    `pi-validator-${candidateId.slice(0, 12)}-${randomBytes(6).toString("hex")}`,
  );
  const record: ValidationRecord = {
    id: `validation-${candidateId.slice(0, 16)}-${randomBytes(8).toString("hex")}`,
    target: { ...input.target },
    candidateId,
    validator: input.validatorName,
    status: "preparing",
    preparedAt: iso(),
    output: "",
    outputBytes: 0,
    outputLimitBytes: input.validator.maxOutputBytes,
    outputTruncated: false,
    cleanup: "pending",
    terminationProven: false,
    intendedPath: root,
    sourceRoot: input.worktree.sourceRoot,
    baseCommit: input.worktree.baseCommit,
  };
  await input.onPreparing?.({ ...record, target: { ...record.target } });
  const validationWorktree: MissionWorktree = {
    missionId: record.id,
    root,
    cwd: root,
    baseCommit: input.worktree.baseCommit,
    sourceRoot: input.worktree.sourceRoot,
  };
  let created = false;
  let processTerminationProven = true;
  try {
    if (!pathWithin(input.worktree.root, input.worktree.cwd))
      throw new Error("Candidate cwd is outside its original worktree.");
    const cwdRelative = relative(resolve(input.worktree.root), resolve(input.worktree.cwd));
    validationWorktree.cwd = cwdRelative ? join(root, cwdRelative) : root;
    await fs.mkdir(input.workspaceRoot ?? tmpdir(), { recursive: true });
    await git(
      input.worktree.sourceRoot,
      ["worktree", "add", "--detach", root, input.worktree.baseCommit],
      { signal: input.signal },
    );
    created = true;
    if (input.candidate.hasChanges) {
      await git(root, ["apply", "--binary", "--whitespace=nowarn", "-"], {
        input: patchBytes,
        signal: input.signal,
      });
    }
    const [realRoot, realCwd, cwdStat] = await Promise.all([
      fs.realpath(root),
      fs.realpath(validationWorktree.cwd),
      fs.stat(validationWorktree.cwd),
    ]);
    if (!cwdStat.isDirectory() || !pathWithin(realRoot, realCwd))
      throw new Error("Candidate cwd is not a real directory inside the disposable worktree.");
    validationWorktree.root = realRoot;
    validationWorktree.cwd = realCwd;
    record.status = "running";
    record.startedAt = iso();
    await input.onRunning?.({ ...record, target: { ...record.target } });
    const result = await execute(input.validator.command, [...input.validator.args], {
      cwd: validationWorktree.cwd,
      timeoutMs: input.validator.timeoutMs,
      maxOutputBytes: input.validator.maxOutputBytes,
      signal: input.signal,
      capture: true,
    });
    processTerminationProven = result.terminationProven;
    record.terminationProven = result.terminationProven;
    record.outcome = outcomeFor(result);
    record.status = record.outcome === "aborted" ? "interrupted" : "completed";
    record.exitCode = result.code;
    record.signal = result.signal;
    const retainedOutput = decodeBoundedOutput(result.output, input.validator.maxOutputBytes);
    record.output = retainedOutput.text;
    record.outputBytes = result.output.length;
    record.outputTruncated = result.overflow || retainedOutput.truncated;
    record.error = result.error;
  } catch (cause) {
    if (cause instanceof ProcessFailure) processTerminationProven &&= cause.terminationProven;
    record.status = input.signal?.aborted ? "interrupted" : "completed";
    record.outcome = input.signal?.aborted ? "aborted" : "preparation-failure";
    record.error = errorText(cause);
  } finally {
    const finished = Date.now();
    record.finishedAt = new Date(finished).toISOString();
    record.durationMs = Math.max(0, finished - Date.parse(record.startedAt ?? record.preparedAt));
    record.terminationProven = processTerminationProven;
    let removed = false;
    try {
      if (processTerminationProven) {
        const workspaceExists = await exists(root);
        const cleanup =
          !created && !workspaceExists
            ? { removed: true }
            : await (input.cleanupWorkspace ?? removeWorkspace)(validationWorktree);
        const reconciled = await reconcileCleanup(validationWorktree, cleanup);
        removed = reconciled.removed;
        record.cleanupError = reconciled.error;
      } else record.cleanupError = "Owned validator process termination could not be proven.";
    } catch (cause) {
      record.cleanupError = `Workspace cleanup failed: ${errorText(cause)}`;
      removed = false;
    }
    record.cleanup = removed ? "removed" : "retained";
    if (!removed) record.retainedPath = root;
  }
  return record;
}

export function validationSummary(record: ValidationRecord): string {
  const result = record.outcome ?? record.status;
  const exit = record.exitCode === undefined ? "" : `, exit ${record.exitCode}`;
  const termination = record.terminationProven ? "" : "; process termination unproven";
  const retained =
    record.cleanup === "retained" ? `; workspace retained at ${record.retainedPath}` : "";
  const cleanup = record.cleanupError ? `; cleanup: ${record.cleanupError}` : "";
  const output = record.output.trim();
  const summary = `${record.validator}: ${result}${exit}; ${record.outputBytes}/${record.outputLimitBytes} output bytes${termination}${retained}${cleanup}${output ? `\n${output}` : ""}`;
  return summary.length > 4_000 ? `${summary.slice(0, 4_000)}\n… summary truncated` : summary;
}
