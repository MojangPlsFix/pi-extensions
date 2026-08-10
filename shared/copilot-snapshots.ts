import {
  type FileHandle,
  mkdir,
  open,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export type CopilotSnapshotUnit = "ai_credits" | "premium_requests";

export type CopilotCreditSnapshot = {
  date: string;
  capturedAt: string;
  used: number;
  remaining: number;
  total: number;
  unit: CopilotSnapshotUnit;
  resetDate?: string;
};

export type CopilotQuotaSnapshotInput = {
  remaining: number;
  total?: number;
  unlimited: boolean;
  percentRemaining?: number;
  unit: CopilotSnapshotUnit;
  resetDate?: string;
};

type CopilotSnapshotStore = {
  version: number;
  snapshots: CopilotCreditSnapshot[];
};

const COPILOT_SNAPSHOT_FILE = "copilot-credit-snapshots.json";
const COPILOT_SNAPSHOT_VERSION = 1;
const COPILOT_SNAPSHOT_LOCK_MAX_AGE_MS = 60_000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));

const number = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value)
    ? value
    : typeof value === "string" && value.trim() && Number.isFinite(Number(value))
      ? Number(value)
      : 0;

export const dayKey = (date: Date): string =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;

export function agentDirectory(env: NodeJS.ProcessEnv = process.env): string {
  return (
    env.PI_CODING_AGENT_DIR?.trim()?.replace(/^~(?=$|[\\/])/, homedir()) ||
    join(homedir(), ".pi", "agent")
  );
}

export function copilotSnapshotPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(agentDirectory(env), COPILOT_SNAPSHOT_FILE);
}

function isCopilotCreditSnapshot(value: unknown): value is CopilotCreditSnapshot {
  if (!isRecord(value)) return false;
  return (
    typeof value.date === "string" &&
    typeof value.capturedAt === "string" &&
    Number.isFinite(value.used) &&
    Number.isFinite(value.remaining) &&
    Number.isFinite(value.total) &&
    (value.unit === "ai_credits" || value.unit === "premium_requests")
  );
}

async function readCopilotSnapshotStore(
  env: NodeJS.ProcessEnv = process.env,
): Promise<CopilotSnapshotStore> {
  try {
    const parsed = JSON.parse(await readFile(copilotSnapshotPath(env), "utf8")) as unknown;
    if (!isRecord(parsed) || !Array.isArray(parsed.snapshots)) {
      return { version: COPILOT_SNAPSHOT_VERSION, snapshots: [] };
    }
    const snapshots = parsed.snapshots.filter(isCopilotCreditSnapshot);
    const byDate = new Map(snapshots.map((snapshot) => [snapshot.date, snapshot]));
    return {
      version: number(parsed.version) || COPILOT_SNAPSHOT_VERSION,
      snapshots: [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date)),
    };
  } catch {
    return { version: COPILOT_SNAPSHOT_VERSION, snapshots: [] };
  }
}

async function withCopilotSnapshotLock<T>(
  env: NodeJS.ProcessEnv,
  action: () => Promise<T>,
): Promise<T | undefined> {
  const path = copilotSnapshotPath(env);
  const lockPath = `${path}.lock`;
  await mkdir(agentDirectory(env), { recursive: true });

  let handle: FileHandle | undefined;
  try {
    handle = await open(lockPath, "wx");
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      try {
        const lockAge = Date.now() - (await stat(lockPath)).mtimeMs;
        if (lockAge > COPILOT_SNAPSHOT_LOCK_MAX_AGE_MS) {
          await unlink(lockPath);
          handle = await open(lockPath, "wx");
        }
      } catch {
        return undefined;
      }
    }
    if (!handle) return undefined;
  }

  try {
    return await action();
  } finally {
    await handle.close().catch(() => {});
    await unlink(lockPath).catch(() => {});
  }
}

function quotaTotal(quota: CopilotQuotaSnapshotInput): number {
  if (typeof quota.total === "number" && Number.isFinite(quota.total) && quota.total > 0)
    return quota.total;
  if (
    typeof quota.percentRemaining === "number" &&
    Number.isFinite(quota.percentRemaining) &&
    quota.percentRemaining > 0
  )
    return quota.remaining / (quota.percentRemaining / 100);
  return 0;
}

