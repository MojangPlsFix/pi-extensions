import { type KeybindingsManager, keyHint, type Theme } from "@earendil-works/pi-coding-agent";
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
import {
  activityContextLine,
  cleanDisplayLine,
  deriveActivityContext,
  displayLines,
  type PresentationGroup,
  presentationGroup,
  presentRun,
  rowWithReservedSuffix,
  runDisplayLabel,
  safeDisplayText,
  styleHerdrStatus,
  truncateStyledLine,
} from "./presentation.js";
import type { DispatchBatch, RunSnapshot } from "./types.js";

export { safeDisplayText } from "./presentation.js";

export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

export function taskLabel(value: string, max = 120): string {
  const first = displayLines(value).find(Boolean) || "Untitled task";
  return truncateToWidth(first, Math.max(1, max), "");
}

const HACKLER_LABEL = "Hackler";

function timestampAge(value: string | undefined, now: number): number | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? Math.max(0, now - parsed) : undefined;
}

function terminationText(
  reason: SubagentsStatusEvent["agents"][number]["terminationReason"],
): string | undefined {
  if (!reason) return undefined;
  const facts: string[] = [reason.code];
  if (reason.phase) facts.push(`phase ${reason.phase}`);
  if (reason.limit)
    facts.push(`${reason.limit.kind} ${reason.limit.observed}/${reason.limit.maximum}`);
  if (reason.ancestorRunId) facts.push(`ancestor ${cleanDisplayLine(reason.ancestorRunId)}`);
  return facts.join(" · ");
}

function activeLease(run: SubagentsStatusEvent["agents"][number]) {
  const openLease = run.leaseHistory
    ? [...run.leaseHistory].reverse().find((lease) => !lease.endedAt)
    : undefined;
  return (
    run.leaseHistory?.find((lease) => lease.generation === run.activeLeaseGeneration) ??
    openLease ??
    run.leaseHistory?.at(-1)
  );
}

function operationalFacts(run: SubagentsStatusEvent["agents"][number], now: number): string[] {
  const lease = activeLease(run);
  const leaseEnd = run.finishedAt ? Math.min(now, Date.parse(run.finishedAt)) : now;
  const leaseElapsed = lease ? Math.max(0, leaseEnd - Date.parse(lease.startedAt)) : undefined;
  const leaseRemaining = lease ? Math.max(0, Date.parse(lease.deadlineAt) - leaseEnd) : undefined;
  const limits = lease?.effectiveLimits ?? run.originalEffectiveLimits;
  const turns =
    run.runner === "external" || limits?.maxTurns === "notApplicable"
      ? "turns not applicable (external)"
      : limits && run.turns !== undefined
        ? `turns ${run.turns} used / ${Math.max(0, limits.maxTurns - run.turns)} remaining`
        : undefined;
  const lastEventAge = timestampAge(run.lastEventAt, now);
  const operationAge = timestampAge(run.currentOperation?.startedAt, now);
  return [
    leaseElapsed !== undefined && leaseRemaining !== undefined
      ? `lease ${formatDuration(leaseElapsed)} elapsed / ${formatDuration(leaseRemaining)} remaining`
      : undefined,
    turns,
    lastEventAge === undefined
      ? "last event not recorded"
      : `last event ${formatDuration(lastEventAge)} ago`,
    run.currentOperation
      ? `operation ${run.currentOperation.kind}: ${taskLabel(run.currentOperation.name, 60)} · ${formatDuration(operationAge ?? 0)}`
      : undefined,
    terminationText(run.terminationReason)
      ? `reason ${terminationText(run.terminationReason)}`
      : undefined,
    run.cleanupFailure
      ? `cleanup retained: ${taskLabel(run.cleanupFailure.message, 100)}`
      : undefined,
  ].filter((fact): fact is string => Boolean(fact));
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
  _now = Date.now(),
): string[] {
  if (width <= 0) return [];
  const foreground = status.agents
    .map((agent, index) => ({ agent, index, presentation: presentRun(agent) }))
    .filter(
      ({ agent, presentation }) => agent.group !== undefined || presentation.group !== "History",
    )
    .sort(
      (left, right) =>
        left.presentation.priority - right.presentation.priority || left.index - right.index,
    );
  if (foreground.length === 0) return [];
  const shown = foreground.slice(0, 4);
  const failureAttention = foreground.filter(
    ({ presentation }) => presentation.group === "Attention" && presentation.icon === "×",
  ).length;
  const readyAttention = foreground.filter(
    ({ presentation }) => presentation.group === "Attention" && presentation.icon === "✓",
  ).length;
  const headerParts = [
    theme.fg("muted", HACKLER_LABEL),
    `${theme.fg("warning", "◐")} ${theme.fg("muted", `${status.active}/${status.capacity.limit} active`)}`,
    ...(failureAttention
      ? [
          `${theme.fg("error", "×")} ${theme.fg(
            "muted",
            `${failureAttention} ${failureAttention === status.blocked ? "blocked" : "attention"}`,
          )}`,
        ]
      : []),
    ...(readyAttention
      ? [`${theme.fg("success", "✓")} ${theme.fg("muted", `${readyAttention} ready`)}`]
      : []),
  ];
  const lines = [truncateStyledLine(headerParts.join(theme.fg("dim", " · ")), width)];
  for (const { agent, presentation } of shown) {
    const prefix = `${styleHerdrStatus(theme, presentation, presentation.icon)} `;
    const critical =
      styleHerdrStatus(theme, presentation, presentation.state) +
      theme.fg("dim", ` · ${formatDuration(agent.elapsedMs)}`);
    const suffix = theme.fg("dim", " · ") + critical;
    lines.push(
      visibleWidth(prefix + suffix) >= width
        ? truncateStyledLine(prefix + critical, width)
        : rowWithReservedSuffix(prefix, theme.fg("text", presentation.label), suffix, width),
    );
    const context = deriveActivityContext(agent);
    const contextLine = activityContextLine(context, theme, width);
    if (contextLine) lines.push(contextLine);
  }
  const omitted = Math.max(0, foreground.length - shown.length);
  const history = Math.max(0, status.history ?? 0);
  if (omitted || history) {
    const parts = [
      ...(omitted ? [`+${omitted} active`] : []),
      ...(history ? [`${theme.fg("success", "○")} ${history} history`] : []),
    ];
    lines.push(truncateStyledLine(theme.fg("dim", `  ${parts.join(" · ")}`), width));
  }
  return lines;
}

