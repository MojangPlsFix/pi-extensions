import type { KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { AgentSnapshot, ManagedAgent } from "./types.js";
import { agentSnapshot } from "./types.js";

function duration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}
function oneLine(value: string, max = 150): string {
  return value.replace(/\s+/gu, " ").trim().slice(0, max);
}

export function formatAgent(agent: ManagedAgent | AgentSnapshot): string {
  const tokens =
    agent.usage.total ||
    agent.usage.input + agent.usage.output + agent.usage.cacheRead + agent.usage.cacheWrite;
  const model = agent.effectiveModel ?? agent.requestedModel ?? "default model";
  const thinking = agent.effectiveThinking ?? agent.requestedThinking ?? "default effort";
  const mode = "definition" in agent ? agent.definition.mode : agent.mode;
  return `${agent.name} (${mode}) · ${agent.status} · ${model} · ${thinking}${tokens ? ` · ${tokens.toLocaleString()} tokens` : ""}${agent.usage.cost ? ` · $${agent.usage.cost.toFixed(4)}` : ""}`;
}

export function activityWidgetLines(agents: Iterable<ManagedAgent>): string[] {
  const active = [...agents].filter((agent) => agent.status === "running");
  if (!active.length) return [];
  return [
    "SUBAGENTS",
    ...active.map((agent) => {
      const snapshot = agentSnapshot(agent);
      const model = snapshot.effectiveModel ?? snapshot.requestedModel ?? "default";
      const effort = snapshot.effectiveThinking ?? snapshot.requestedThinking ?? "default";
      return `● ${snapshot.mode} · ${model} · ${effort} · ${duration(snapshot.elapsedMs)} · ${snapshot.usage.total.toLocaleString()} tokens · ${oneLine(snapshot.latestActivity ?? "working…", 80)}`;
    }),
  ];
}

export function agentViewLines(agents: Iterable<ManagedAgent | AgentSnapshot>): string[] {
  const values = [...agents].map((agent) => ("definition" in agent ? agentSnapshot(agent) : agent));
  if (!values.length) return ["No subagents have been started."];
  const lines = ["SUBAGENTS"];
  for (const agent of values) {
    lines.push(
      "",
      `● ${agent.id}`,
      `  ${formatAgent(agent)}`,
      `  Backend: ${agent.backend}${agent.herdrPaneId ? ` · pane ${agent.herdrPaneId}` : ""}`,
      `  Task: ${agent.task}`,
    );
    lines.push(`  Activity: ${agent.latestActivity ?? "waiting for child response…"}`);
    if (agent.report)
      lines.push(
        "  Latest report:",
        ...agent.report
          .split("\n")
          .slice(0, 8)
          .map((line) => `    ${line}`),
      );
    else if (agent.error) lines.push(`  Error: ${agent.error}`);
    if (agent.stderr.trim()) lines.push(`  Stderr: ${agent.stderr.trim().split("\n").at(-1)}`);
  }
  return lines;
}

export type AgentsOverlayAction = { kind: "close" | "guide" | "redirect"; id?: string };

/** Live, selected-agent overlay. It deliberately owns only overlay-local keys. */
export class AgentsViewer {
  private agents: AgentSnapshot[] = [];
  private selected = 0;
  private timer: ReturnType<typeof setInterval>;

  constructor(
    private readonly tui: { terminal: { rows: number }; requestRender(): void },
    private readonly theme: { fg(color: string, text: string): string; bold(text: string): string },
    private readonly keybindings: KeybindingsManager,
    private readonly readAgents: () => AgentSnapshot[],
    private readonly done: (action: AgentsOverlayAction) => void,
  ) {
    this.refresh();
    this.timer = setInterval(() => this.refresh(), 250);
  }

  private refresh(): void {
    this.agents = this.readAgents();
    this.selected = Math.min(this.selected, Math.max(0, this.agents.length - 1));
    this.tui.requestRender();
  }
  private close(action: AgentsOverlayAction): void {
    clearInterval(this.timer);
    this.done(action);
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape) || data === "q") return this.close({ kind: "close" });
    if (data === "r") return this.refresh();
    if (this.keybindings.matches(data, "tui.select.up") || matchesKey(data, Key.up))
      this.selected = Math.max(0, this.selected - 1);
    else if (this.keybindings.matches(data, "tui.select.down") || matchesKey(data, Key.down))
      this.selected = Math.min(Math.max(0, this.agents.length - 1), this.selected + 1);
    else if (matchesKey(data, Key.enter) && this.agents[this.selected]?.status === "running")
      return this.close({ kind: "guide", id: this.agents[this.selected]!.id });
    else if (data === "R" && this.agents[this.selected]?.status === "running")
      return this.close({ kind: "redirect", id: this.agents[this.selected]!.id });
    else return;
    this.tui.requestRender();
  }

  render(width: number): string[] {
    const inner = Math.max(1, width - 2);
    const border = (text: string) => this.theme.fg("borderMuted", text);
    const frame = (line: string) => {
      const cut = truncateToWidth(line, inner, "");
      return border("│") + cut + " ".repeat(Math.max(0, inner - visibleWidth(cut))) + border("│");
    };
    const selected = this.agents[this.selected];
    const body: string[] = this.agents.length
      ? this.agents.map(
          (agent, index) =>
            `${index === this.selected ? "›" : " "} ${agent.status === "running" ? "●" : "○"} ${agent.id} · ${agent.mode} · ${agent.effectiveModel ?? agent.requestedModel ?? "default"} · ${agent.effectiveThinking ?? agent.requestedThinking ?? "default"}`,
        )
      : ["No subagents have been started."];
    if (selected) {
      body.push(
        "",
        `Task: ${selected.task}`,
        `Backend: ${selected.backend}${selected.herdrPaneId ? ` · pane ${selected.herdrPaneId}` : ""}`,
        `Requested: ${selected.requestedModel ?? "default"} · ${selected.requestedThinking ?? "default"}`,
        `Effective: ${selected.effectiveModel ?? "pending confirmation"} · ${selected.effectiveThinking ?? "pending confirmation"}`,
        `Activity: ${selected.latestActivity ?? "waiting…"}`,
        `Usage: ${selected.usage.total.toLocaleString()} tokens${selected.usage.cost ? ` · $${selected.usage.cost.toFixed(4)}` : ""}`,
      );
      if (selected.report) body.push("Report:", ...selected.report.split("\n").slice(0, 7));
      if (selected.error) body.push(`Error: ${selected.error}`);
    }
    const footer = "↑↓ select · Enter guide · R stop & redirect · r refresh · Esc close";
    return [
      border(`┌${"─".repeat(inner)}┐`),
      frame(this.theme.fg("accent", this.theme.bold(" Subagent activity "))),
      ...body.map((line) => frame(line)),
      frame(this.theme.fg("dim", footer)),
      border(`└${"─".repeat(inner)}┘`),
    ].map((line) => truncateToWidth(line, width, ""));
  }
  invalidate(): void {
    this.refresh();
  }
}
