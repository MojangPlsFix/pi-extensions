import { basename } from "node:path";
import type { SubagentBackend } from "./backend.js";
import {
  type HerdrClient,
  type HerdrPaneLayout,
  type HerdrPaneRect,
  isHerdrLayoutUnavailable,
  isMissingHerdrPane,
} from "./herdr-client.js";
import type { ManagedAgent } from "./types.js";

const MAX_OWNED_PANES = 4;
const TASK_TITLE_WIDTH = 48;
const TOKEN_WIDTH = 48;
const ANSI_ESCAPE = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\)?)/gu;
const CONTROL = /[\p{Cc}\p{Cf}]/gu;
const COMBINING = /\p{Mark}/u;
const EMOJI = /\p{Extended_Pictographic}/u;

function wideCodePoint(codePoint: number): boolean {
  return (
    codePoint >= 0x1100 &&
    (codePoint <= 0x115f ||
      codePoint === 0x2329 ||
      codePoint === 0x232a ||
      (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f) ||
      (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
      (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
      (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
      (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
      (codePoint >= 0xff00 && codePoint <= 0xff60) ||
      (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
      (codePoint >= 0x1f300 && codePoint <= 0x1faff) ||
      (codePoint >= 0x20000 && codePoint <= 0x3fffd))
  );
}

function graphemeWidth(value: string): number {
  if (EMOJI.test(value)) return 2;
  let width = 0;
  for (const character of value) {
    if (COMBINING.test(character)) continue;
    width = Math.max(width, wideCodePoint(character.codePointAt(0) ?? 0) ? 2 : 1);
  }
  return width;
}

function graphemes(value: string): string[] {
  const Segmenter = Intl.Segmenter;
  if (!Segmenter) return [...value];
  return [...new Segmenter(undefined, { granularity: "grapheme" }).segment(value)].map(
    (part) => part.segment,
  );
}

/** Bounds terminal display width rather than UTF-16 length. */
export function boundedDisplayText(value: string, maximumWidth: number): string {
  if (maximumWidth <= 0) return "";
  const parts = graphemes(value);
  let width = 0;
  let end = 0;
  for (; end < parts.length; end++) {
    const next = graphemeWidth(parts[end]!);
    if (width + next > maximumWidth) break;
    width += next;
  }
  if (end === parts.length) return value;
  while (end > 0 && width + 1 > maximumWidth) {
    end -= 1;
    width -= graphemeWidth(parts[end]!);
  }
  return `${parts.slice(0, end).join("")}…`;
}

function cleanLine(value: string): string {
  return value.replace(ANSI_ESCAPE, "").replace(/\s+/gu, " ").replace(CONTROL, "").trim();
}

/** A pane title is deliberately a short label, never the submitted prompt. */
export function taskPaneTitle(task: string): string {
  const firstMeaningful =
    task
      .split(/\r\n|[\n\r\u2028\u2029]/u)
      .map(cleanLine)
      .find(Boolean) ?? "Task";
  return boundedDisplayText(firstMeaningful, TASK_TITLE_WIDTH);
}

function token(value: string | undefined, fallback: string): string {
  return boundedDisplayText(cleanLine(value ?? "") || fallback, TOKEN_WIDTH);
}

function area(rect: HerdrPaneRect): number {
  return Math.max(0, rect.width) * Math.max(0, rect.height);
}

/** Herdr transport: panes are visible, while SessionPoller remains completion authority. */
export class HerdrBackend implements SubagentBackend {
  private readonly panes = new Map<string, ManagedAgent>();
  private readonly metadataSequences = new Map<string, number>();
  private readonly watchGenerations = new Map<string, number>();
  private readonly retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private topologyTail: Promise<void> = Promise.resolve();
  private verified = false;
  private tabId?: string;
  private warnedAboutLayout = false;
  private warnedAboutMetadata = false;

  constructor(
    private readonly client: HerdrClient,
    private readonly parentPaneId: string,
    private readonly cwd: string,
    private readonly childEnvironment: (agent: ManagedAgent) => Record<string, string>,
    private readonly childArgs: (agent: ManagedAgent) => string[],
    private readonly onReady: (agent: ManagedAgent) => void,
    private readonly onError: (agent: ManagedAgent, error: Error) => void,
    private readonly onWatchWarning: (agent: ManagedAgent, error: Error) => void = () => {},
    private readonly onCapabilityWarning: (error: Error) => void = () => {},
    initiallyVerified = false,
  ) {
    this.verified = initiallyVerified;
  }

  private topology(operation: () => Promise<void>): Promise<void> {
    const queued = this.topologyTail.then(operation, operation);
    this.topologyTail = queued.catch(() => {});
    return queued;
  }

  spawn(agent: ManagedAgent, task: string): Promise<void> {
    return this.topology(() => this.spawnNow(agent, task));
  }

  private async spawnNow(agent: ManagedAgent, task: string): Promise<void> {
    let pane: string | undefined;
    try {
      if (!this.verified) {
        await this.client.verify(this.parentPaneId);
        this.verified = true;
      }

      if (this.panes.size === 0) {
        const project = basename(this.cwd) || "project";
        const tab = await this.client.createTab(
          `Subagents · ${project}`,
          this.cwd,
          this.childEnvironment(agent),
        );
        this.tabId = tab.tabId;
        agent.herdrTabId = tab.tabId;
        pane = tab.paneId;
      } else {
        const selected = await this.selectSplit();
        if (!selected) {
          const project = basename(this.cwd) || "project";
          const tab = await this.client.createTab(
            `Subagents · ${project}`,
            this.cwd,
            this.childEnvironment(agent),
          );
          this.tabId = tab.tabId;
          agent.herdrTabId = tab.tabId;
          pane = tab.paneId;
        } else {
          if (this.panes.size >= MAX_OWNED_PANES)
            throw new Error(`At most ${MAX_OWNED_PANES} Herdr subagent panes may be owned.`);
          pane = await this.client.split(
            selected.pane,
            selected.direction,
            this.cwd,
            this.childEnvironment(agent),
          );
        }
      }

      agent.herdrPaneId = pane;
      agent.herdrTabId = this.tabId;
      this.panes.set(pane, agent);
      await this.client.start(agent.id, pane, this.childArgs(agent));
      await this.updateMetadata(agent, task);
      await this.client.prompt(pane, task);
      this.watch(agent);
    } catch (cause) {
      let error = cause instanceof Error ? cause : new Error(String(cause));
      if (pane)
        try {
          await this.cleanupFailedPane(agent, pane);
        } catch (cleanupCause) {
          error = new Error(
            `${error.message}; Herdr startup cleanup failed: ${cleanupCause instanceof Error ? cleanupCause.message : String(cleanupCause)}`,
          );
        }
      this.onError(agent, error);
      throw error;
    }
  }

  private async cleanupFailedPane(_agent: ManagedAgent, pane: string): Promise<void> {
    const wasOnlyPane = this.panes.size === 1 && this.panes.has(pane);
    try {
      if (wasOnlyPane && this.tabId) {
        await this.client.closeTab(this.tabId);
        this.releasePane(pane);
        this.tabId = undefined;
      } else {
        await this.client.close(pane);
        this.releasePane(pane);
        await this.refreshAfterClosure();
      }
    } catch (cause) {
      if (isMissingHerdrPane(cause)) {
        this.releasePane(pane);
        if (wasOnlyPane) this.tabId = undefined;
        return;
      }
      throw cause;
    }
  }

  private warnLayout(error: Error): void {
    if (this.warnedAboutLayout) return;
    this.warnedAboutLayout = true;
    this.onCapabilityWarning(
      new Error(
        `Herdr pane layout capability is unavailable; using adjacent fallback splits: ${error.message}`,
      ),
    );
  }

  private releasePane(pane: string): void {
    const owner = this.panes.get(pane);
    this.panes.delete(pane);
    this.metadataSequences.delete(pane);
    if (owner?.herdrPaneId === pane) {
      owner.herdrPaneId = undefined;
      owner.herdrTabId = undefined;
    }
    if (owner) this.stopObserving(owner);
  }

  private releaseExternally(pane: string, cause?: unknown): void {
    const owner = this.panes.get(pane);
    this.releasePane(pane);
    if (owner) {
      const detail = cause instanceof Error ? `: ${cause.message}` : "";
      this.onError(owner, new Error(`Herdr subagent pane was externally deleted${detail}`));
    }
  }

  private reconcile(layout: HerdrPaneLayout): void {
    const present = new Set(layout.panes.map((entry) => entry.paneId));
    for (const pane of [...this.panes.keys()]) if (!present.has(pane)) this.releaseExternally(pane);
    if (this.panes.size === 0) this.tabId = undefined;
  }

  private fallbackSplit(): { pane: string; direction: "down" } | undefined {
    const pane = [...this.panes.keys()].at(-1);
    return pane ? { pane, direction: "down" } : undefined;
  }

  /** Query each known pane at most once: deleted panes cannot create an infinite retry loop. */
  private async selectSplit(): Promise<{ pane: string; direction: "right" | "down" } | undefined> {
    for (const candidate of [...this.panes.keys()]) {
      let layout: HerdrPaneLayout;
      try {
        layout = await this.client.layout(candidate);
      } catch (cause) {
        if (isMissingHerdrPane(cause)) {
          this.releaseExternally(candidate, cause);
          continue;
        }
        if (isHerdrLayoutUnavailable(cause)) {
          const error = cause instanceof Error ? cause : new Error(String(cause));
          this.warnLayout(error);
          return this.fallbackSplit();
        }
        throw cause;
      }
      this.reconcile(layout);
      this.tabId = this.panes.size > 0 ? layout.tabId : undefined;
      const owned = layout.panes.filter((entry) => this.panes.has(entry.paneId));
      const largest = owned.reduce<(typeof owned)[number] | undefined>(
        (best, entry) => (!best || area(entry.rect) > area(best.rect) ? entry : best),
        undefined,
      );
      if (!largest) return undefined;
      return {
        pane: largest.paneId,
        direction: largest.rect.width >= 2 * largest.rect.height ? "right" : "down",
      };
    }
    this.tabId = undefined;
    return undefined;
  }

  private async refreshAfterClosure(): Promise<void> {
    if (this.panes.size === 0) return;
    await this.selectSplit();
  }

  /** Refresh task-derived display metadata after send/redirect mutates the current task. */
  async updateMetadata(agent: ManagedAgent, task = agent.task): Promise<void> {
    const pane = agent.herdrPaneId;
    if (!pane || !this.panes.has(pane)) return;
    const seq = (this.metadataSequences.get(pane) ?? 0) + 1;
    this.metadataSequences.set(pane, seq);
    const roleName = `${agent.definition.mode[0]!.toUpperCase()}${agent.definition.mode.slice(1)}`;
    const role = token(roleName, agent.definition.mode);
    const model = token(
      agent.effectiveModel ?? agent.requestedModel ?? agent.definition.model,
      "inherit",
    );
    try {
      await this.client.reportMetadata(pane, {
        agent: agent.id,
        title: boundedDisplayText(`${role} · ${taskPaneTitle(task)}`, 80),
        displayRole: role,
        stateLabels: {
          working: agent.definition.mode === "explorer" ? "investigating" : "implementing",
          blocked: "blocked",
          idle: agent.status === "closed" ? "closed" : "ready",
          done: agent.status === "closed" ? "closed" : "ready",
        },
        tokens: { role, model },
        seq,
      });
    } catch (cause) {
      if (isMissingHerdrPane(cause)) {
        this.releaseExternally(pane, cause);
        return;
      }
      if (!this.warnedAboutMetadata) {
        this.warnedAboutMetadata = true;
        this.onCapabilityWarning(
          new Error(
            `Herdr pane metadata capability is unavailable; task labels will use Herdr defaults: ${cause instanceof Error ? cause.message : String(cause)}`,
          ),
        );
      }
    }
  }

  /** Compatibility alias for callers that name the task transition explicitly. */
  async updateTask(agent: ManagedAgent, task = agent.task): Promise<void> {
    await this.updateMetadata(agent, task);
  }

  async focus(agent: ManagedAgent): Promise<void> {
    if (!agent.herdrPaneId) throw new Error("Herdr subagent pane was not created.");
    try {
      await this.client.focus(agent.herdrPaneId);
    } catch (cause) {
      if (isMissingHerdrPane(cause)) this.releaseExternally(agent.herdrPaneId, cause);
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
    try {
      await this.client.interrupt(agent.herdrPaneId);
    } catch (cause) {
      if (isMissingHerdrPane(cause)) this.releaseExternally(agent.herdrPaneId, cause);
      throw cause;
    }
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
    void this.watchTurn(agent, generation);
  }

  stopObserving(agent: ManagedAgent): void {
    const retry = this.retryTimers.get(agent.id);
    if (retry) clearTimeout(retry);
    this.retryTimers.delete(agent.id);
    this.watchGenerations.set(agent.id, (this.watchGenerations.get(agent.id) ?? 0) + 1);
  }

  shutdown(agent: ManagedAgent): Promise<void> {
    this.stopObserving(agent);
    return this.topology(() => this.shutdownNow(agent));
  }

  private async shutdownNow(agent: ManagedAgent): Promise<void> {
    const pane = agent.herdrPaneId;
    if (!pane || !this.panes.has(pane)) return;
    try {
      await this.client.interrupt(pane);
    } catch (cause) {
      if (isMissingHerdrPane(cause)) {
        this.releasePane(pane);
        if (this.panes.size === 0) this.tabId = undefined;
        return;
      }
      // Continue to pane closure even when interrupt delivery itself fails.
    }

    if (this.panes.size === 1 && this.tabId) {
      const tab = this.tabId;
      try {
        await this.client.closeTab(tab);
      } catch (cause) {
        if (!isMissingHerdrPane(cause)) throw cause;
      }
      this.releasePane(pane);
      this.tabId = undefined;
      return;
    }

    try {
      await this.client.close(pane);
    } catch (cause) {
      if (!isMissingHerdrPane(cause)) throw cause;
    }
    this.releasePane(pane);
    try {
      await this.refreshAfterClosure();
    } catch {
      /* Closure succeeded; geometry refresh will be retried before the next split. */
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
      if (isMissingHerdrPane(cause)) {
        if (agent.herdrPaneId) this.releaseExternally(agent.herdrPaneId, cause);
        return;
      }
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
      if (isMissingHerdrPane(cause)) {
        if (agent.herdrPaneId) this.releaseExternally(agent.herdrPaneId, cause);
        return;
      }
      const error = cause instanceof Error ? cause : new Error(String(cause));
      // `agent wait` is an observation call, not child-process completion evidence.
      this.onWatchWarning(agent, error);
      this.scheduleRetry(agent, generation, () => this.watchTurn(agent, generation));
    }
  }
}
