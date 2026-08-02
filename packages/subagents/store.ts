import type { AgentStatusSummary, ManagedAgent } from "./types.js";

export class AgentStore {
  private readonly values = new Map<string, ManagedAgent>();

  add(agent: ManagedAgent): void {
    this.values.set(agent.id, agent);
  }
  get(id: string): ManagedAgent | undefined {
    return this.values.get(id);
  }
  all(): ManagedAgent[] {
    return [...this.values.values()];
  }
  running(): ManagedAgent[] {
    return this.all().filter((agent) => agent.status === "running");
  }

  summary(): AgentStatusSummary {
    const active = this.running();
    return {
      active: active.length,
      explorers: active.filter((agent) => agent.definition.mode === "explorer").length,
      workers: active.filter((agent) => agent.definition.mode === "worker").length,
      failed: this.all().filter((agent) => agent.status === "failed").length,
    };
  }
}