export function formatRun(run: RunSnapshot): string {
  const tokens = run.usage.total.toLocaleString();
  return `${cleanDisplayLine(run.name)} (${run.profileClass}) · ${run.status} · ${cleanDisplayLine(run.effectiveModel ?? "inherit")} · ${cleanDisplayLine(run.effectiveThinking ?? "inherit")}${run.usage.total ? ` · ${tokens} tokens` : ""}${run.usage.cost ? ` · $${run.usage.cost.toFixed(4)}` : ""}`;
}

export function agentViewLines(agents: Iterable<RunSnapshot>): string[] {
  const values = [...agents];
  if (!values.length) return ["No Hackler runs have been started."];
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
    | "validate"
    | "toggleProfile"
    | "ejectProfile"
    | "refresh"
    | "help";
  id?: string;
};

type HubSection = "runs" | "inbox" | "profiles";
const ACTIVE_HUB_STATUSES = new Set(["queued", "starting", "running", "blocked"]);

/** Event-driven native Agent Hub. */
export class AgentsViewer {
  private snapshot: HubSnapshot;
  private section: HubSection = "runs";
  private selected = 0;
  private selectedRunId: string | undefined;
  private snapshotAt = Date.now();
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
    const rows = this.runRows();
    const foregroundIndex = rows.findIndex(({ group }) => group !== "History");
    this.selected = foregroundIndex >= 0 ? foregroundIndex : Math.max(0, rows.length - 1);
    this.selectedRunId = rows[this.selected]?.run.id;
    this.unsubscribe = subscribe((snapshot) => {
      if (this.disposed) return;
      const selectedRunId = this.section === "runs" ? this.selectedRunId : undefined;
      this.snapshot = snapshot;
      this.snapshotAt = Date.now();
      if (selectedRunId) {
        const nextIndex = this.runRows().findIndex(({ run }) => run.id === selectedRunId);
        if (nextIndex >= 0) this.selected = nextIndex;
      }
      this.clampSelection();
      this.syncSelectedRunId();
      this.syncClock();
      this.tui.requestRender();
    });
    this.syncClock();
  }

  private hasPendingRequest(runId: string): boolean {
    return this.snapshot.requests.some(
      (request) => request.fromRunId === runId && request.status === "pending",
    );
  }

  private runRows(): Array<{
    run: RunSnapshot;
    depth: number;
    group: PresentationGroup;
    presentation: ReturnType<typeof presentRun>;
  }> {
    const groups: PresentationGroup[] = ["Attention", "Active", "History"];
    const presentations = new Map(
      this.snapshot.runs.map((run) => [
        run.id,
        presentRun(run, { hasPendingRequest: this.hasPendingRequest(run.id) }),
      ]),
    );
    const rows: Array<{
      run: RunSnapshot;
      depth: number;
      group: PresentationGroup;
      presentation: ReturnType<typeof presentRun>;
    }> = [];
    for (const group of groups) {
      const runs = this.snapshot.runs.filter((run) => presentations.get(run.id)?.group === group);
      const ids = new Set(runs.map((run) => run.id));
      const byParent = new Map<string | undefined, RunSnapshot[]>();
      for (const run of runs) {
        const parent = run.parentId && ids.has(run.parentId) ? run.parentId : undefined;
        byParent.set(parent, [...(byParent.get(parent) ?? []), run]);
      }
      const seen = new Set<string>();
      const visit = (run: RunSnapshot, depth: number) => {
        if (seen.has(run.id)) return;
        seen.add(run.id);
        const presentation = presentations.get(run.id)!;
        rows.push({ run, depth, group, presentation });
        for (const child of byParent.get(run.id) ?? []) visit(child, depth + 1);
      };
      for (const root of byParent.get(undefined) ?? []) visit(root, 0);
      for (const run of runs) visit(run, 0);
    }
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

  private syncSelectedRunId(): void {
    this.selectedRunId =
      this.section === "runs" ? this.runRows()[this.selected]?.run.id : undefined;
  }

  private setSelected(index: number): void {
    this.selected = Math.max(0, Math.min(index, Math.max(0, this.itemsLength() - 1)));
    this.syncSelectedRunId();
  }

  private visibleWindow(length: number): { start: number; end: number } {
    const maximum = Math.max(4, Math.min(7, Math.floor(this.tui.terminal.rows / 4)));
    const start = Math.max(0, Math.min(this.selected - Math.floor(maximum / 2), length - maximum));
    return { start, end: Math.min(length, start + maximum) };
  }

  private elapsedMs(run: RunSnapshot, now: number): number {
    return ACTIVE_HUB_STATUSES.has(run.status)
      ? run.elapsedMs + Math.max(0, now - this.snapshotAt)
      : run.elapsedMs;
  }

  private syncClock(): void {
    const active = this.snapshot.runs.some((run) => ACTIVE_HUB_STATUSES.has(run.status));
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
      this.setSelected(0);
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, Key.home)) {
      this.setSelected(0);
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, Key.end)) {
      this.setSelected(this.itemsLength() - 1);
      this.tui.requestRender();
      return;
    }
    const page = Math.max(4, Math.min(7, Math.floor(this.tui.terminal.rows / 4)));
    if (matchesKey(data, Key.pageUp)) {
      this.setSelected(this.selected - page);
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, Key.pageDown)) {
      this.setSelected(this.selected + page);
      this.tui.requestRender();
      return;
    }
    if (this.keybindings.matches(data, "tui.select.up") || matchesKey(data, Key.up))
      this.setSelected(this.selected - 1);
    else if (this.keybindings.matches(data, "tui.select.down") || matchesKey(data, Key.down))
      this.setSelected(this.selected + 1);
    else if (this.section === "runs") {
      const run = this.runRows()[this.selected]?.run;
      if (!run) return;
      if (matchesKey(data, Key.enter)) {
        const request = this.snapshot.requests
          .filter((candidate) => candidate.fromRunId === run.id && candidate.status === "pending")
          .sort((left, right) => left.createdAt.localeCompare(right.createdAt))[0];
        if (request) return this.close({ kind: "answer", id: request.id });
      }
      if (data === "s" || (matchesKey(data, Key.enter) && run.status === "parked"))
        return this.close({ kind: "steer", id: run.id });
      if (data === "x" && ["queued", "starting", "running", "blocked"].includes(run.status))
        return this.close({ kind: "stop", id: run.id });
      if (
        data === "t" &&
        run.sessionFile &&
        this.snapshot.herdr.enabled &&
        this.snapshot.herdr.available
      )
        return this.close({ kind: "inspect", id: run.id });
    } else if (this.section === "inbox" && data === "v") {
      const request = this.snapshot.requests[this.selected];
      if (
        request?.status === "pending" &&
        request.kind === "integration-ready" &&
        (this.snapshot.validators?.length ?? 0) > 0 &&
        (this.snapshot.validatableRequestIds ?? []).includes(request.id)
      )
        return this.close({ kind: "validate", id: request.id });
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
    const innerWidth = Math.max(1, width - 2);
    const border = (text: string): string => this.theme.fg("borderMuted", text);
    const frame = (line: string): string => {
      const truncated = truncateToWidth(line, innerWidth, "");
      return (
        border("│") +
        truncated +
        " ".repeat(Math.max(0, innerWidth - visibleWidth(truncated))) +
        border("│")
      );
    };
    const itemCount = this.itemsLength();
    const body = [
      this.theme.fg("accent", this.theme.bold(" Agent Hub ")),
      this.tabs(),
      this.theme.fg(
        "dim",
        ` ${this.section} · selected ${itemCount ? this.selected + 1 : 0} of ${itemCount}`,
      ),
      "",
    ];
    if (this.section === "runs") this.renderRuns(body, innerWidth);
    else if (this.section === "inbox") this.renderInbox(body);
    else this.renderProfiles(body);
    const transcriptHint =
      this.snapshot.herdr.enabled && this.snapshot.herdr.available ? ["t transcript"] : [];
    const sectionHints =
      this.section === "runs"
        ? [
            "enter answer blocked/revive parked",
            "s steer/revive",
            "x stop active",
            ...transcriptHint,
          ]
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
    body.push("", this.theme.fg("dim", footer));
    const top = border(`┌${"─".repeat(innerWidth)}┐`);
    const bottom = border(`└${"─".repeat(innerWidth)}┘`);
    return [top, ...body.map(frame), bottom].map((line) => truncateToWidth(line, width, ""));
  }

  private renderRuns(body: string[], width: number): void {
    const now = Date.now();
    const rows = this.runRows();
    const counts = (group: PresentationGroup) => rows.filter((row) => row.group === group).length;
    body.push(
      this.theme.fg(
        "muted",
        ` Slots ${this.snapshot.capacity.used}/${this.snapshot.capacity.limit} · ${this.snapshot.capacity.free} free`,
      ),
      styledJoin(this.theme, [
        { value: `Attention ${counts("Attention")}`, color: "error" },
        { value: `Active ${counts("Active")}`, color: "warning" },
        { value: `History ${counts("History")}`, color: "success" },
      ]),
    );
    if (!rows.length) {
      body.push(
        this.theme.fg(
          "muted",
          " No Hackler runs yet. Dispatch bounded work or start /orchestrate.",
        ),
      );
      return;
    }
    const { start, end } = this.visibleWindow(rows.length);
    if (start > 0) body.push(this.theme.fg("dim", ` … ${start} earlier run(s)`));
    let previousGroup: PresentationGroup | undefined;
    for (let index = start; index < end; index += 1) {
      const { run, depth, group, presentation } = rows[index]!;
      if (group !== previousGroup) {
        body.push(this.theme.fg(presentation.token, ` ${group}`));
        previousGroup = group;
      }
      const selected = index === this.selected;
      const branch = depth > 0 ? `${"  ".repeat(Math.min(depth - 1, 4))}└─ ` : "";
      const prefix = `${selected ? "›" : " "} ${styleHerdrStatus(
        this.theme,
        presentation,
        presentation.icon,
      )} ${branch}`;
      const critical = this.theme.fg(
        "dim",
        `${presentation.state} · ${formatDuration(this.elapsedMs(run, now))}`,
      );
      const suffix = this.theme.fg("dim", " · ") + critical;
      const row =
        visibleWidth(prefix + suffix) >= width
          ? truncateStyledLine(prefix + critical, width)
          : rowWithReservedSuffix(prefix, this.theme.fg("text", presentation.label), suffix, width);
      body.push(selected ? this.theme.bg("selectedBg", row) : row);
    }
    if (end < rows.length) body.push(this.theme.fg("dim", ` … ${rows.length - end} later run(s)`));
    const selectedRow = rows[this.selected];
    if (!selectedRow) return;
    const { run, group, presentation } = selectedRow;
    const pendingRequests = this.snapshot.requests
      .filter((request) => request.fromRunId === run.id && request.status === "pending")
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    const pendingRequest = pendingRequests[0];
    const generation = run.terminationReason?.generation ?? run.activeLeaseGeneration;
    const requiredAction = pendingRequest
      ? `Required action: answer ${cleanDisplayLine(pendingRequest.title)} · enter`
      : run.cleanupFailure
        ? "Required action: review cleanup quarantine"
        : group === "Attention"
          ? `Required action: collect${generation ? ` generation ${generation}` : " this result"}`
          : undefined;
    const context = deriveActivityContext(run);
    body.push("");
    if (requiredAction) body.push(this.theme.fg(presentation.token, requiredAction));
    body.push(
      this.theme.fg(
        "muted",
        `${cleanDisplayLine(run.id)} · ${cleanDisplayLine(run.name)} · ${run.profileClass}`,
      ),
      ...(run.parentId ? [this.theme.fg("dim", `Parent: ${cleanDisplayLine(run.parentId)}`)] : []),
      this.theme.fg("text", `Task: ${taskLabel(run.task, 240)}`),
      this.theme.fg("dim", `Owns: ${cleanDisplayLine(run.ownership.owns.join(", "))}`),
      this.theme.fg("dim", `Deliverable: ${cleanDisplayLine(run.ownership.deliverable)}`),
      this.theme.fg("dim", `Transcript: ${cleanDisplayLine(run.sessionFile ?? "pending")}`),
      this.theme.fg(presentation.token, `State: ${presentation.state}`),
      ...(context.now ? [this.theme.fg("muted", `Now: ${cleanDisplayLine(context.now)}`)] : []),
      ...(context.lastAction
        ? [this.theme.fg("dim", `Last action: ${cleanDisplayLine(context.lastAction)}`)]
        : []),
      ...(group === "Active"
        ? [
            this.theme.fg("dim", formatRun(run)),
            ...operationalFacts(run, now).map((fact) => this.theme.fg("dim", fact)),
          ]
        : []),
    );
    if (pendingRequest)
      body.push(
        this.theme.fg(
          "warning",
          `Request: ${cleanDisplayLine(pendingRequest.title)} · ${formatDuration(
            timestampAge(pendingRequest.createdAt, now) ?? 0,
          )} ago`,
        ),
        ...(pendingRequests.length > 1
          ? [this.theme.fg("dim", `+${pendingRequests.length - 1} more request(s)`)]
          : []),
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
    if (run.terminationReason)
      body.push(this.theme.fg("error", `Termination: ${terminationText(run.terminationReason)}`));
    if (run.error) body.push(this.theme.fg("error", `Error: ${cleanDisplayLine(run.error)}`));
    if (run.cleanupFailure)
      body.push(
        this.theme.fg("error", `Cleanup retained: ${cleanDisplayLine(run.cleanupFailure.message)}`),
      );
    if (run.report) {
      const reportLines = displayLines(run.report);
      body.push(
        this.theme.fg(run.status === "parked" ? "success" : "warning", "Report"),
        ...reportLines.slice(0, 8).map((line) => this.theme.fg("text", `  ${line}`)),
        ...(reportLines.length > 8
          ? [
              this.theme.fg(
                "dim",
                `  … ${reportLines.length - 8} more line(s) · open transcript for complete report`,
              ),
            ]
          : []),
      );
    }
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
        ...(request.status === "pending" &&
        request.kind === "integration-ready" &&
        (this.snapshot.validators?.length ?? 0) > 0 &&
        (this.snapshot.validatableRequestIds ?? []).includes(request.id)
          ? [this.theme.fg("dim", `v validates with a trusted configured command`)]
          : []),
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

function expandHint(): string {
  try {
    return keyHint("app.tools.expand", "to expand");
  } catch {
    return "Ctrl+O to expand";
  }
}

function expandedShell(content: string, theme: Theme, outputPad: number): Component {
  const box = new Box(outputPad, 1, (text) => theme.bg("customMessageBg", text));
  box.addChild(new Text(content, 0, 0));
  return box;
}

function compactShell(
  buildLines: (width: number) => string[],
  theme: Theme,
  outputPad: number,
): Component {
  return {
    render(width: number): string[] {
      if (width <= 0) return [];
      const padding = Math.min(Math.max(0, outputPad), Math.floor(width / 2));
      const innerWidth = Math.max(0, width - padding * 2);
      const blank = theme.bg("customMessageBg", " ".repeat(width));
      const lines = buildLines(innerWidth).map((line) => {
        const content = truncateToWidth(line, innerWidth, "");
        const padded =
          " ".repeat(padding) +
          content +
          " ".repeat(Math.max(0, width - padding - visibleWidth(content)));
        return theme.bg("customMessageBg", truncateToWidth(padded, width, ""));
      });
      return [blank, ...lines, blank];
    },
    invalidate(): void {
      // buildLines reapplies the current theme callbacks on the next render.
    },
  };
}

type CompletionRun = {
  id: string;
  name: string;
  profileClass?: RunSnapshot["profileClass"];
  task: string;
  ownership: { key?: string; owns: string[] };
  status: RunSnapshot["status"];
  elapsedMs?: number;
  activeLeaseGeneration?: number;
  completionAcknowledgedGeneration?: number;
  terminationReason?: RunSnapshot["terminationReason"];
  report?: string;
  error?: string;
  cleanupFailure?: RunSnapshot["cleanupFailure"];
  sessionFile?: string;
  sessionDir?: string;
  activity?: RunSnapshot["activity"];
  effectiveModel?: string;
  usage?: RunSnapshot["usage"];
};

function completionSummary(run: CompletionRun, theme: Theme, width: number): string {
  const presentation = presentRun(run);
  const reason = terminationText(run.terminationReason);
  const evidence = [
    ...(reason ? [reason] : []),
    ...(run.error ? [cleanDisplayLine(run.error)] : []),
    ...(run.report ? [taskLabel(run.report, 180)] : []),
  ];
  return rowWithReservedSuffix(
    `${styleHerdrStatus(theme, presentation, presentation.icon)} `,
    theme.fg("text", runDisplayLabel(run)),
    theme.fg(
      "dim",
      ` · ${presentation.state}${evidence.length ? ` · ${evidence.join(" · ")}` : ""}`,
    ),
    width,
  );
}

export function aggregateCompletionMessageRenderer(
  details: unknown,
  expanded: boolean,
  theme: Theme,
  outputPad = 0,
): Component | undefined {
  const value = details as
    | { schemaVersion?: number; batch?: DispatchBatch; runs?: RunSnapshot[] }
    | undefined;
  if (value?.schemaVersion !== 3 || !value.batch) return undefined;
  const batch = value.batch;
  const fallbackRuns = value.runs ?? [];
  const runs: CompletionRun[] = batch.results.length
    ? batch.results.map((result) => {
        const matching = fallbackRuns.find((run) => {
          if (run.id !== result.runId) return false;
          const generation = run.terminationReason?.generation ?? run.activeLeaseGeneration;
          return generation === undefined || generation === result.generation;
        });
        return (
          result.snapshot ??
          matching ?? {
            id: cleanDisplayLine(result.runId) || "unknown-run",
            name: cleanDisplayLine(result.runId) || "Hackler",
            task: `Generation ${result.generation}`,
            ownership: { key: cleanDisplayLine(result.runId), owns: [] },
            status: result.status,
            activeLeaseGeneration: result.generation,
            terminationReason: result.terminationReason,
            report: result.report,
            error: result.error,
            cleanupFailure: result.cleanupFailure,
          }
        );
      })
    : fallbackRuns;
  const failures = runs.filter((run) => run.status === "failed").length;
  const stopped = runs.filter((run) => run.status === "stopped").length;
  const headingToken = failures || stopped ? "error" : "success";
  const headingText = `Hackler results · ${runs.length}${failures ? ` · ${failures} failed` : ""}${stopped ? ` · ${stopped} stopped` : ""}`;
  if (!expanded) {
    return compactShell(
      (width) => {
        const shown = runs.slice(0, 4);
        const omitted = Math.max(0, runs.length - shown.length);
        const history = runs.filter((run) => presentationGroup(run) === "History").length;
        return [
          theme.fg(headingToken, headingText),
          ...shown.map((run) => completionSummary(run, theme, width)),
          ...(omitted || history
            ? [
                theme.fg(
                  "dim",
                  [
                    ...(omitted ? [`+${omitted} omitted`] : []),
                    ...(history ? [`○ ${history} History`] : []),
                  ].join(" · "),
                ),
              ]
            : []),
          theme.fg("dim", expandHint()),
        ];
      },
      theme,
      outputPad,
    );
  }
  return expandedShell(
    [
      theme.fg(headingToken, headingText),
      theme.fg("dim", `${batch.id} · sequence ${batch.sequence} · route ${batch.route}`),
      ...runs.map((run) => {
        const presentation = presentRun(run);
        const reason = terminationText(run.terminationReason);
        const failureEvidence =
          run.status === "failed" || run.status === "stopped"
            ? [
                theme.fg(
                  "error",
                  `${run.status === "failed" ? "Failure" : "Stopped"}${reason ? ` · ${reason}` : ""}`,
                ),
                ...(run.error ? [theme.fg("error", `Error\n${safeDisplayText(run.error)}`)] : []),
                ...(run.cleanupFailure
                  ? [
                      theme.fg(
                        "error",
                        `Cleanup retained\n${safeDisplayText(run.cleanupFailure.message)}`,
                      ),
                    ]
                  : []),
                ...(run.report
                  ? [`${theme.fg("warning", "Partial report")}\n${safeDisplayText(run.report)}`]
                  : []),
              ]
            : [
                ...(run.cleanupFailure
                  ? [
                      theme.fg(
                        "error",
                        `Cleanup retained\n${safeDisplayText(run.cleanupFailure.message)}`,
                      ),
                    ]
                  : []),
                run.report
                  ? `${theme.fg("success", "Report")}\n${safeDisplayText(run.report)}`
                  : safeDisplayText(run.error || "(no report)"),
              ];
        return [
          theme.fg("text", safeDisplayText(run.task)),
          `${styleHerdrStatus(theme, presentation, presentation.icon)} ${theme.fg(
            presentation.token,
            `${run.name} · ${presentation.state}`,
          )}`,
          theme.fg("dim", `Run: ${cleanDisplayLine(run.id)}`),
          theme.fg("dim", `Owns: ${cleanDisplayLine(run.ownership.owns.join(", "))}`),
          ...failureEvidence,
        ].join("\n");
      }),
    ].join("\n\n"),
    theme,
    outputPad,
  );
}

export function completionMessageRenderer(
  details: unknown,
  expanded: boolean,
  theme: Theme,
  outputPad = 0,
): Component | undefined {
  const run = (details as { run?: RunSnapshot } | undefined)?.run;
  if (!run) return undefined;
  const presentation = presentRun(run);
  const reason = terminationText(run.terminationReason);
  const usage = theme.fg(
    "dim",
    `${cleanDisplayLine(run.effectiveModel ?? "inherited model")} · ${formatDuration(run.elapsedMs)} · ${run.usage.total.toLocaleString()} tokens${run.usage.cost ? ` · $${run.usage.cost.toFixed(4)}` : ""}`,
  );
  if (!expanded)
    return compactShell(
      (width) => [
        theme.fg(presentation.token, "Hackler result"),
        completionSummary(run, theme, width),
        theme.fg("dim", expandHint()),
      ],
      theme,
      outputPad,
    );
  const failureEvidence = [
    ...(reason ? [theme.fg("error", `Reason: ${reason}`)] : []),
    ...(run.error ? [theme.fg("error", `Error\n${safeDisplayText(run.error)}`)] : []),
    ...(run.cleanupFailure
      ? [theme.fg("error", `Cleanup retained\n${safeDisplayText(run.cleanupFailure.message)}`)]
      : []),
  ];
  return expandedShell(
    [
      theme.fg("text", safeDisplayText(run.task)),
      `${styleHerdrStatus(theme, presentation, presentation.icon)} ${theme.fg(
        presentation.token,
        `${run.profileClass} · ${presentation.state}`,
      )}`,
      theme.fg("dim", `Run: ${cleanDisplayLine(run.id)}`),
      theme.fg("dim", `Owns: ${cleanDisplayLine(run.ownership.owns.join(", "))}`),
      theme.fg("dim", `Transcript: ${cleanDisplayLine(run.sessionFile ?? run.sessionDir)}`),
      usage,
      ...failureEvidence,
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
      run.report
        ? `${theme.fg(
            run.status === "parked" ? "success" : "warning",
            run.status === "parked" ? "Report" : "Partial report",
          )}\n${safeDisplayText(run.report)}`
        : "",
    ]
      .filter(Boolean)
      .join("\n\n"),
    theme,
    outputPad,
  );
}

export function fitsMetadata(row: string, width: number): boolean {
  return visibleWidth(row) <= width;
}
