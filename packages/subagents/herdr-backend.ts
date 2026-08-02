import type { SubagentBackend } from "./backend.js";
import type { HerdrClient } from "./herdr-client.js";
import type { ManagedAgent } from "./types.js";

/** Herdr transport: panes are visible, while SessionPoller remains completion authority. */
export class HerdrBackend implements SubagentBackend {
  private readonly panes: string[] = [];
  private readonly watchGenerations = new Map<string, number>();
  private readonly retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private spawnTail: Promise<void> = Promise.resolve();
  private verified = false;

  constructor(
    private readonly client: HerdrClient,
    private readonly parentPaneId: string,
    private readonly cwd: string,
    private readonly childEnvironment: (agent: ManagedAgent) => Record<string, string>,
    private readonly childArgs: (agent: ManagedAgent) => string[],
    private readonly onReady: (agent: ManagedAgent) => void,
    private readonly onError: (agent: ManagedAgent, error: Error) => void,
    private readonly onWatchWarning: (agent: ManagedAgent, error: Error) => void = () => {},
  ) {}

  spawn(agent: ManagedAgent, task: string): Promise<void> {
    const operation = this.spawnTail.then(
      () => this.spawnNow(agent, task),
      () => this.spawnNow(agent, task),
    );
    this.spawnTail = operation.catch(() => {});
    return operation;
  }

  private async spawnNow(agent: ManagedAgent, task: string): Promise<void> {
    let pane: string | undefined;
    try {
      if (!this.verified) {
        await this.client.verify(this.parentPaneId);
        this.verified = true;
      }
      // First child uses the right half. Subsequent children extend a stable owned vertical strip.
      // Serializing topology changes keeps concurrent tool calls from racing on the same anchor.
      const anchor =
        this.panes.length === 0 ? this.parentPaneId : this.panes[this.panes.length - 1]!;
      const direction = this.panes.length === 0 ? "right" : "down";
      pane = await this.client.split(anchor, direction, this.cwd, this.childEnvironment(agent));
      agent.herdrPaneId = pane;
      this.panes.push(pane);
      await this.client.start(agent.id, pane, this.childArgs(agent));
      await this.client.prompt(pane, task);
      this.watch(agent);
    } catch (cause) {
      if (pane) {
        const index = this.panes.indexOf(pane);
        if (index >= 0) this.panes.splice(index, 1);
        if (agent.herdrPaneId === pane) agent.herdrPaneId = undefined;
        try {
          await this.client.close(pane);
        } catch {
          /* Failed startup cleanup is best-effort. */
        }
      }
      this.onError(agent, cause instanceof Error ? cause : new Error(String(cause)));
      throw cause;
    }
  }

  async send(agent: ManagedAgent, message: string): Promise<void> {
    if (!agent.herdrPaneId) throw new Error("Herdr subagent pane was not created.");
    await this.client.prompt(agent.herdrPaneId, message);
    this.watch(agent);
  }

  async interrupt(agent: ManagedAgent): Promise<void> {
    if (!agent.herdrPaneId) throw new Error("Herdr subagent pane was not created.");
    await this.client.interrupt(agent.herdrPaneId);
  }

  async redirect(agent: ManagedAgent, message: string): Promise<void> {
    if (!agent.herdrPaneId) throw new Error("Herdr subagent pane was not created.");
    await this.client.interrupt(agent.herdrPaneId);
    await this.client.wait(agent.herdrPaneId, 30_000);
    await this.send(agent, message);
  }

  /** Re-arm observation after a stale idle/done signal without treating it as child completion. */
  observe(agent: ManagedAgent): void {
    const generation = (this.watchGenerations.get(agent.id) ?? 0) + 1;
    this.watchGenerations.set(agent.id, generation);
    // Working is a short-lived state and may be missed; observe terminal lifecycle directly.
    void this.watchTurn(agent, generation);
  }

  stopObserving(agent: ManagedAgent): void {
    const retry = this.retryTimers.get(agent.id);
    if (retry) clearTimeout(retry);
    this.retryTimers.delete(agent.id);
    this.watchGenerations.set(agent.id, (this.watchGenerations.get(agent.id) ?? 0) + 1);
  }

  async shutdown(agent: ManagedAgent): Promise<void> {
    this.stopObserving(agent);
    if (!agent.herdrPaneId) return;
    try {
      await this.client.interrupt(agent.herdrPaneId);
    } catch {
      /* Pane may already be gone. */
    }
    try {
      await this.client.close(agent.herdrPaneId);
    } catch {
      /* Session shutdown is best-effort. */
    }
  }

  private async awaitWorkingThenWatch(agent: ManagedAgent, generation: number): Promise<void> {
    if (
      !agent.herdrPaneId ||
      agent.status !== "running" ||
      this.watchGenerations.get(agent.id) !== generation
    )
      return;
    try {
      await this.client.waitForWorking(agent.herdrPaneId);
      if (agent.status === "running" && this.watchGenerations.get(agent.id) === generation)
        this.watch(agent);
    } catch (cause) {
      if (agent.status !== "running" || this.watchGenerations.get(agent.id) !== generation) return;
      const error = cause instanceof Error ? cause : new Error(String(cause));
      this.onWatchWarning(agent, error);
      this.scheduleRetry(agent, generation, () => this.awaitWorkingThenWatch(agent, generation));
    }
  }

  private watch(agent: ManagedAgent): void {
    const generation = (this.watchGenerations.get(agent.id) ?? 0) + 1;
    this.watchGenerations.set(agent.id, generation);
    void this.watchTurn(agent, generation);
  }

  private scheduleRetry(agent: ManagedAgent, generation: number, retry: () => Promise<void>): void {
    const previous = this.retryTimers.get(agent.id);
    if (previous) clearTimeout(previous);
    const timer = setTimeout(() => {
      this.retryTimers.delete(agent.id);
      if (agent.status === "running" && this.watchGenerations.get(agent.id) === generation)
        void retry();
    }, 1_000);
    this.retryTimers.set(agent.id, timer);
  }

  private async watchTurn(agent: ManagedAgent, generation: number): Promise<void> {
    if (
      !agent.herdrPaneId ||
      agent.status !== "running" ||
      this.watchGenerations.get(agent.id) !== generation
    )
      return;
    try {
      await this.client.wait(agent.herdrPaneId);
      if (agent.status === "running" && this.watchGenerations.get(agent.id) === generation)
        this.onReady(agent);
    } catch (cause) {
      if (agent.status !== "running" || this.watchGenerations.get(agent.id) !== generation) return;
      const error = cause instanceof Error ? cause : new Error(String(cause));
      // `agent wait` is an observation call, not child-process completion evidence. A transient
      // Herdr status failure must not mark a still-running Pi child as failed.
      this.onWatchWarning(agent, error);
      this.scheduleRetry(agent, generation, () => this.watchTurn(agent, generation));
    }
  }
}
