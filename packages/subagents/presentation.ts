import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { RunStatus } from "./types.js";

export type PresentationGroup = "Attention" | "Active" | "History";
export type HerdrIcon = "×" | "◐" | "✓" | "○";
export type HerdrToken = "error" | "warning" | "success";

export type PresentableActivity = {
  kind?: string;
  text: string;
};

export type PresentableOperation = {
  kind:
    | "startup"
    | "worktree"
    | "transport"
    | "model"
    | "tool"
    | "supervisor"
    | "finalization"
    | "cleanup";
  name?: string;
};

export type PresentableRun = {
  id: string;
  name?: string;
  profileClass?: string;
  status: RunStatus;
  taskKey?: string;
  ownership?: { key?: string };
  wrappingUp?: boolean;
  activeLeaseGeneration?: number;
  terminationReason?: { generation: number };
  completionAcknowledgedGeneration?: number;
  cleanupFailure?: { message?: string };
  currentTool?: string;
  currentOperation?: PresentableOperation;
  activity?: PresentableActivity[];
  latestActivity?: string;
  lastAction?: string;
  attentionReason?: string;
  group?: "Attention" | "Active";
};

export type RunPresentation = {
  group: PresentationGroup;
  icon: HerdrIcon;
  token: HerdrToken;
  state: string;
  priority: number;
  label: string;
  attentionReason?: string;
};

const TERMINAL_ESCAPE = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\)?)/gu;
const INITIALISMS = new Map([
  ["api", "API"],
  ["ui", "UI"],
  ["tui", "TUI"],
  ["rpc", "RPC"],
  ["sdk", "SDK"],
  ["pi", "Pi"],
]);

