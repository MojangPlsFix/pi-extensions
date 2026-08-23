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
import type { DispatchBatch, RunSnapshot, RunStatus } from "./types.js";

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

const HACKLER_LABEL = "Hackler";
export const QUIET_EVENT_AGE_MS = 30_000;

function colorForStatus(status: RunStatus): "muted" | "success" | "warning" | "error" | "dim" {
  if (status === "running" || status === "starting" || status === "queued") return "muted";
  if (status === "parked") return "success";
  if (status === "blocked") return "warning";
  if (status === "failed") return "error";
  return "dim";
}

function timestampAge(value: string | undefined, now: number): number | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? Math.max(0, now - parsed) : undefined;
}

function operationalState(run: SubagentsStatusEvent["agents"][number], now: number): string {
  if (run.status === "blocked") return "blocked";
  if (run.status === "failed") return "failed";
  if (run.status === "stopped") return "stopped";
  if (run.status === "parked") return "done (parked)";
  if (run.status === "queued" || run.status === "starting") return "starting";
  if (run.wrappingUp) return "wrapping up";
  const age = timestampAge(run.lastEventAt, now);
  return age !== undefined && age >= QUIET_EVENT_AGE_MS
    ? `quiet · no event for ${formatDuration(age)}`
    : "working";
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
  now = Date.now(),
): string[] {
  if (width <= 0 || status.agents.length === 0) return [];
  const safe = (line: string) => truncateToWidth(line, width, "");
  const priority = (agent: SubagentsStatusEvent["agents"][number]): number =>
    agent.status === "blocked"
      ? 0
      : agent.wrappingUp
        ? 1
        : agent.status === "failed"
          ? 2
          : agent.status === "stopped"
            ? 3
            : agent.status === "starting" || agent.status === "queued"
              ? 4
              : agent.status === "running"
                ? 5
                : 6;
  const ordered = status.agents
    .map((agent, index) => ({ agent, index }))
    .sort((left, right) => priority(left.agent) - priority(right.agent) || left.index - right.index)
    .map(({ agent }) => agent);
  const shown = ordered.slice(0, 4);
  const lines = [
    safe(
      theme.fg(
        "muted",
        `${HACKLER_LABEL} · slots ${status.capacity.used}/${status.capacity.limit} used · ${status.capacity.free} free · shared writer ${status.capacity.sharedWritersUsed}/${status.capacity.sharedWritersLimit}`,
      ),
    ),
    safe(
      theme.fg(
        "dim",
        `  running ${status.running} · wrapping ${status.wrappingUp} · blocked ${status.blocked} · failed ${status.failed} · stopped ${status.stopped}`,
      ),
    ),
  ];
  if (status.oldestBlockingRequest) {
    const requestAge = timestampAge(status.oldestBlockingRequest.createdAt, now) ?? 0;
    lines.push(
      safe(
        theme.fg(
          "warning",
          `  oldest block: ${taskLabel(status.oldestBlockingRequest.title, 80)} · ${formatDuration(requestAge)} ago · action: ${cleanDisplayLine(status.oldestBlockingRequest.action)}${(status.blockingRequestCount ?? 1) > 1 ? ` · +${(status.blockingRequestCount ?? 1) - 1} more request(s)` : ""}`,
        ),
      ),
    );
  }
  for (const [index, agent] of shown.entries()) {
    const isLastShown = index === shown.length - 1;
    const connector = theme.fg("dim", isLastShown ? "  └─ " : "  ├─ ");
    const continuation = theme.fg("dim", isLastShown ? "     " : "  │  ");
    lines.push(safe(connector + theme.fg("text", taskLabel(agent.task))));
    const state = operationalState(agent, now);
    const metadata = styledJoin(theme, [
      { value: agent.profileClass ?? "agent", color: "dim" },
      { value: state, color: colorForStatus(agent.status) },
      { value: shortModel(agent.effectiveModel), color: "dim" },
      { value: formatDuration(agent.elapsedMs), color: "dim" },
      ...(agent.latestActivity
        ? [{ value: taskLabel(agent.latestActivity, 80), color: colorForStatus(agent.status) }]
        : []),
    ]);
    lines.push(safe(continuation + metadata));
    lines.push(safe(continuation + theme.fg("dim", operationalFacts(agent, now).join(" · "))));
  }
  const overflow = Math.max(0, status.total - shown.length);
  if (overflow) lines.push(safe(theme.fg("dim", `  +${overflow} more`)));
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
    | "toggleProfile"
    | "ejectProfile"
    | "refresh"
    | "help";
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
      if (matchesKey(data, Key.enter) && run.status === "blocked") {
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
    if (this.section === "runs") this.renderRuns(body);
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

  private renderRuns(body: string[]): void {
    const now = Date.now();
    const running = this.snapshot.runs.filter((run) =>
      ["queued", "starting", "running"].includes(run.status),
    ).length;
    const wrapping = this.snapshot.runs.filter(
      (run) => ["queued", "starting", "running", "blocked"].includes(run.status) && run.wrappingUp,
    ).length;
    const blocked = this.snapshot.runs.filter((run) => run.status === "blocked").length;
    const failed = this.snapshot.runs.filter((run) => run.status === "failed").length;
    const stopped = this.snapshot.runs.filter((run) => run.status === "stopped").length;
    body.push(
      this.theme.fg(
        "muted",
        ` Slots ${this.snapshot.capacity.used}/${this.snapshot.capacity.limit} used · ${this.snapshot.capacity.free} free · shared writer ${this.snapshot.capacity.sharedWritersUsed}/${this.snapshot.capacity.sharedWritersLimit}`,
      ),
      this.theme.fg(
        "dim",
        ` Running ${running} · wrapping ${wrapping} · blocked ${blocked} · failed ${failed} · stopped ${stopped}`,
      ),
      this.theme.fg(
        "dim",
        ` Top-level batches ${this.snapshot.batchCounts.open} open · ${this.snapshot.batchCounts.ready} ready · ${this.snapshot.batchCounts.inFlight} in-flight`,
      ),
    );
    const oldestBlock = this.snapshot.requests
      .filter((request) => request.blocking && request.status === "pending")
      .sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt))[0];
    if (oldestBlock)
      body.push(
        this.theme.fg(
          "warning",
          ` Oldest block: ${cleanDisplayLine(oldestBlock.title)} · ${formatDuration(timestampAge(oldestBlock.createdAt, now) ?? 0)} ago · action: tab to inbox, enter to answer`,
        ),
      );
    if (!this.snapshot.runs.length) {
      body.push(
        this.theme.fg(
          "muted",
          " No Hackler runs yet. Dispatch bounded work or start /orchestrate.",
        ),
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
      const row = `${selected ? "›" : " "} ${branch}${taskLabel(run.task)}  ${run.profileClass} · ${operationalState(run, now)} · ${formatDuration(run.elapsedMs)}`;
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
      this.theme.fg("muted", `State: ${operationalState(run, now)}`),
      ...operationalFacts(run, now).map((fact) => this.theme.fg("dim", fact)),
      this.theme.fg("muted", `Activity: ${cleanDisplayLine(run.latestActivity ?? "not recorded")}`),
    );
    const blockingRequests = this.snapshot.requests
      .filter(
        (request) =>
          request.fromRunId === run.id && request.blocking && request.status === "pending",
      )
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    const blockingRequest = blockingRequests[0];
    if (blockingRequest)
      body.push(
        this.theme.fg(
          "warning",
          `Blocking request: ${cleanDisplayLine(blockingRequest.title)} · ${formatDuration(timestampAge(blockingRequest.createdAt, now) ?? 0)} ago · action: enter to answer`,
        ),
        ...(blockingRequests.length > 1
          ? [this.theme.fg("dim", `+${blockingRequests.length - 1} more request(s)`)]
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
    if (run.activity.length)
      body.push(
        this.theme.fg("dim", "Recent activity"),
        ...run.activity
          .slice(-4)
          .map((entry) =>
            this.theme.fg("dim", `  ${entry.kind} · ${cleanDisplayLine(entry.text)}`),
          ),
      );
    if (run.terminationReason)
      body.push(this.theme.fg("error", `Termination: ${terminationText(run.terminationReason)}`));
    if (run.error) body.push(this.theme.fg("error", `Error: ${cleanDisplayLine(run.error)}`));
    if (run.report)
      body.push(
        this.theme.fg("success", "Report"),
        ...displayLines(run.report)
          .slice(0, 8)
          .map((line) => this.theme.fg("text", `  ${line}`)),
      );
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
  const runs = batch.results.length
    ? batch.results.map(
        (result) =>
          result.snapshot ?? {
            name: result.runId,
            task: `Generation ${result.generation}`,
            ownership: { owns: [] },
            status: result.status,
            terminationReason: result.terminationReason,
            report: result.report,
            error: result.error,
            cleanupFailure: result.cleanupFailure,
          },
      )
    : (value.runs ?? []);
  const shell = (content: string): Component => {
    const box = new Box(outputPad, 1, (text) => theme.bg("customMessageBg", text));
    box.addChild(new Text(content, 0, 0));
    return box;
  };
  const failures = runs.filter((run) => run.status === "failed").length;
  const stopped = runs.filter((run) => run.status === "stopped").length;
  const heading = theme.fg(
    failures ? "error" : stopped ? "warning" : "success",
    `Hackler batch · ${runs.length} result${runs.length === 1 ? "" : "s"}${failures ? ` · ${failures} failed` : ""}${stopped ? ` · ${stopped} stopped` : ""}`,
  );
  if (!expanded) {
    const lines = runs.map((run) => {
      const reason = run.terminationReason?.code;
      const evidence = run.status === "failed" ? run.error || run.report : run.report || run.error;
      return `${run.status === "parked" ? "✓" : run.status === "failed" ? "!" : "○"} ${cleanDisplayLine(run.name)} · ${run.status}${reason ? ` · ${reason}` : ""}${evidence ? ` · ${taskLabel(evidence, 140)}` : ""}`;
    });
    return shell([heading, ...lines].join("\n"));
  }
  return shell(
    [
      heading,
      theme.fg("dim", `${batch.id} · sequence ${batch.sequence} · route ${batch.route}`),
      ...runs.map((run) => {
        const reason = terminationText(run.terminationReason);
        const report =
          run.status === "failed"
            ? `${theme.fg("error", `Failure${reason ? ` · ${reason}` : ""}${run.error ? ` · ${safeDisplayText(run.error)}` : ""}`)}${run.report ? `\n\n${theme.fg("warning", "Partial report")}\n${safeDisplayText(run.report)}` : ""}`
            : run.status === "stopped"
              ? `${theme.fg("warning", `Stopped${reason ? ` · ${reason}` : ""}`)}${run.report ? `\n\n${theme.fg("warning", "Partial report")}\n${safeDisplayText(run.report)}` : ""}`
              : safeDisplayText(run.report || run.error || "(no report)");
        return `${theme.fg("text", `${safeDisplayText(run.task)}\n${run.name} · ${run.status}`)}\n${theme.fg("dim", `Owns: ${cleanDisplayLine(run.ownership.owns.join(", "))}`)}\n${report}${run.cleanupFailure ? `\n${theme.fg("error", `Cleanup retained: ${safeDisplayText(run.cleanupFailure.message)}`)}` : ""}`;
      }),
    ].join("\n\n"),
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
  const shell = (content: string): Component => {
    const box = new Box(outputPad, 1, (text) => theme.bg("customMessageBg", text));
    box.addChild(new Text(content, 0, 0));
    return box;
  };
  const title = theme.fg("text", taskLabel(run.task));
  const state = theme.fg(
    colorForStatus(run.status),
    `${run.profileClass} · ${operationalState(run, Date.now())}`,
  );
  const reason = terminationText(run.terminationReason);
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
        reason ? theme.fg(run.status === "parked" ? "success" : "error", `Reason: ${reason}`) : "",
        run.error ? theme.fg("error", taskLabel(run.error, 240)) : "",
        run.report ? theme.fg("muted", taskLabel(run.report, 240)) : theme.fg("muted", "No report"),
      ]
        .filter(Boolean)
        .join("\n"),
    );
  return shell(
    [
      theme.fg("text", safeDisplayText(run.task)),
      state,
      theme.fg("dim", `Owns: ${cleanDisplayLine(run.ownership.owns.join(", "))}`),
      theme.fg("dim", `Transcript: ${cleanDisplayLine(run.sessionFile ?? run.sessionDir)}`),
      usage,
      reason ? theme.fg(run.status === "parked" ? "success" : "error", `Reason: ${reason}`) : "",
      run.error ? theme.fg("error", `Error\n${safeDisplayText(run.error)}`) : "",
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
    ]
      .filter(Boolean)
      .join("\n\n"),
  );
}

export function fitsMetadata(row: string, width: number): boolean {
  return visibleWidth(row) <= width;
}
