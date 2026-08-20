import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
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
import type { HubSnapshot } from "./manager.js";
import type { RunSnapshot, RunStatus } from "./types.js";

export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
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

export function safeDisplayText(value: string): string {
  return displayLines(value).join("\n");
}

export function taskLabel(value: string, max = 120): string {
  const first = displayLines(value).find(Boolean);
  return (first || "Untitled task").slice(0, max);
}

export function shortModel(value: string | undefined): string {
  const model = cleanDisplayLine(value?.split("/").at(-1) ?? "inherit");
  if (/luna/iu.test(model)) return "luna";
  if (/\bsol\b/iu.test(model) || /-sol(?:-|$)/iu.test(model)) return "sol";
  return model;
}

function colorForStatus(status: RunStatus): "muted" | "success" | "warning" | "error" | "dim" {
  if (status === "running" || status === "starting" || status === "queued") return "muted";
  if (status === "parked") return "success";
  if (status === "blocked") return "warning";
  if (status === "failed") return "error";
  return "dim";
}

function styledJoin(
  theme: Theme,
  fields: Array<{ value: string; color: Parameters<Theme["fg"]>[0] }>,
): string {
  return fields.map((field) => theme.fg(field.color, field.value)).join(theme.fg("dim", " · "));
}

/** Compact event-driven rows consumed by the working indicator. */
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
      ? `${theme.fg("accent", frame)} ${theme.fg("muted", `Subagents · ${status.active} active${status.blocked ? ` · ${status.blocked} blocked` : ""}`)}`
      : theme.fg("muted", `Subagents · ${status.parked} parked`);
  const lines = [safe(header)];
  for (const [index, agent] of status.agents.slice(0, 4).entries()) {
    const last = index === Math.min(4, status.agents.length) - 1;
    const connector = theme.fg("dim", last ? "  └─ " : "  ├─ ");
    lines.push(safe(connector + theme.fg("text", taskLabel(agent.task))));
    const metadata = styledJoin(theme, [
      { value: agent.profileClass ?? "agent", color: "dim" },
      { value: agent.status, color: colorForStatus(agent.status) },
      { value: shortModel(agent.effectiveModel), color: "dim" },
      { value: formatDuration(agent.elapsedMs), color: "dim" },
      {
        value: taskLabel(
          agent.latestActivity ?? (agent.status === "running" ? "working…" : agent.status),
          80,
        ),
        color: colorForStatus(agent.status),
      },
    ]);
    lines.push(safe(theme.fg("dim", last ? "     " : "  │  ") + metadata));
  }
  return lines;
}

export function formatRun(run: RunSnapshot): string {
  const tokens = run.usage.total.toLocaleString();
  return `${cleanDisplayLine(run.name)} (${run.profileClass}) · ${run.status} · ${cleanDisplayLine(run.effectiveModel ?? "inherit")} · ${cleanDisplayLine(run.effectiveThinking ?? "inherit")}${run.usage.total ? ` · ${tokens} tokens` : ""}${run.usage.cost ? ` · $${run.usage.cost.toFixed(4)}` : ""}`;
}

export function agentViewLines(agents: Iterable<RunSnapshot>): string[] {
  const values = [...agents];
  if (!values.length) return ["No subagents have been started."];
  return values.flatMap((run) => [
    taskLabel(run.task),
    `  ${run.id} · ${formatRun(run)}`,
    `  owns: ${cleanDisplayLine(run.ownership.owns.join(", "))}`,
    ...(run.report
      ? displayLines(run.report)
          .slice(0, 8)
          .map((line) => `  ${line}`)
      : []),
  ]);
}

export type AgentsOverlayAction = {
  kind:
    | "close"
    | "steer"
    | "stop"
    | "inspect"
    | "answer"
    | "toggleProfile"
    | "ejectProfile"
    | "refresh"
    | "help"
    | "startMission";
  id?: string;
};

type HubSection = "runs" | "inbox" | "profiles";