export function cleanDisplayLine(value: string): string {
  return value
    .replace(TERMINAL_ESCAPE, "")
    .replace(/[\p{Cc}\p{Cf}]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

export function displayLines(value: string): string[] {
  return value.split(/\r\n|[\n\r\u2028\u2029]/u).map(cleanDisplayLine);
}

export function safeDisplayText(value: string): string {
  return displayLines(value).join("\n");
}

function capitalize(value: string): string {
  return value ? value[0]!.toLocaleUpperCase() + value.slice(1).toLocaleLowerCase() : value;
}

/** Turn a stable task key into a compact sentence-style display label. */
export function humanizeTaskKey(value: string): string {
  const clean = cleanDisplayLine(value)
    .replace(/([\p{Lu}]+)([\p{Lu}][\p{Ll}])/gu, "$1 $2")
    .replace(/([\p{Ll}\d])([\p{Lu}])/gu, "$1 $2")
    .replace(/[_./:-]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (!clean) return "";
  return clean
    .split(" ")
    .filter(Boolean)
    .map((word, index) => {
      const initialism = INITIALISMS.get(word.toLocaleLowerCase());
      if (initialism) return initialism;
      return index === 0 ? capitalize(word) : word.toLocaleLowerCase();
    })
    .join(" ");
}

export function runDisplayLabel(run: PresentableRun): string {
  const key = cleanDisplayLine(run.taskKey ?? run.ownership?.key ?? "");
  const humanized = humanizeTaskKey(key);
  if (humanized && key !== run.id) return humanized;
  const profile = humanizeTaskKey(run.name ?? run.profileClass ?? "Hackler") || "Hackler";
  const id =
    cleanDisplayLine(run.id).replace(/-{2,}/gu, "-").replace(/_{2,}/gu, "_") || "unknown run";
  return `${profile} · ${id}`;
}

export function isTerminalStatus(status: RunStatus): boolean {
  return status === "parked" || status === "failed" || status === "stopped";
}

export function terminalGeneration(run: PresentableRun): number | undefined {
  return (
    run.terminationReason?.generation ??
    run.activeLeaseGeneration ??
    (isTerminalStatus(run.status) ? run.completionAcknowledgedGeneration : undefined)
  );
}

export function isTerminalGenerationAcknowledged(run: PresentableRun): boolean {
  const generation = terminalGeneration(run);
  return (
    isTerminalStatus(run.status) &&
    generation !== undefined &&
    run.completionAcknowledgedGeneration === generation
  );
}

export function presentationGroup(
  run: PresentableRun,
  hasPendingRequest = false,
): PresentationGroup {
  if (run.group === "Attention") return "Attention";
  if (run.cleanupFailure || run.status === "blocked" || hasPendingRequest) return "Attention";
  if (isTerminalStatus(run.status))
    return isTerminalGenerationAcknowledged(run) ? "History" : "Attention";
  return "Active";
}

function stateForRun(
  run: PresentableRun,
  group: PresentationGroup,
  hasPendingRequest: boolean,
): string {
  if (run.cleanupFailure) return "cleanup failed";
  if (run.status === "blocked") return "blocked";
  if (run.status === "failed") return "failed";
  if (run.status === "stopped") return "stopped";
  if (run.status === "parked") return group === "History" ? "done" : "ready";
  if (hasPendingRequest || (run.group === "Attention" && run.attentionReason)) return "attention";
  if (run.status === "queued") return "queued";
  if (run.status === "starting") return "starting";
  if (run.wrappingUp) return "wrapping up";
  if (run.currentOperation?.kind === "finalization") return "finalizing";
  if (run.currentOperation?.kind === "cleanup") return "cleaning up";
  if (
    run.currentOperation?.kind === "worktree" &&
    /integrat(?:e|ing|ion)|captur(?:e|ing).*candidate/iu.test(run.currentOperation.name ?? "")
  )
    return "integrating";
  return "working";
}

function attentionReasonForRun(
  run: PresentableRun,
  hasPendingRequest: boolean,
): string | undefined {
  const supplied = cleanDisplayLine(run.attentionReason ?? "");
  if (supplied) return supplied;
  if (run.cleanupFailure) return "cleanup failed";
  if (run.status === "blocked" || hasPendingRequest) return "response required";
  if (isTerminalStatus(run.status) && !isTerminalGenerationAcknowledged(run))
    return "collect result";
  return undefined;
}

/** Central Herdr icon, token, state, grouping, and priority model. */
export function presentRun(
  run: PresentableRun,
  options: { hasPendingRequest?: boolean } = {},
): RunPresentation {
  const hasPendingRequest = options.hasPendingRequest === true;
  const group = presentationGroup(run, hasPendingRequest);
  const isFailure =
    Boolean(run.cleanupFailure) ||
    run.status === "blocked" ||
    run.status === "failed" ||
    run.status === "stopped" ||
    hasPendingRequest ||
    (run.group === "Attention" && !isTerminalStatus(run.status));
  const icon: HerdrIcon = isFailure
    ? "×"
    : group === "Active"
      ? "◐"
      : group === "Attention"
        ? "✓"
        : "○";
  const token: HerdrToken = isFailure ? "error" : group === "Active" ? "warning" : "success";
  const state = stateForRun(run, group, hasPendingRequest);
  const withinGroup =
    run.cleanupFailure || run.status === "blocked"
      ? 0
      : hasPendingRequest
        ? 1
        : isTerminalStatus(run.status)
          ? 2
          : run.wrappingUp
            ? 0
            : run.status === "starting" || run.status === "queued"
              ? 1
              : 2;
  const groupPriority = group === "Attention" ? 0 : group === "Active" ? 10 : 20;
  return {
    group,
    icon,
    token,
    state,
    priority: groupPriority + withinGroup,
    label: runDisplayLabel(run),
    attentionReason: attentionReasonForRun(run, hasPendingRequest),
  };
}

export function styleHerdrStatus(
  theme: Pick<Theme, "fg">,
  status: Pick<RunPresentation, "token">,
  text: string,
): string {
  return theme.fg(status.token, text);
}

export function lifecycleOperationLabel(
  operation: PresentableOperation | undefined,
): string | undefined {
  if (!operation) return undefined;
  switch (operation.kind) {
    case "startup":
      return "startup";
    case "worktree":
      return /integrat(?:e|ing|ion)|captur(?:e|ing).*candidate/iu.test(operation.name ?? "")
        ? "integration"
        : "worktree setup";
    case "transport":
      return "transport";
    case "model":
      return "model turn";
    case "tool":
      return cleanDisplayLine(operation.name ?? "") || "tool";
    case "supervisor":
      return "supervisor request";
    case "finalization":
      return "finalization";
    case "cleanup":
      return "cleanup";
  }
}

function sameActivity(left: string, right: string): boolean {
  return cleanDisplayLine(left).toLocaleLowerCase() === cleanDisplayLine(right).toLocaleLowerCase();
}

/** Derive safe current and previous activity without exposing tool arguments. */
export function deriveActivityContext(run: PresentableRun): {
  currentTool?: string;
  now?: string;
  lastAction?: string;
} {
  const currentTool = cleanDisplayLine(run.currentTool ?? "") || undefined;
  const now = currentTool ?? lifecycleOperationLabel(run.currentOperation);
  const explicitLast = cleanDisplayLine(run.lastAction ?? "");
  const attentionReason = cleanDisplayLine(run.attentionReason ?? "");
  const safeActivity = (entry: PresentableActivity): string =>
    entry.kind === "steer" ? "steering guidance sent" : cleanDisplayLine(entry.text);
  const activity = run.activity ?? [];
  const latestActivity =
    activity.at(-1)?.kind === "steer"
      ? "steering guidance sent"
      : cleanDisplayLine(run.latestActivity ?? "");
  const candidates = [
    ...(explicitLast ? [explicitLast] : []),
    ...(attentionReason ? [attentionReason] : []),
    ...[...activity].reverse().map(safeActivity),
    latestActivity,
  ].filter(Boolean);
  const lastAction = candidates.find((candidate) => {
    if (now && sameActivity(candidate, now)) return false;
    if (currentTool && sameActivity(candidate, `started ${currentTool}`)) return false;
    return true;
  });
  return { currentTool, now, lastAction };
}

/** Keep a styled suffix intact by spending the remaining width on the label first. */
export function rowWithReservedSuffix(
  prefix: string,
  label: string,
  suffix: string,
  width: number,
): string {
  if (width <= 0) return "";
  const reservedWidth = visibleWidth(prefix) + visibleWidth(suffix);
  if (reservedWidth >= width) return truncateToWidth(prefix + suffix, width, "");
  const labelWidth = width - reservedWidth;
  return truncateToWidth(
    prefix + truncateToWidth(label, labelWidth, labelWidth > 1 ? "…" : "") + suffix,
    width,
    "",
  );
}

/** Render current activity before optional previous activity, truncating previous activity first. */
export function activityContextLine(
  context: { now?: string; lastAction?: string },
  theme: Pick<Theme, "fg">,
  width: number,
): string | undefined {
  if (width <= 0) return undefined;
  const now = cleanDisplayLine(context.now ?? "");
  const last = cleanDisplayLine(context.lastAction ?? "");
  if (!now && !last) return undefined;
  const indent = "  ";
  const nowText = now ? `now: ${now}` : "";
  const lastPrefix = now ? " · last: " : "last: ";
  const base = indent + nowText;
  const baseWidth = visibleWidth(base);
  const availableForLast = width - baseWidth - visibleWidth(lastPrefix);
  let plain: string;
  if (last && availableForLast > 0) {
    plain =
      base + lastPrefix + truncateToWidth(last, availableForLast, availableForLast > 1 ? "…" : "");
  } else if (now) {
    plain = truncateToWidth(base, width, "");
  } else {
    plain = truncateToWidth(`${indent}last: ${last}`, width, "");
  }
  return truncateToWidth(theme.fg("dim", plain), width, "");
}

export function truncateStyledLine(line: string, width: number): string {
  return width > 0 ? truncateToWidth(line, width, "") : "";
}
