import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { HerdrClient } from "./herdr-client.js";

export type HerdrInspectorBinding = {
  runId: string;
  paneId: string;
  sessionFile: string;
  openedAt: string;
};

function shellArgument(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

type InspectorHerdrClient = Pick<HerdrClient, "verify" | "splitCurrent" | "runInPane" | "close">;

/** Optional display-only Herdr panes. Child execution remains owned by AgentSession. */
export class HerdrInspectorManager {
  private readonly bindings = new Map<string, HerdrInspectorBinding>();

  constructor(private readonly client: InspectorHerdrClient = new HerdrClient()) {}

  all(): HerdrInspectorBinding[] {
    return [...this.bindings.values()].map((binding) => ({ ...binding }));
  }

  get(runId: string): HerdrInspectorBinding | undefined {
    const binding = this.bindings.get(runId);
    return binding ? { ...binding } : undefined;
  }

  async open(
    runId: string,
    sessionFile: string,
    cwd: string,
    options: {
      direction?: "right" | "down";
      maxOutputBytes?: number;
      themeName?: string;
    } = {},
  ): Promise<HerdrInspectorBinding> {
    const existing = this.bindings.get(runId);
    if (existing) {
      try {
        await this.client.verify(existing.paneId);
        return { ...existing };
      } catch {
        this.bindings.delete(runId);
      }
    }
    if (HerdrClient.environmentState() !== "complete")
      throw new Error("Herdr is unavailable; the native Agent Hub transcript remains available.");
    if (!existsSync(sessionFile))
      throw new Error(`Subagent transcript does not exist: ${sessionFile}`);
    const parentPane = process.env.HERDR_PANE_ID;
    if (!parentPane) throw new Error("HERDR_PANE_ID is unavailable.");
    await this.client.verify(parentPane);
    const paneId = await this.client.splitCurrent(options.direction ?? "right", cwd, false);
    const runner = fileURLToPath(new URL("./inspector-runner.mjs", import.meta.url));
    const maxOutputBytes = Math.max(1, Math.floor(options.maxOutputBytes ?? 1_000_000));
    const themeName = options.themeName?.trim() ? options.themeName.trim() : "dark";
    const command = `${shellArgument(process.execPath)} ${shellArgument(runner)} ${shellArgument(sessionFile)} ${maxOutputBytes} ${shellArgument(cwd)} ${shellArgument(themeName)}`;
    try {
      await this.client.runInPane(paneId, command);
    } catch (cause) {
      await this.client.close(paneId).catch(() => {});
      throw cause;
    }
    const binding = {
      runId,
      paneId,
      sessionFile,
      openedAt: new Date().toISOString(),
    };
    this.bindings.set(runId, binding);
    return { ...binding };
  }

  async close(runId: string): Promise<void> {
    const binding = this.bindings.get(runId);
    if (!binding) return;
    this.bindings.delete(runId);
    await this.client.close(binding.paneId).catch(() => {});
  }

  async shutdown(): Promise<void> {
    await Promise.all([...this.bindings.keys()].map((runId) => this.close(runId)));
  }
}
