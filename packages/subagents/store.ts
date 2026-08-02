import type { AgentStatusSummary, ManagedAgent } from "./types.js";

const OPEN_STATUSES = new Set<ManagedAgent["status"]>(["running", "completed"]);

function recentTime(agent: ManagedAgent): number {
  return Date.parse(agent.finishedAt ?? agent.startedAt) || 0;
}

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
  open(): ManagedAgent[] {
    return this.all().filter((agent) => OPEN_STATUSES.has(agent.status));
  }
  inline(limit = 4): ManagedAgent[] {
    const all = this.all();
    // Closed/failed/interrupted entries are contextual recent history only. Once no agent is
    // open, the inline activity block disappears; complete history remains available in /agents.
    if (!all.some((agent) => OPEN_STATUSES.has(agent.status))) return [];
    const rank = (agent: ManagedAgent): number =>
      agent.status === "running" ? 0 : agent.status === "completed" ? 1 : 2;
    return all
      .sort((left, right) => rank(left) - rank(right) || recentTime(right) - recentTime(left))
      .slice(0, limit);
  }

  summary(): AgentStatusSummary {
    const all = this.all();
    const running = all.filter((agent) => agent.status === "running");
    const ready = all.filter((agent) => agent.status === "completed").length;
    return {
      active: running.length,
      ready,
      open: running.length + ready,
      explorers: running.filter((agent) => agent.definition.mode === "explorer").length,
      workers: running.filter((agent) => agent.definition.mode === "worker").length,
      failed: all.filter((agent) => agent.status === "failed").length,
      interrupted: all.filter((agent) => agent.status === "interrupted").length,
      closed: all.filter((agent) => agent.status === "closed").length,
    };
  }
}