/**
 * Store one account-level Copilot quota checkpoint for the local day.
 *
 * The file contains no credentials or raw provider data. A second checkpoint
 * for the same local day is ignored so that startup and footer refreshes do
 * not create duplicate baselines.
 */
export async function recordCopilotSnapshot(
  quota: CopilotQuotaSnapshotInput,
  env: NodeJS.ProcessEnv = process.env,
  now = new Date(),
): Promise<void> {
  const date = dayKey(now);
  try {
    await withCopilotSnapshotLock(env, async () => {
      const store = await readCopilotSnapshotStore(env);
      if (store.snapshots.some((entry) => entry.date === date)) return;

      const total = quotaTotal(quota);
      if (
        quota.unlimited ||
        !Number.isFinite(total) ||
        total <= 0 ||
        !Number.isFinite(quota.remaining)
      )
        return;

      const snapshot: CopilotCreditSnapshot = {
        date,
        capturedAt: new Date().toISOString(),
        used: Math.max(0, total - quota.remaining),
        remaining: quota.remaining,
        total,
        unit: quota.unit,
        ...(quota.resetDate ? { resetDate: quota.resetDate } : {}),
      };
      store.snapshots.push(snapshot);
      store.snapshots.sort((a, b) => a.date.localeCompare(b.date));
      const path = copilotSnapshotPath(env);
      const temporaryPath = `${path}.${process.pid}.tmp`;
      await writeFile(
        temporaryPath,
        `${JSON.stringify({ ...store, version: COPILOT_SNAPSHOT_VERSION }, null, 2)}\n`,
        "utf8",
      );
      await rename(temporaryPath, path);
    });
  } catch {
    /* Copilot quota history is optional and never blocks Pi. */
  }
}

export async function captureCopilotSnapshot(
  fetchQuota: () => Promise<CopilotQuotaSnapshotInput | undefined>,
  env: NodeJS.ProcessEnv = process.env,
  now = new Date(),
): Promise<void> {
  try {
    await withCopilotSnapshotLock(env, async () => {
      const store = await readCopilotSnapshotStore(env);
      if (store.snapshots.some((entry) => entry.date === dayKey(now))) return;
      const quota = await fetchQuota();
      if (!quota) return;
      // The lock is already held. Record the exact fetched value without
      // taking the same lock again.
      const total = quotaTotal(quota);
      if (
        quota.unlimited ||
        !Number.isFinite(total) ||
        total <= 0 ||
        !Number.isFinite(quota.remaining)
      )
        return;
      const snapshot: CopilotCreditSnapshot = {
        date: dayKey(now),
        capturedAt: new Date().toISOString(),
        used: Math.max(0, total - quota.remaining),
        remaining: quota.remaining,
        total,
        unit: quota.unit,
        ...(quota.resetDate ? { resetDate: quota.resetDate } : {}),
      };
      store.snapshots.push(snapshot);
      store.snapshots.sort((a, b) => a.date.localeCompare(b.date));
      const path = copilotSnapshotPath(env);
      const temporaryPath = `${path}.${process.pid}.tmp`;
      await writeFile(
        temporaryPath,
        `${JSON.stringify({ ...store, version: COPILOT_SNAPSHOT_VERSION }, null, 2)}\n`,
        "utf8",
      );
      await rename(temporaryPath, path);
    });
  } catch {
    /* Copilot quota history is optional and never blocks Pi. */
  }
}

export async function loadCopilotSnapshots(
  env: NodeJS.ProcessEnv = process.env,
): Promise<CopilotCreditSnapshot[]> {
  return (await readCopilotSnapshotStore(env)).snapshots;
}

export async function loadCopilotSnapshotsInRange(
  range: { start: Date; end: Date },
  env: NodeJS.ProcessEnv = process.env,
): Promise<CopilotCreditSnapshot[]> {
  const snapshots = await loadCopilotSnapshots(env);
  const startKey = dayKey(range.start);
  const endKey = dayKey(range.end);
  return snapshots.filter((entry) => entry.date >= startKey && entry.date < endKey);
}