/** Event-driven native Agent Hub. */
export class AgentsViewer {
  private snapshot: HubSnapshot;
  private section: HubSection = "runs";
  private selected = 0;
  private disposed = false;
  private readonly unsubscribe: () => void;
  private clock: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly tui: { terminal: { rows: number }; requestRender(): void },
    private readonly theme: Theme,
    private readonly keybindings: KeybindingsManager,
    subscribe: (listener: (snapshot: HubSnapshot) => void) => () => void,
    private readonly done: (action: AgentsOverlayAction) => void,
    initial: HubSnapshot,
  ) {
    this.snapshot = initial;
    const activeIndex = this.runRows().findIndex(({ run }) =>
      ["queued", "starting", "running", "blocked"].includes(run.status),
    );
    this.selected = activeIndex >= 0 ? activeIndex : Math.max(0, this.runRows().length - 1);
    this.unsubscribe = subscribe((snapshot) => {
      if (this.disposed) return;
      this.snapshot = snapshot;
      this.clampSelection();
      this.syncClock();
      this.tui.requestRender();
    });
    this.syncClock();
  }

  private runRows(): Array<{ run: RunSnapshot; depth: number }> {
    const byParent = new Map<string | undefined, RunSnapshot[]>();
    const ids = new Set(this.snapshot.runs.map((run) => run.id));
    for (const run of this.snapshot.runs) {
      const parent = run.parentId && ids.has(run.parentId) ? run.parentId : undefined;
      byParent.set(parent, [...(byParent.get(parent) ?? []), run]);
    }
    const rows: Array<{ run: RunSnapshot; depth: number }> = [];
    const seen = new Set<string>();
    const visit = (run: RunSnapshot, depth: number) => {
      if (seen.has(run.id)) return;
      seen.add(run.id);
      rows.push({ run, depth });
      for (const child of byParent.get(run.id) ?? []) visit(child, depth + 1);
    };
    for (const root of byParent.get(undefined) ?? []) visit(root, 0);
    for (const run of this.snapshot.runs) visit(run, 0);
    return rows;
  }

  private itemsLength(): number {
    if (this.section === "runs") return this.runRows().length;
    if (this.section === "inbox") return this.snapshot.requests.length;
    return this.snapshot.profiles.filter((profile) => !profile.hidden).length;
  }

  private clampSelection(): void {
    this.selected = Math.min(this.selected, Math.max(0, this.itemsLength() - 1));
  }

  private visibleWindow(length: number): { start: number; end: number } {
    const maximum = Math.max(4, Math.min(7, Math.floor(this.tui.terminal.rows / 4)));
    const start = Math.max(0, Math.min(this.selected - Math.floor(maximum / 2), length - maximum));
    return { start, end: Math.min(length, start + maximum) };
  }

  private syncClock(): void {
    const active = this.snapshot.runs.some((run) =>
      ["queued", "starting", "running", "blocked"].includes(run.status),
    );
    if (active && !this.clock) {
      this.clock = setInterval(() => this.tui.requestRender(), 1_000);
      this.clock.unref?.();
    } else if (!active && this.clock) {
      clearInterval(this.clock);
      this.clock = undefined;
    }
  }

  private close(action: AgentsOverlayAction): void {
    this.dispose();
    this.done(action);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribe();
    if (this.clock) clearInterval(this.clock);
    this.clock = undefined;
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape) || data === "q") return this.close({ kind: "close" });
    if (data === "?") return this.close({ kind: "help" });
    if (data === "r") return this.close({ kind: "refresh" });
    if (matchesKey(data, Key.tab)) {
      this.section =
        this.section === "runs" ? "inbox" : this.section === "inbox" ? "profiles" : "runs";
      this.selected = 0;
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, Key.home)) {
      this.selected = 0;
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, Key.end)) {
      this.selected = Math.max(0, this.itemsLength() - 1);
      this.tui.requestRender();
      return;
    }
    const page = Math.max(4, Math.min(7, Math.floor(this.tui.terminal.rows / 4)));
    if (matchesKey(data, Key.pageUp)) {
      this.selected = Math.max(0, this.selected - page);
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, Key.pageDown)) {
      this.selected = Math.min(Math.max(0, this.itemsLength() - 1), this.selected + page);
      this.tui.requestRender();
      return;
    }
    if (this.keybindings.matches(data, "tui.select.up") || matchesKey(data, Key.up))
      this.selected = Math.max(0, this.selected - 1);
    else if (this.keybindings.matches(data, "tui.select.down") || matchesKey(data, Key.down))
      this.selected = Math.min(Math.max(0, this.itemsLength() - 1), this.selected + 1);
    else if (this.section === "runs") {
      const run = this.runRows()[this.selected]?.run;
      if (!run) return;
      if (data === "s" || (matchesKey(data, Key.enter) && run.status === "parked"))
        return this.close({ kind: "steer", id: run.id });
      if (data === "x" && ["queued", "starting", "running", "blocked"].includes(run.status))
        return this.close({ kind: "stop", id: run.id });
      if (data === "t" && run.sessionFile) return this.close({ kind: "inspect", id: run.id });
    } else if (this.section === "inbox" && matchesKey(data, Key.enter)) {
      const request = this.snapshot.requests[this.selected];
      if (request?.status === "pending") return this.close({ kind: "answer", id: request.id });
    } else if (this.section === "profiles") {
      const profile = this.snapshot.profiles.filter((candidate) => !candidate.hidden)[
        this.selected
      ];
      if (!profile) return;
      if (matchesKey(data, Key.enter))
        return this.close({ kind: "toggleProfile", id: profile.name });
      if (data === "e" && profile.source === "builtin")
        return this.close({ kind: "ejectProfile", id: profile.name });
    }
    this.tui.requestRender();
  }

  private tabs(): string {
    const tab = (name: HubSection, count: number) =>
      this.section === name
        ? this.theme.bg("selectedBg", this.theme.fg("accent", ` ${name} ${count} `))
        : this.theme.fg("dim", ` ${name} ${count} `);
    return [
      tab("runs", this.snapshot.runs.length),
      tab("inbox", this.snapshot.requests.filter((request) => request.status === "pending").length),
      tab("profiles", this.snapshot.profiles.filter((profile) => !profile.hidden).length),
    ].join(this.theme.fg("borderMuted", " │ "));
  }

  render(width: number): string[] {
    const safe = (line: string) => truncateToWidth(line, Math.max(1, width), "");
    const border = "─".repeat(Math.max(1, width));
    const itemCount = this.itemsLength();
    const body = [
      this.theme.fg("border", border),
      this.theme.fg("accent", " Agent Hub"),
      this.tabs(),
      this.theme.fg(
        "dim",
        ` ${this.section} · selected ${itemCount ? this.selected + 1 : 0} of ${itemCount}`,
      ),
      "",
    ];
    if (this.section === "runs") this.renderRuns(body);
    else if (this.section === "inbox") this.renderInbox(body);
    else this.renderProfiles(body);
    const sectionHints =
      this.section === "runs"
        ? ["enter revive parked", "s steer/revive", "x stop active", "t transcript"]
        : this.section === "inbox"
          ? ["enter answer pending"]
          : ["enter enable/disable", "e eject built-in"];
    const footer = [
      "tab section",
      "↑↓/home/end/page navigate",
      ...sectionHints,
      "r refresh",
      "? help",
      "esc close",
    ].join(" · ");
    body.push("", this.theme.fg("dim", footer), this.theme.fg("borderMuted", border));
    return body.map(safe);
  }

  private renderRuns(body: string[]): void {
    if (!this.snapshot.runs.length) {
      body.push(
        this.theme.fg("muted", " No subagents yet. Dispatch bounded work or start /orchestrate."),
      );
      return;
    }
    const rows = this.runRows();
    const { start, end } = this.visibleWindow(rows.length);
    if (start > 0) body.push(this.theme.fg("dim", ` … ${start} earlier run(s)`));
    for (let index = start; index < end; index += 1) {
      const { run, depth } = rows[index]!;
      const selected = index === this.selected;
      const branch = depth > 0 ? `${"  ".repeat(Math.min(depth - 1, 4))}└─ ` : "";
      const row = `${selected ? "›" : " "} ${branch}${taskLabel(run.task)}  ${run.profileClass} · ${run.status} · ${formatDuration(run.elapsedMs)}`;
      body.push(
        selected
          ? this.theme.bg("selectedBg", this.theme.fg("text", row))
          : this.theme.fg("text", row),
      );
    }
    if (end < rows.length) body.push(this.theme.fg("dim", ` … ${rows.length - end} later run(s)`));
    const run = rows[this.selected]?.run;
    if (!run) return;
    body.push(
      "",
      this.theme.fg("muted", `${run.id} · ${formatRun(run)}`),
      this.theme.fg("dim", `Owns: ${cleanDisplayLine(run.ownership.owns.join(", "))}`),
      this.theme.fg("dim", `Deliverable: ${cleanDisplayLine(run.ownership.deliverable)}`),
      this.theme.fg("dim", `Transcript: ${cleanDisplayLine(run.sessionFile ?? "pending")}`),
      this.theme.fg("muted", `Activity: ${cleanDisplayLine(run.latestActivity ?? "waiting…")}`),
    );
    const mission = run.missionId
      ? this.snapshot.missions.find((candidate) => candidate.id === run.missionId)
      : undefined;
    if (mission)
      body.push(
        this.theme.fg(
          mission.status === "failed" ? "error" : "dim",
          `Mission: ${cleanDisplayLine(mission.id)} · ${mission.status} · ${mission.workspace}`,
        ),
        this.theme.fg("dim", `Mission scope: ${cleanDisplayLine(mission.scope.join(", "))}`),
        ...(mission.candidate
          ? [
              this.theme.fg(
                "warning",
                `Candidate: ${cleanDisplayLine(mission.candidate.files.join(", ") || "no changed files")}`,
              ),
            ]
          : []),
      );
    if (run.activity.length)
      body.push(
        this.theme.fg("dim", "Recent activity"),
        ...run.activity
          .slice(-4)
          .map((entry) =>
            this.theme.fg("dim", `  ${entry.kind} · ${cleanDisplayLine(entry.text)}`),
          ),
      );
    if (run.report)
      body.push(
        this.theme.fg("success", "Report"),
        ...displayLines(run.report)
          .slice(0, 8)
          .map((line) => this.theme.fg("text", `  ${line}`)),
      );
    if (run.error) body.push(this.theme.fg("error", `Error: ${cleanDisplayLine(run.error)}`));
  }

  private renderInbox(body: string[]): void {
    if (!this.snapshot.requests.length) {
      body.push(this.theme.fg("muted", " No supervisor requests."));
      return;
    }
    const { start, end } = this.visibleWindow(this.snapshot.requests.length);
    if (start > 0) body.push(this.theme.fg("dim", ` … ${start} earlier request(s)`));
    for (let index = start; index < end; index += 1) {
      const request = this.snapshot.requests[index]!;
      const selected = index === this.selected;
      const row = `${selected ? "›" : " "} ${cleanDisplayLine(request.title)}  ${request.kind} · ${request.status}`;
      body.push(
        selected
          ? this.theme.bg("selectedBg", this.theme.fg("text", row))
          : this.theme.fg("text", row),
      );
    }
    if (end < this.snapshot.requests.length)
      body.push(this.theme.fg("dim", ` … ${this.snapshot.requests.length - end} later request(s)`));
    const request = this.snapshot.requests[this.selected];
    if (request)
      body.push(
        "",
        ...displayLines(request.detail)
          .slice(0, 8)
          .map((line) => this.theme.fg(request.status === "pending" ? "warning" : "dim", line)),
        request.choices.length
          ? this.theme.fg(
              "dim",
              `Choices: ${cleanDisplayLine(
                request.choices.map((choice) => `${choice.value} (${choice.label})`).join(", "),
              )}`,
            )
          : this.theme.fg("dim", "Free-form response"),
      );
  }

  private renderProfiles(body: string[]): void {
    const profiles = this.snapshot.profiles.filter((profile) => !profile.hidden);
    if (!profiles.length) {
      body.push(this.theme.fg("muted", " No enabled profiles."));
      return;
    }
    const { start, end } = this.visibleWindow(profiles.length);
    if (start > 0) body.push(this.theme.fg("dim", ` … ${start} earlier profile(s)`));
    for (let index = start; index < end; index += 1) {
      const profile = profiles[index]!;
      const selected = index === this.selected;
      const disabled = profile.metadata?.disabled === true || profile.metadata?.enabled === false;
      const row = `${selected ? "›" : " "} ${profile.name}  ${profile.class} · ${profile.runner} · ${disabled ? "disabled" : "enabled"}`;
      body.push(
        selected
          ? this.theme.bg("selectedBg", this.theme.fg("text", row))
          : this.theme.fg("text", row),
      );
    }
    if (end < profiles.length)
      body.push(this.theme.fg("dim", ` … ${profiles.length - end} later profile(s)`));
    const profile = profiles[this.selected];
    if (profile)
      body.push(
        "",
        this.theme.fg("text", cleanDisplayLine(profile.description)),
        this.theme.fg(
          "dim",
          `Source: ${profile.source}${profile.path ? ` · ${cleanDisplayLine(profile.path)}` : ""}`,
        ),
        this.theme.fg("dim", `Tools: ${cleanDisplayLine(profile.tools?.join(", ") || "none")}`),
        this.theme.fg(
          "dim",
          `Capabilities: ${cleanDisplayLine(profile.capabilities?.join(", ") || "none")}`,
        ),
        this.theme.fg(
          "dim",
          `Nested: ${cleanDisplayLine(profile.allowedNestedProfiles.join(", ") || "disabled")}`,
        ),
        profile.metadata?.ejected
          ? this.theme.fg("success", "Ejected for customization")
          : this.theme.fg("dim", "Enter toggles enabled state; e ejects a built-in"),
      );
    if (this.snapshot.diagnostics.length)
      body.push(
        "",
        this.theme.fg("warning", `Diagnostics · ${this.snapshot.diagnostics.length}`),
        ...this.snapshot.diagnostics
          .slice(-4)
          .map((diagnostic) =>
            this.theme.fg(
              "warning",
              `  ${cleanDisplayLine(diagnostic.path)} · ${cleanDisplayLine(diagnostic.message)}`,
            ),
          ),
      );
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
  const run = (details as { run?: RunSnapshot } | undefined)?.run;
  if (!run) return undefined;
  const shell = (content: string): Component => {
    const box = new Box(outputPad, 1, (text) => theme.bg("customMessageBg", text));
    box.addChild(new Text(content, 0, 0));
    return box;
  };
  const title = theme.fg("text", taskLabel(run.task));
  const state = theme.fg(colorForStatus(run.status), `${run.profileClass} · ${run.status}`);
  const usage = theme.fg(
    "dim",
    `${cleanDisplayLine(run.effectiveModel ?? "inherited model")} · ${formatDuration(run.elapsedMs)} · ${run.usage.total.toLocaleString()} tokens${run.usage.cost ? ` · $${run.usage.cost.toFixed(4)}` : ""}`,
  );
  if (!expanded)
    return shell(
      [
        title,
        state,
        usage,
        theme.fg(
          run.error ? "error" : "muted",
          taskLabel(run.report || run.error || "No report", 240),
        ),
      ].join("\n"),
    );
  return shell(
    [
      theme.fg("text", safeDisplayText(run.task)),
      state,
      theme.fg("dim", `Owns: ${cleanDisplayLine(run.ownership.owns.join(", "))}`),
      theme.fg("dim", `Transcript: ${cleanDisplayLine(run.sessionFile ?? run.sessionDir)}`),
      usage,
      run.activity.length
        ? theme.fg(
            "dim",
            `Activity:\n${run.activity
              .map(
                (entry) =>
                  `${cleanDisplayLine(entry.at)} · ${entry.kind} · ${cleanDisplayLine(entry.text)}`,
              )
              .join("\n")}`,
          )
        : "",
      run.report ? `${theme.fg("success", "Report")}\n${safeDisplayText(run.report)}` : "",
      run.error ? theme.fg("error", `Error\n${safeDisplayText(run.error)}`) : "",
    ]
      .filter(Boolean)
      .join("\n\n"),
  );
}

export function fitsMetadata(row: string, width: number): boolean {
  return visibleWidth(row) <= width;
}
