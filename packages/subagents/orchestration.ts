import { posix } from "node:path";

export type DispatchContextMode = "fresh" | "decisions" | "plan";
export type DispatchWorkspace = "shared" | "worktree";
export type ClaimKind = "read" | "write";

export type DispatchTask = {
  key: string;
  agent: string;
  task: string;
  owns: string[];
  deliverable: string;
  context?: DispatchContextMode;
  workspace?: DispatchWorkspace;
};

export type ActiveTaskClaim = {
  runId: string;
  key: string;
  agent: string;
  kind: ClaimKind;
  owns: string[];
  taskFingerprint: string;
  workspace: DispatchWorkspace;
};

export type DispatchValidationOptions = {
  kinds: ReadonlyMap<string, ClaimKind>;
  existing?: readonly ActiveTaskClaim[];
  maxSharedWriters?: number;
};

const KEY_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/u;

function normalizedText(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, " ")
    .trim()
    .replace(/\s+/gu, " ");
}

export function taskFingerprint(task: string): string {
  return normalizedText(task);
}

export type NormalizedOwnership = {
  kind: "path" | "symbol" | "topic";
  value: string;
};

export function normalizeOwnership(raw: string): NormalizedOwnership {
  const trimmed = raw.normalize("NFKC").trim();
  if (!trimmed) throw new Error("Ownership entries must not be empty.");
  const marker = /^(path|symbol|topic):\s*(.+)$/iu.exec(trimmed);
  const kind = (marker?.[1]?.toLowerCase() ?? "path") as NormalizedOwnership["kind"];
  const source = marker?.[2] ?? trimmed;
  if (kind === "path") {
    const slashes = source.replaceAll("\\", "/").replace(/^\.\//u, "");
    const value = posix.normalize(slashes).replace(/^\/+|\/+$/gu, "");
    if (!value || value === "." || value === ".." || value.startsWith("../"))
      throw new Error(`Invalid owned path: ${raw}`);
    return { kind, value };
  }
  const value = normalizedText(source);
  if (!value) throw new Error(`Invalid owned ${kind}: ${raw}`);
  return { kind, value };
}

function ownershipOverlaps(leftRaw: string, rightRaw: string): boolean {
  const left = normalizeOwnership(leftRaw);
  const right = normalizeOwnership(rightRaw);
  if (left.kind !== right.kind) return false;
  if (left.kind !== "path") return left.value === right.value;
  return (
    left.value === right.value ||
    left.value.startsWith(`${right.value}/`) ||
    right.value.startsWith(`${left.value}/`)
  );
}

export function findOwnershipOverlap(
  left: readonly string[],
  right: readonly string[],
): { left: string; right: string } | undefined {
  for (const leftEntry of left)
    for (const rightEntry of right)
      if (ownershipOverlaps(leftEntry, rightEntry)) return { left: leftEntry, right: rightEntry };
  return undefined;
}

function validateTaskShape(task: DispatchTask): void {
  if (!KEY_PATTERN.test(task.key))
    throw new Error(
      `Task key ${JSON.stringify(task.key)} must match ${KEY_PATTERN.source} and be at most 64 characters.`,
    );
  if (!task.agent.trim()) throw new Error(`Task ${task.key} must select an agent profile.`);
  if (!task.task.trim()) throw new Error(`Task ${task.key} must include a self-contained task.`);
  if (!task.deliverable.trim()) throw new Error(`Task ${task.key} must state its deliverable.`);
  if (!task.owns.length) throw new Error(`Task ${task.key} must declare at least one owned scope.`);
  for (const ownership of task.owns) normalizeOwnership(ownership);
}

/**
 * Validate one parallel dispatch before any session or worktree is allocated.
 * Read-only scopes may overlap when their tasks differ; write scopes may never overlap.
 */
export function validateDispatchBatch(
  tasks: readonly DispatchTask[],
  options: DispatchValidationOptions,
): void {
  if (!tasks.length) throw new Error("Dispatch requires at least one task.");
  const existing = options.existing ?? [];
  const keys = new Set<string>();
  const fingerprints = new Map<string, string>();
  const pendingClaims: ActiveTaskClaim[] = [];

  for (const task of tasks) {
    validateTaskShape(task);
    if (keys.has(task.key)) throw new Error(`Duplicate task key: ${task.key}.`);
    keys.add(task.key);
    const kind = options.kinds.get(task.agent);
    if (!kind) throw new Error(`Unknown or disabled agent profile: ${task.agent}.`);
    const fingerprint = taskFingerprint(task.task);
    const duplicateKey = fingerprints.get(fingerprint);
    if (duplicateKey)
      throw new Error(`Tasks ${duplicateKey} and ${task.key} describe the same normalized work.`);
    fingerprints.set(fingerprint, task.key);
    if (existing.some((claim) => claim.taskFingerprint === fingerprint))
      throw new Error(`Task ${task.key} duplicates work already owned by an active subagent.`);
    pendingClaims.push({
      runId: "pending",
      key: task.key,
      agent: task.agent,
      kind,
      owns: [...task.owns],
      taskFingerprint: fingerprint,
      workspace: task.workspace ?? "shared",
    });
  }

  const combined = [...existing, ...pendingClaims];
  for (let index = 0; index < combined.length; index++) {
    const left = combined[index]!;
    if (left.kind !== "write") continue;
    for (let otherIndex = index + 1; otherIndex < combined.length; otherIndex++) {
      const right = combined[otherIndex]!;
      if (right.kind !== "write") continue;
      const overlap = findOwnershipOverlap(left.owns, right.owns);
      if (overlap)
        throw new Error(
          `Writer scope overlap between ${left.key} (${overlap.left}) and ${right.key} (${overlap.right}).`,
        );
    }
  }

  const sharedWriters = combined.filter(
    (claim) => claim.kind === "write" && claim.workspace === "shared",
  );
  const maximum = Math.max(0, options.maxSharedWriters ?? 1);
  if (sharedWriters.length > maximum)
    throw new Error(
      `At most ${maximum} shared-tree writer${maximum === 1 ? "" : "s"} may run at once; use disjoint worktrees for parallel writers.`,
    );
}

export class TaskClaimRegistry {
  private readonly claims = new Map<string, ActiveTaskClaim>();

  all(): ActiveTaskClaim[] {
    return [...this.claims.values()].map((claim) => ({ ...claim, owns: [...claim.owns] }));
  }

  forRun(runId: string): ActiveTaskClaim | undefined {
    const claim = this.claims.get(runId);
    return claim ? { ...claim, owns: [...claim.owns] } : undefined;
  }

  reserve(runId: string, task: DispatchTask, kind: ClaimKind): ActiveTaskClaim {
    if (this.claims.has(runId)) throw new Error(`Run ${runId} already owns a task claim.`);
    const claim: ActiveTaskClaim = {
      runId,
      key: task.key,
      agent: task.agent,
      kind,
      owns: [...task.owns],
      taskFingerprint: taskFingerprint(task.task),
      workspace: task.workspace ?? "shared",
    };
    this.claims.set(runId, claim);
    return { ...claim, owns: [...claim.owns] };
  }

  release(runId: string): void {
    this.claims.delete(runId);
  }

  clear(): void {
    this.claims.clear();
  }
}

export const ORCHESTRATION_GUIDELINES = `Use subagents for substantial independent slices or specialist work, not for trivial or tightly sequential steps.
Before dispatching, enumerate the ready work and assign one owner to each path, symbol, or research angle.
Dispatch all independent ready tasks in one subagent_dispatch call. Give every task a self-contained brief, explicit ownership, and a concrete deliverable.
Do not work on an active delegated scope in the parent. Continue only with unowned work while children run.
Never assign overlapping writer scopes. Use one shared-tree writer, or explicit disjoint worktrees when parallel writers are justified.
Require evidence and local validation from every child. The parent remains responsible for reviewing reports and running final integrated checks.`;
