import {
  DynamicBorder,
  type KeybindingsManager,
  rawKeyHint,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  Box,
  type Component,
  Key,
  matchesKey,
  Text,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import type { SubagentsStatusEvent } from "../../shared/events.js";
import type { AgentSnapshot, ManagedAgent } from "./types.js";
import { agentSnapshot } from "./types.js";

export function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

const TERMINAL_ESCAPE = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\)?)/gu;

function cleanDisplayLine(value: string): string {
  return value
    .replace(TERMINAL_ESCAPE, "")
    .replace(/[\p{Cc}\p{Cf}]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function displayLines(value: string): string[] {
  return value.split(/\r\n|[\n\r\u2028\u2029]/u).map(cleanDisplayLine);
}

function safeMultiline(value: string): string {
  return displayLines(value).join("\n");
}

export function taskLabel(value: string, max = 120): string {
  const first = displayLines(value).find(Boolean);
  return (first || "Untitled task").slice(0, max);
}

export function shortModel(value: string | undefined): string {
  const model = value?.split("/").at(-1) ?? "inherit";
  if (/luna/iu.test(model)) return "luna";
  if (/\bsol\b/iu.test(model) || /-sol(?:-|$)/iu.test(model)) return "sol";
  return model;
}

export function resourceDiagnostics(agent: ManagedAgent | AgentSnapshot): string[] {
  const requested = agent.requestedResources;
  const detected = agent.detectedResources;
  const effective = agent.effectiveResources;
  if (!requested || !detected || !effective) return [];
  const state = (value: boolean, requestedValue: string | boolean) =>
    requestedValue === false || requestedValue === "disabled"
      ? "disabled"
      : value
        ? "available"
        : "unavailable";
  const requestedText = (value: string | boolean) =>
    typeof value === "boolean" ? (value ? "enabled" : "disabled") : value;
  const mode = "definition" in agent ? agent.definition.mode : agent.mode;
  const lines = [
    `Context Mode: ${requested.contextMode} → ${state(effective.contextMode, requested.contextMode)}`,
    `Context Execution: ${requestedText(requested.contextExecution)} → ${state(effective.contextExecution, requested.contextExecution)}`,
    `Web Search: ${requestedText(requested.webSearch)} → ${state(effective.webSearch, requested.webSearch)}`,
    `Todos: ${requestedText(requested.todos)} → ${state(effective.todos, requested.todos)}`,
    `RTK: ${requested.rtk} → ${state(effective.rtk, requested.rtk)}`,
    `UV: ${requested.uv} → ${state(effective.uv, requested.uv)}${mode === "worker" && !effective.uv ? "; native Bash active" : ""}`,
    `Copilot compaction fix: ${requestedText(requested.copilotCompactionFix)} → ${state(effective.copilotCompactionFix, requested.copilotCompactionFix)}`,
  ];
  if (agent.resourceWarnings?.length) lines.push(`Warnings: ${agent.resourceWarnings.join(" ")}`);
  return lines;
}

export function formatAgent(agent: ManagedAgent | AgentSnapshot): string {
  const tokens =
    agent.usage.total ||
    agent.usage.input + agent.usage.output + agent.usage.cacheRead + agent.usage.cacheWrite;
  const model = agent.effectiveModel ?? agent.requestedModel ?? "inherited model";
  const thinking = agent.effectiveThinking ?? agent.requestedThinking ?? "inherited effort";
  const mode = "definition" in agent ? agent.definition.mode : agent.mode;
  return `${agent.name} (${mode}) · ${agent.status} · ${model} · ${thinking}${tokens ? ` · ${tokens.toLocaleString()} tokens` : ""}${agent.usage.cost ? ` · $${agent.usage.cost.toFixed(4)}` : ""}`;
}

function colorForStatus(
  status: AgentSnapshot["status"],
): "muted" | "success" | "warning" | "error" | "dim" {
  if (status === "running") return "muted";
  if (status === "completed") return "success";
  if (status === "failed") return "error";
  if (status === "interrupted" || status === "closed") return "dim";
  return "warning";
}

function styledJoin(
  theme: Theme,
  fields: Array<{ value: string; color: Parameters<Theme["fg"]>[0] }>,
): string {
  return fields.map((field) => theme.fg(field.color, field.value)).join(theme.fg("dim", " · "));
}

/** Theme-native, task-first rows consumed by the sole inline UI owner. */
export function activityViewLines(
  status: SubagentsStatusEvent,
  theme: Theme,
  width: number,
  frame = "△",
): string[] {
  if (width <= 0 || status.agents.length === 0) return [];
  const safe = (line: string) => truncateToWidth(line, width, "");
  const header =
    status.active > 0
      ? `${theme.fg("accent", frame)} ${theme.fg(
          "muted",
          `Hackeln... · ${status.active} running (${status.explorers}E, ${status.workers}W)${status.ready ? ` · ${status.ready} ready` : ""}`,
        )}`
      : theme.fg(
          "muted",
          status.ready === 1
            ? "Subagents · 1 ready for follow-up"
            : status.ready > 1
              ? `Subagents · ${status.ready} ready for follow-up`
              : "Subagents · recent activity",
        );
  const lines = [safe(header)];
  for (const [index, agent] of status.agents.slice(0, 4).entries()) {
    const last = index === Math.min(4, status.agents.length) - 1;
    const taskConnector = theme.fg("dim", last ? "  └─ " : "  ├─ ");
    const metaConnector = theme.fg("dim", last ? "     " : "  │  ");
    lines.push(safe(taskConnector + theme.fg("text", taskLabel(agent.task))));

    const stateText = agent.status === "completed" ? "completed" : agent.status;
    const base = [
      { value: agent.mode, color: "dim" as const },
      { value: stateText, color: colorForStatus(agent.status) },
    ];
    const optional = [
      {
        value: shortModel(agent.effectiveModel ?? agent.requestedModel),
        color: "dim" as const,
      },
      {
        value: agent.effectiveThinking ?? agent.requestedThinking ?? "inherit",
        color: "dim" as const,
      },
      { value: formatDuration(agent.elapsedMs), color: "dim" as const },
      {
        value:
          agent.status === "completed"
            ? "report ready"
            : taskLabel(
                agent.latestActivity ?? (agent.status === "running" ? "working…" : agent.status),
                80,
              ),
        color: colorForStatus(agent.status),
      },
    ];
    let fields = [...base, ...optional];
    let row = metaConnector + styledJoin(theme, fields);
    if (visibleWidth(row) > width) {
      fields = [...base, ...optional.slice(0, -1)];
      row = metaConnector + styledJoin(theme, fields);
    }
    if (visibleWidth(row) > width) {
      fields = [...base, optional[2]!];
      row = metaConnector + styledJoin(theme, fields);
    }
    lines.push(safe(row));
  }
  return lines.map(safe);
}

/** Compatibility helper for diagnostics; the live widget uses activityViewLines(). */
export function activityWidgetLines(agents: Iterable<ManagedAgent>): string[] {
  return [...agents]
    .filter((agent) => agent.status === "running")
    .slice(0, 4)
    .flatMap((agent) => [taskLabel(agent.task), `${agent.definition.mode} · running`]);
}

export function agentViewLines(agents: Iterable<ManagedAgent | AgentSnapshot>): string[] {
  const values = [...agents].map((agent) => ("definition" in agent ? agentSnapshot(agent) : agent));
  if (!values.length) return ["No subagents have been started."];
  return values.flatMap((agent) => [
    taskLabel(agent.task),
    `  ${agent.id} · ${formatAgent(agent)} · ${agent.backend}`,
    ...resourceDiagnostics(agent).map((line) => `  ${line}`),
    ...(agent.report
      ? agent.report
          .split("\n")
          .slice(0, 8)
          .map((line) => `  ${line}`)
      : []),
  ]);
}

export type AgentsOverlayAction = {
  kind: "close" | "guide" | "redirect" | "focus" | "closeAgent" | "help";
  id?: string;
};

/** Complete interactive history. It deliberately owns only overlay-local keys. */
export class AgentsViewer {
  private agents: AgentSnapshot[] = [];
  private selected = 0;
  private timer: ReturnType<typeof setInterval> | undefined;
  private disposed = false;

  constructor(
    private readonly tui: { terminal: { rows: number }; requestRender(): void },
    private readonly theme: Theme,
    private readonly keybindings: KeybindingsManager,
    private readonly readAgents: () => AgentSnapshot[],
    private readonly done: (action: AgentsOverlayAction) => void,
  ) {
    this.refresh();
    this.timer = setInterval(() => this.refresh(), 250);
  }

  private refresh(): void {
    if (this.disposed) return;
    this.agents = this.readAgents();
    this.selected = Math.min(this.selected, Math.max(0, this.agents.length - 1));
    this.tui.requestRender();
  }
  private close(action: AgentsOverlayAction): void {
    this.dispose();
    this.done(action);
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  handleInput(data: string): void {
    const selected = this.agents[this.selected];
    if (matchesKey(data, Key.escape) || data === "q") return this.close({ kind: "close" });
    if (data === "r") return this.refresh();
    if (data === "?") return this.close({ kind: "help" });
    if (data === "f" && selected?.herdrPaneId)
      return this.close({ kind: "focus", id: selected.id });
    if (data === "x" && selected && ["running", "completed"].includes(selected.status))
      return this.close({ kind: "closeAgent", id: selected.id });
    if (data === "s" && selected?.status === "running")
      return this.close({ kind: "redirect", id: selected.id });
    if (this.keybindings.matches(data, "tui.select.up") || matchesKey(data, Key.up))
      this.selected = Math.max(0, this.selected - 1);
    else if (this.keybindings.matches(data, "tui.select.down") || matchesKey(data, Key.down))
      this.selected = Math.min(Math.max(0, this.agents.length - 1), this.selected + 1);
    else if (
      matchesKey(data, Key.enter) &&
      selected &&
      ["running", "completed"].includes(selected.status)
    )
      return this.close({ kind: "guide", id: selected.id });
    else return;
    this.tui.requestRender();
  }

  render(width: number): string[] {
    const safe = (line: string) => truncateToWidth(line, Math.max(1, width), "");
    const topBorder = new DynamicBorder((text) => this.theme.fg("border", text));
    const bottomBorder = new DynamicBorder((text) => this.theme.fg("borderMuted", text));
    const body: string[] = [
      ...topBorder.render(width),
      this.theme.fg("accent", " Subagent activity"),
    ];
    if (!this.agents.length) body.push(this.theme.fg("muted", " No subagents have been started."));
    for (const [index, agent] of this.agents.entries()) {
      const selected = index === this.selected;
      const cursor = this.theme.fg(selected ? "accent" : "dim", selected ? "› " : "  ");
      const task = this.theme.fg("text", taskLabel(agent.task));
      const taskRow = cursor + task;
      body.push(selected ? this.theme.bg("selectedBg", taskRow) : taskRow);
      const metadata = `  ${agent.mode} · ${agent.status} · ${shortModel(agent.effectiveModel ?? agent.requestedModel)} · ${agent.effectiveThinking ?? agent.requestedThinking ?? "inherit"} · ${formatDuration(agent.elapsedMs)} · ${agent.id}`;
      body.push(this.theme.fg(colorForStatus(agent.status), metadata));
    }
    const selected = this.agents[this.selected];
    if (selected) {
      body.push(
        "",
        this.theme.fg("text", "Task:"),
        ...displayLines(selected.task).map((line) => this.theme.fg("text", `  ${line}`)),
        this.theme.fg(
          "dim",
          `Backend: ${selected.backend}${selected.herdrPaneId ? ` · pane ${selected.herdrPaneId}` : ""}`,
        ),
        this.theme.fg(
          "dim",
          `Requested: ${selected.requestedModel ?? "inherit"} · ${selected.requestedThinking ?? "inherit"}`,
        ),
        this.theme.fg(
          "dim",
          `Effective: ${selected.effectiveModel ?? "pending"} · ${selected.effectiveThinking ?? "pending"}`,
        ),
        ...resourceDiagnostics(selected).map((line) => this.theme.fg("dim", line)),
        this.theme.fg("muted", `Activity: ${selected.latestActivity ?? "waiting…"}`),
        this.theme.fg(
          "dim",
          `Usage: ${selected.usage.total.toLocaleString()} tokens${selected.usage.cost ? ` · $${selected.usage.cost.toFixed(4)}` : ""}`,
        ),
      );
      if (selected.activity.length)
        body.push(
          this.theme.fg("dim", "Activity history:"),
          ...selected.activity
            .slice(-8)
            .map((entry) =>
              this.theme.fg(
                "dim",
                `  ${entry.at} · ${entry.kind} · ${cleanDisplayLine(entry.text)}`,
              ),
            ),
        );
      if (selected.report)
        body.push(
          this.theme.fg("success", "Report:"),
          ...displayLines(selected.report)
            .slice(0, 8)
            .map((line) => this.theme.fg("text", line)),
        );
      if (selected.error)
        body.push(this.theme.fg("error", `Error: ${cleanDisplayLine(selected.error)}`));
      if (selected.stderr)
        body.push(
          this.theme.fg("error", "Stderr:"),
          ...displayLines(selected.stderr).map((line) => this.theme.fg("error", line)),
        );
    }
    const footer = [
      rawKeyHint("↑↓", "navigate"),
      rawKeyHint("enter", "guide"),
      rawKeyHint("s", "stop & redirect"),
      rawKeyHint("f", "focus"),
      rawKeyHint("x", "close agent"),
      rawKeyHint("?", "help"),
      rawKeyHint("esc", "close"),
    ].join(" · ");
    body.push(this.theme.fg("dim", footer), ...bottomBorder.render(width));
    return body.map(safe);
  }
  invalidate(): void {
    this.tui.requestRender();
  }
}

export function completionMessageRenderer(
  details: unknown,
  expanded: boolean,
  theme: Theme,
  outputPad = 0,
): Component | undefined {
  const agent = (details as { agent?: AgentSnapshot } | undefined)?.agent;
  if (!agent) return undefined;
  const status = theme.fg(colorForStatus(agent.status), agent.status);
  const title = theme.fg("text", taskLabel(agent.task));
  const role = `${theme.fg("dim", agent.mode)} ${theme.fg("dim", "·")} ${status}`;
  const usage = theme.fg(
    "dim",
    `${agent.effectiveModel ?? agent.requestedModel ?? "inherited model"} · ${formatDuration(agent.elapsedMs)} · ${agent.usage.total.toLocaleString()} tokens${agent.usage.cost ? ` · $${agent.usage.cost.toFixed(4)}` : ""}`,
  );
  const shell = (content: string): Component => {
    const box = new Box(outputPad, 1, (text) => theme.bg("customMessageBg", text));
    box.addChild(new Text(content, 0, 0));
    return box;
  };
  if (!expanded) {
    const preview = taskLabel(agent.report || agent.error || "No report", 240);
    return shell(
      [title, role, usage, theme.fg(agent.error ? "error" : "muted", preview)].join("\n"),
    );
  }
  const sections = [
    theme.fg("text", safeMultiline(agent.task)),
    role,
    theme.fg(
      "dim",
      `Backend: ${agent.backend}${agent.herdrPaneId ? ` · pane ${agent.herdrPaneId}` : ""}`,
    ),
    theme.fg("dim", `Transcript: ${agent.sessionFile ?? agent.sessionDir}`),
    ...resourceDiagnostics(agent).map((line) => theme.fg("dim", line)),
    theme.fg(
      "dim",
      `Requested: ${agent.requestedModel ?? "inherit"} · ${agent.requestedThinking ?? "inherit"}`,
    ),
    theme.fg(
      "dim",
      `Effective: ${agent.effectiveModel ?? "pending"} · ${agent.effectiveThinking ?? "pending"}`,
    ),
    theme.fg(
      "dim",
      `Usage: ${agent.usage.total.toLocaleString()} tokens · $${agent.usage.cost.toFixed(4)}`,
    ),
    agent.activity.length
      ? theme.fg(
          "dim",
          `Activity:\n${agent.activity.map((entry) => `${entry.at} · ${entry.kind} · ${entry.text}`).join("\n")}`,
        )
      : "",
    agent.report ? `${theme.fg("success", "Report")}\n${safeMultiline(agent.report)}` : "",
    agent.error ? theme.fg("error", `Error\n${safeMultiline(agent.error)}`) : "",
    agent.stderr ? theme.fg("error", `Stderr\n${safeMultiline(agent.stderr)}`) : "",
  ].filter(Boolean);
  return shell(sections.join("\n\n"));
}
