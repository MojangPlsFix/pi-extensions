import { type RunRecord, type RunSnapshot, type RunSummary, runSnapshot } from "./types.js";

const ACTIVE = new Set<RunRecord["status"]>(["queued", "starting", "running", "blocked"]);

export class RunStore {
  private readonly records = new Map<string, RunRecord>();
  private readonly listeners = new Set<(runs: RunSnapshot[]) => void>();

  add(run: RunRecord): void {
    if (this.records.has(run.id)) throw new Error(`Run ${run.id} already exists.`);
    this.records.set(run.id, run);
    this.publish();
  }

  get(id: string): RunRecord | undefined {
    return this.records.get(id);
  }

  all(): RunRecord[] {
    return [...this.records.values()];
  }

  snapshots(): RunSnapshot[] {
    return this.all().map((run) => runSnapshot(run));
  }

  active(): RunRecord[] {
    return this.all().filter((run) => ACTIVE.has(run.status));
  }

  children(parentId: string): RunRecord[] {
    return this.all().filter((run) => run.parentId === parentId);
  }

  summary(): RunSummary {
    const all = this.all();
    return {
      active: all.filter((run) => ACTIVE.has(run.status)).length,
      blocked: all.filter((run) => run.status === "blocked").length,
      parked: all.filter((run) => run.status === "parked").length,
      failed: all.filter((run) => run.status === "failed").length,
      writers: all.filter((run) => ACTIVE.has(run.status) && run.profile.class === "write").length,
      total: all.length,
    };
  }

  prune(policy: { days: number; entries: number }, now = Date.now()): RunRecord[] {
    const cutoff = now - policy.days * 24 * 60 * 60 * 1_000;
    const terminal = this.all()
      .filter((run) => !ACTIVE.has(run.status))
      .sort(
        (left, right) =>
          Date.parse(right.finishedAt ?? right.startedAt) -
          Date.parse(left.finishedAt ?? left.startedAt),
      );
    const retained = new Set(
      terminal
        .filter((run) => Date.parse(run.finishedAt ?? run.startedAt) >= cutoff)
        .slice(0, policy.entries)
        .map((run) => run.id),
    );
    const removed = terminal.filter((run) => !retained.has(run.id));
    for (const run of removed) this.records.delete(run.id);
    if (removed.length) this.publish();
    return removed;
  }

  changed(): void {
    this.publish();
  }

  clear(): RunRecord[] {
    const removed = this.all();
    this.records.clear();
    if (removed.length) this.publish();
    return removed;
  }

  subscribe(listener: (runs: RunSnapshot[]) => void): () => void {
    this.listeners.add(listener);
    listener(this.snapshots());
    return () => this.listeners.delete(listener);
  }

  private publish(): void {
    const snapshot = this.snapshots();
    for (const listener of this.listeners) listener(snapshot);
  }
}
