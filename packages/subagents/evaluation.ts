import type { SupervisorRequestKind, SupervisorRequestStatus } from "./supervisor.js";
import type {
  EffectiveRunLimits,
  RunActivityKind,
  RunnerKind,
  RunStatus,
  StatusTransition,
  StructuredTerminationReason,
  TerminationReasonCode,
  Usage,
} from "./types.js";

export type EvaluationLeaseV1 = {
  id: string;
  generation: number;
  startedAt: string;
  acceptedAt?: string;
  wrapAt: string;
  deadlineAt: string;
  wrapTriggeredAt?: string;
  wrapCause?: "wall" | "turn";
  endedAt?: string;
  endReason?: TerminationReasonCode;
  effectiveLimits: EffectiveRunLimits;
};

export type EvaluationTransitionCauseV1 =
  | "allocation"
  | "accepted"
  | "supervisor_request"
  | "requests_resolved"
  | "revival"
  | "completed"
  | "wall_limit"
  | "turn_limit"
  | "token_limit"
  | "cost_limit"
  | "explicit_stop"
  | "parent_shutdown"
  | "session_change"
  | "startup_error"
  | "runner_error"
  | "ancestor_terminated"
  | "legacy_restore"
  | "legacy_unknown";

export type EvaluationStatusTransitionV1 = Omit<StatusTransition, "cause"> & {
  cause: EvaluationTransitionCauseV1;
};

export type EvaluationRunV1 = {
  id: string;
  runner: RunnerKind;
  status: RunStatus;
  leases: EvaluationLeaseV1[];
  statusTransitions: EvaluationStatusTransitionV1[];
  turns: number;
  usage: Usage;
  terminalReason?: StructuredTerminationReason;
};

export type EvaluationCapacityPointV1 = {
  at: string;
  used: number;
  limit: number;
  sharedWritersUsed: number;
  sharedWritersLimit: number;
};

export type EvaluationRequestV1 = {
  id: string;
  runId: string;
  kind: SupervisorRequestKind;
  createdAt: string;
  resolvedAt?: string;
  status: SupervisorRequestStatus;
};

export type EvaluationActivityV1 = {
  runId: string;
  kind: RunActivityKind;
  at: string;
};

export type EvaluationBenchmarkTaskV1 = {
  id: string;
  dependencies: string[];
  readyAt: string;
  startedAt?: string;
  endedAt?: string;
};

export type EvaluationBenchmarkFixtureV1 = {
  tasks: EvaluationBenchmarkTaskV1[];
};

export type EvaluationTraceV1 = {
  schemaVersion: 1;
  generatedAt: string;
  runs: EvaluationRunV1[];
  capacityTimeline: EvaluationCapacityPointV1[];
  requests: EvaluationRequestV1[];
  activities: EvaluationActivityV1[];
  benchmark?: EvaluationBenchmarkFixtureV1;
};

/**
 * This source type is intentionally structural. The builder reads only these fields and never
 * spreads source records, which keeps task, report, path, and request text out of the trace.
 */
export type EvaluationRunSourceV1 = {
  id: string;
  runner: RunnerKind;
  status: RunStatus;
  leaseHistory?: readonly EvaluationLeaseV1[];
  leases?: readonly EvaluationLeaseV1[];
  statusTransitions?: readonly StatusTransition[];
  turns?: number;
  usage?: Partial<Usage>;
  terminationReason?: StructuredTerminationReason;
  terminalReason?: StructuredTerminationReason;
};

export type EvaluationRequestSourceV1 = {
  id: string;
  fromRunId?: string;
  runId?: string;
  kind: SupervisorRequestKind;
  createdAt: string;
  resolvedAt?: string;
  status: SupervisorRequestStatus;
};

export type EvaluationTraceInputV1 = {
  generatedAt?: string;
  runs?: readonly EvaluationRunSourceV1[];
  capacityTimeline?: readonly EvaluationCapacityPointV1[];
  requests?: readonly EvaluationRequestSourceV1[];
  activities?: readonly EvaluationActivityV1[];
  benchmark?: EvaluationBenchmarkFixtureV1;
};

export type AvailableMetricV1<T> =
  | { available: true; value: T }
  | { available: false; reason: string };

export type DurationAggregateV1 = {
  count: number;
  totalMs: number;
  meanMs: number;
  maxMs: number;
};

export type ResourceTotalsV1 = Usage & { turns: number; runs: number };

export type EvaluationMetricsV1 = {
  makespanMs: AvailableMetricV1<number>;
  slotUtilization: AvailableMetricV1<number>;
  blockedDwell: AvailableMetricV1<DurationAggregateV1>;
  answeredSupervisorResponseLatency: AvailableMetricV1<DurationAggregateV1>;
  wrapUpLeadTime: AvailableMetricV1<DurationAggregateV1>;
  limitHitRate: AvailableMetricV1<number>;
  childResourceTotals: AvailableMetricV1<ResourceTotalsV1>;
  eligibleCapacityMs: AvailableMetricV1<number>;
  schedulableIdleMs: AvailableMetricV1<number>;
  criticalPathMs: AvailableMetricV1<number>;
};

const RUN_STATUSES = new Set<RunStatus>([
  "queued",
  "starting",
  "running",
  "blocked",
  "parked",
  "failed",
  "stopped",
]);
const RUNNERS = new Set<RunnerKind>(["native", "rpc", "external"]);
const TERMINATION_REASONS = new Set<TerminationReasonCode>([
  "completed",
  "wall_limit",
  "turn_limit",
  "token_limit",
  "cost_limit",
  "explicit_stop",
  "parent_shutdown",
  "session_change",
  "startup_error",
  "runner_error",
  "ancestor_terminated",
  "legacy_unknown",
]);
const TERMINATION_PHASES = new Set<NonNullable<StructuredTerminationReason["phase"]>>([
  "startup",
  "execution",
  "finalization",
  "cleanup",
]);
const LIMIT_KINDS = new Set<NonNullable<StructuredTerminationReason["limit"]>["kind"]>([
  "wall",
  "turn",
  "token",
  "cost",
]);
const REQUEST_KINDS = new Set<SupervisorRequestKind>([
  "decision",
  "approval",
  "blocker",
  "progress",
  "integration-ready",
]);
const REQUEST_STATUSES = new Set<SupervisorRequestStatus>([
  "pending",
  "answered",
  "rejected",
  "cancelled",
]);
const ACTIVITY_KINDS = new Set<RunActivityKind>([
  "spawn",
  "prompt",
  "steer",
  "tool",
  "message",
  "status",
  "approval",
  "error",
  "transport",
  "park",
]);
const LIMIT_REASONS = new Set<TerminationReasonCode>([
  "wall_limit",
  "turn_limit",
  "token_limit",
  "cost_limit",
]);
const TRANSITION_CAUSES = new Set<EvaluationTransitionCauseV1>([
  "allocation",
  "accepted",
  "supervisor_request",
  "requests_resolved",
  "revival",
  "completed",
  "wall_limit",
  "turn_limit",
  "token_limit",
  "cost_limit",
  "explicit_stop",
  "parent_shutdown",
  "session_change",
  "startup_error",
  "runner_error",
  "ancestor_terminated",
  "legacy_restore",
  "legacy_unknown",
]);

function finiteNonnegative(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function validIso(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function timestamp(value: string): number {
  return Date.parse(value);
}

function cloneLimits(source: EffectiveRunLimits): EffectiveRunLimits {
  return {
    maxWallSeconds: finiteNonnegative(source.maxWallSeconds),
    maxTurns:
      source.maxTurns === "notApplicable" ? "notApplicable" : finiteNonnegative(source.maxTurns),
    wrapUpRatio:
      typeof source.wrapUpRatio === "number" && Number.isFinite(source.wrapUpRatio)
        ? source.wrapUpRatio
        : 0.8,
    ...(source.tokenBudget === undefined
      ? {}
      : { tokenBudget: finiteNonnegative(source.tokenBudget) }),
    ...(source.costBudget === undefined
      ? {}
      : { costBudget: finiteNonnegative(source.costBudget) }),
  };
}

function cloneUsage(source: Partial<Usage> | undefined): Usage {
  return {
    input: finiteNonnegative(source?.input),
    output: finiteNonnegative(source?.output),
    cacheRead: finiteNonnegative(source?.cacheRead),
    cacheWrite: finiteNonnegative(source?.cacheWrite),
    total: finiteNonnegative(source?.total),
    cost: finiteNonnegative(source?.cost),
  };
}

function cloneReason(
  source: StructuredTerminationReason | undefined,
): StructuredTerminationReason | undefined {
  if (!source || !TERMINATION_REASONS.has(source.code) || !validIso(source.at)) return undefined;
  return {
    code: source.code,
    at: source.at,
    generation: finiteNonnegative(source.generation),
    ...(source.phase && TERMINATION_PHASES.has(source.phase) ? { phase: source.phase } : {}),
    ...(source.limit && LIMIT_KINDS.has(source.limit.kind)
      ? {
          limit: {
            kind: source.limit.kind,
            maximum: finiteNonnegative(source.limit.maximum),
            observed: finiteNonnegative(source.limit.observed),
          },
        }
      : {}),
    ...(source.ancestorRunId ? { ancestorRunId: source.ancestorRunId } : {}),
  };
}

function cloneLease(source: EvaluationLeaseV1): EvaluationLeaseV1 | undefined {
  if (
    typeof source?.id !== "string" ||
    !source.id ||
    !validIso(source.startedAt) ||
    !validIso(source.wrapAt) ||
    !validIso(source.deadlineAt) ||
    !source.effectiveLimits
  )
    return undefined;
  return {
    id: source.id,
    generation: finiteNonnegative(source.generation),
    startedAt: source.startedAt,
    ...(validIso(source.acceptedAt) ? { acceptedAt: source.acceptedAt } : {}),
    wrapAt: source.wrapAt,
    deadlineAt: source.deadlineAt,
    ...(validIso(source.wrapTriggeredAt) ? { wrapTriggeredAt: source.wrapTriggeredAt } : {}),
    ...(source.wrapCause === "wall" || source.wrapCause === "turn"
      ? { wrapCause: source.wrapCause }
      : {}),
    ...(validIso(source.endedAt) ? { endedAt: source.endedAt } : {}),
    ...(source.endReason && TERMINATION_REASONS.has(source.endReason)
      ? { endReason: source.endReason }
      : {}),
    effectiveLimits: cloneLimits(source.effectiveLimits),
  };
}

function cloneTransition(source: StatusTransition): EvaluationStatusTransitionV1 | undefined {
  if (!source || !RUN_STATUSES.has(source.to) || !validIso(source.at)) return undefined;
  return {
    ...(source.from && RUN_STATUSES.has(source.from) ? { from: source.from } : {}),
    to: source.to,
    at: source.at,
    generation: finiteNonnegative(source.generation),
    cause: TRANSITION_CAUSES.has(source.cause as EvaluationTransitionCauseV1)
      ? (source.cause as EvaluationTransitionCauseV1)
      : "legacy_unknown",
  };
}

function aggregate(values: readonly number[]): DurationAggregateV1 {
  const totalMs = values.reduce((total, value) => total + value, 0);
  return {
    count: values.length,
    totalMs,
    meanMs: totalMs / values.length,
    maxMs: Math.max(...values),
  };
}

function unavailable<T>(reason: string): AvailableMetricV1<T> {
  return { available: false, reason };
}

function available<T>(value: T): AvailableMetricV1<T> {
  return { available: true, value };
}

function benchmarkCopy(
  fixture: EvaluationBenchmarkFixtureV1 | undefined,
): EvaluationBenchmarkFixtureV1 | undefined {
  if (!fixture || !Array.isArray(fixture.tasks)) return undefined;
  const tasks = fixture.tasks
    .filter((task) => typeof task?.id === "string" && task.id && validIso(task.readyAt))
    .map((task) => ({
      id: task.id,
      dependencies: Array.isArray(task.dependencies)
        ? task.dependencies.filter((dependency) => typeof dependency === "string")
        : [],
      readyAt: task.readyAt,
      ...(validIso(task.startedAt) ? { startedAt: task.startedAt } : {}),
      ...(validIso(task.endedAt) ? { endedAt: task.endedAt } : {}),
    }));
  return tasks.length ? { tasks } : undefined;
}

/** Build a deterministic, allowlisted, redacted trace. */
export function buildEvaluationTraceV1(input: EvaluationTraceInputV1): EvaluationTraceV1 {
  const generatedAt = validIso(input.generatedAt) ? input.generatedAt : new Date().toISOString();
  const runs = (input.runs ?? [])
    .filter(
      (run) =>
        typeof run?.id === "string" &&
        run.id.length > 0 &&
        RUNNERS.has(run.runner) &&
        RUN_STATUSES.has(run.status),
    )
    .map((run): EvaluationRunV1 => {
      const sourceLeases = run.leaseHistory ?? run.leases ?? [];
      return {
        id: run.id,
        runner: run.runner,
        status: run.status,
        leases: sourceLeases
          .map(cloneLease)
          .filter((lease): lease is EvaluationLeaseV1 => Boolean(lease))
          .sort((left, right) =>
            left.generation === right.generation
              ? left.startedAt.localeCompare(right.startedAt)
              : left.generation - right.generation,
          ),
        statusTransitions: (run.statusTransitions ?? [])
          .map(cloneTransition)
          .filter((transition): transition is EvaluationStatusTransitionV1 => Boolean(transition))
          .sort((left, right) => left.at.localeCompare(right.at)),
        turns: finiteNonnegative(run.turns),
        usage: cloneUsage(run.usage),
        ...(cloneReason(run.terminationReason ?? run.terminalReason)
          ? { terminalReason: cloneReason(run.terminationReason ?? run.terminalReason) }
          : {}),
      };
    })
    .sort((left, right) => left.id.localeCompare(right.id));

  const capacityTimeline = (input.capacityTimeline ?? [])
    .filter((point) => validIso(point?.at))
    .map((point) => ({
      at: point.at,
      used: finiteNonnegative(point.used),
      limit: finiteNonnegative(point.limit),
      sharedWritersUsed: finiteNonnegative(point.sharedWritersUsed),
      sharedWritersLimit: finiteNonnegative(point.sharedWritersLimit),
    }))
    .sort((left, right) => left.at.localeCompare(right.at));

  const requests = (input.requests ?? [])
    .filter(
      (request) =>
        typeof request?.id === "string" &&
        request.id.length > 0 &&
        typeof (request.runId ?? request.fromRunId) === "string" &&
        REQUEST_KINDS.has(request.kind) &&
        REQUEST_STATUSES.has(request.status) &&
        validIso(request.createdAt),
    )
    .map(
      (request): EvaluationRequestV1 => ({
        id: request.id,
        runId: (request.runId ?? request.fromRunId) as string,
        kind: request.kind,
        createdAt: request.createdAt,
        ...(validIso(request.resolvedAt) ? { resolvedAt: request.resolvedAt } : {}),
        status: request.status,
      }),
    )
    .sort((left, right) =>
      left.createdAt === right.createdAt
        ? left.id.localeCompare(right.id)
        : left.createdAt.localeCompare(right.createdAt),
    );

  const activities = (input.activities ?? [])
    .filter(
      (activity) =>
        typeof activity?.runId === "string" &&
        activity.runId.length > 0 &&
        ACTIVITY_KINDS.has(activity.kind) &&
        validIso(activity.at),
    )
    .map((activity) => ({ runId: activity.runId, kind: activity.kind, at: activity.at }))
    .sort((left, right) =>
      left.at === right.at
        ? left.runId.localeCompare(right.runId)
        : left.at.localeCompare(right.at),
    );

  return {
    schemaVersion: 1,
    generatedAt,
    runs,
    capacityTimeline,
    requests,
    activities,
    ...(benchmarkCopy(input.benchmark) ? { benchmark: benchmarkCopy(input.benchmark) } : {}),
  };
}

function traceBounds(trace: EvaluationTraceV1): { start: number; end: number } | undefined {
  const starts = trace.runs.flatMap((run) => run.leases.map((lease) => timestamp(lease.startedAt)));
  if (!starts.length) return undefined;
  const start = Math.min(...starts);
  const ends = trace.runs.flatMap((run) =>
    run.leases.map((lease) =>
      lease.endedAt ? timestamp(lease.endedAt) : timestamp(trace.generatedAt),
    ),
  );
  return { start, end: Math.max(start, ...ends) };
}

function capacityUtilization(
  trace: EvaluationTraceV1,
  bounds: { start: number; end: number },
): AvailableMetricV1<number> {
  if (bounds.end <= bounds.start) return available(0);
  const points = trace.capacityTimeline
    .map((point) => ({ ...point, time: timestamp(point.at) }))
    .filter((point) => point.time <= bounds.end)
    .sort((left, right) => left.time - right.time);
  const initial = [...points].reverse().find((point) => point.time <= bounds.start);
  if (!initial)
    return unavailable("Capacity history does not cover the start of the measured interval.");
  let current = initial;
  let cursor = bounds.start;
  let usedMs = 0;
  let availableMs = 0;
  for (const point of points) {
    if (point.time <= bounds.start) continue;
    const end = Math.min(bounds.end, point.time);
    const duration = Math.max(0, end - cursor);
    usedMs += Math.min(current.used, current.limit) * duration;
    availableMs += current.limit * duration;
    cursor = end;
    current = point;
    if (cursor >= bounds.end) break;
  }
  if (cursor < bounds.end) {
    const duration = bounds.end - cursor;
    usedMs += Math.min(current.used, current.limit) * duration;
    availableMs += current.limit * duration;
  }
  return available(availableMs > 0 ? usedMs / availableMs : 0);
}

function blockedDurations(trace: EvaluationTraceV1): AvailableMetricV1<DurationAggregateV1> {
  if (!trace.runs.length || trace.runs.some((run) => !run.statusTransitions.length))
    return unavailable("Complete status-transition history is required.");
  const durations: number[] = [];
  for (const run of trace.runs) {
    let blockedAt: number | undefined;
    for (const transition of run.statusTransitions) {
      const at = timestamp(transition.at);
      if (transition.to === "blocked" && blockedAt === undefined) blockedAt = at;
      else if (transition.to !== "blocked" && blockedAt !== undefined) {
        durations.push(Math.max(0, at - blockedAt));
        blockedAt = undefined;
      }
    }
    if (blockedAt !== undefined)
      durations.push(Math.max(0, timestamp(trace.generatedAt) - blockedAt));
  }
  return available(
    durations.length ? aggregate(durations) : { count: 0, totalMs: 0, meanMs: 0, maxMs: 0 },
  );
}

function requestLatencies(trace: EvaluationTraceV1): AvailableMetricV1<DurationAggregateV1> {
  const durations = trace.requests
    .filter((request) => request.status === "answered" && validIso(request.resolvedAt))
    .map((request) => timestamp(request.resolvedAt!) - timestamp(request.createdAt))
    .filter((duration) => duration >= 0);
  return durations.length
    ? available(aggregate(durations))
    : unavailable("No answered request has complete creation and resolution timestamps.");
}

function wrapLeadTimes(trace: EvaluationTraceV1): AvailableMetricV1<DurationAggregateV1> {
  const durations = trace.runs
    .flatMap((run) => run.leases)
    .filter((lease) => validIso(lease.wrapTriggeredAt) && validIso(lease.endedAt))
    .map((lease) => timestamp(lease.endedAt!) - timestamp(lease.wrapTriggeredAt!))
    .filter((duration) => duration >= 0);
  return durations.length
    ? available(aggregate(durations))
    : unavailable("No ended lease has a recorded wrap timestamp.");
}

function limitRate(trace: EvaluationTraceV1): AvailableMetricV1<number> {
  const terminal = trace.runs.filter((run) => run.terminalReason);
  if (!terminal.length) return unavailable("No run has a terminal reason.");
  return available(
    terminal.filter((run) => LIMIT_REASONS.has(run.terminalReason!.code)).length / terminal.length,
  );
}

function resourceTotals(trace: EvaluationTraceV1): AvailableMetricV1<ResourceTotalsV1> {
  if (!trace.runs.length) return unavailable("No child resource history is available.");
  return available(
    trace.runs.reduce<ResourceTotalsV1>(
      (total, run) => ({
        input: total.input + run.usage.input,
        output: total.output + run.usage.output,
        cacheRead: total.cacheRead + run.usage.cacheRead,
        cacheWrite: total.cacheWrite + run.usage.cacheWrite,
        total: total.total + run.usage.total,
        cost: total.cost + run.usage.cost,
        turns: total.turns + run.turns,
        runs: total.runs + 1,
      }),
      { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0, turns: 0, runs: 0 },
    ),
  );
}

function fixtureMetrics(
  trace: EvaluationTraceV1,
): Pick<EvaluationMetricsV1, "eligibleCapacityMs" | "schedulableIdleMs" | "criticalPathMs"> {
  const fixture = trace.benchmark;
  if (!fixture)
    return {
      eligibleCapacityMs: unavailable("An explicit benchmark readiness fixture is required."),
      schedulableIdleMs: unavailable("An explicit benchmark readiness fixture is required."),
      criticalPathMs: unavailable("An explicit benchmark dependency fixture is required."),
    };
  if (
    fixture.tasks.some(
      (task) => !validIso(task.readyAt) || !validIso(task.startedAt) || !validIso(task.endedAt),
    )
  )
    return {
      eligibleCapacityMs: unavailable("Every benchmark task needs ready, start, and end times."),
      schedulableIdleMs: unavailable("Every benchmark task needs ready, start, and end times."),
      criticalPathMs: unavailable("Every benchmark task needs start and end times."),
    };

  const bounds = traceBounds(trace);
  const capacity = trace.capacityTimeline
    .map((point) => ({ ...point, time: timestamp(point.at) }))
    .sort((left, right) => left.time - right.time);
  if (!bounds || !capacity.length)
    return {
      eligibleCapacityMs: unavailable("Run and capacity intervals are required."),
      schedulableIdleMs: unavailable("Run and capacity intervals are required."),
      criticalPathMs: unavailable("Run intervals are required."),
    };

  const events = new Set<number>([bounds.start, bounds.end]);
  for (const point of capacity)
    if (point.time >= bounds.start && point.time <= bounds.end) events.add(point.time);
  for (const task of fixture.tasks) {
    events.add(timestamp(task.readyAt));
    events.add(timestamp(task.startedAt!));
    events.add(timestamp(task.endedAt!));
  }
  const times = [...events]
    .filter((time) => time >= bounds.start && time <= bounds.end)
    .sort((a, b) => a - b);
  let eligibleCapacityMs = 0;
  let schedulableIdleMs = 0;
  for (let index = 0; index < times.length - 1; index += 1) {
    const start = times[index]!;
    const end = times[index + 1]!;
    const point = [...capacity].reverse().find((candidate) => candidate.time <= start);
    if (!point) continue;
    const ready = fixture.tasks.filter(
      (task) => timestamp(task.readyAt) <= start && timestamp(task.startedAt!) > start,
    ).length;
    const free = Math.max(0, point.limit - point.used);
    const duration = end - start;
    eligibleCapacityMs += Math.min(ready, point.limit) * duration;
    schedulableIdleMs += Math.min(ready, free) * duration;
  }

  const byId = new Map(fixture.tasks.map((task) => [task.id, task]));
  const memo = new Map<string, number>();
  const visiting = new Set<string>();
  const longest = (id: string): number | undefined => {
    const cached = memo.get(id);
    if (cached !== undefined) return cached;
    if (visiting.has(id)) return undefined;
    const task = byId.get(id);
    if (!task?.startedAt || !task.endedAt) return undefined;
    visiting.add(id);
    let prerequisite = 0;
    for (const dependency of task.dependencies) {
      if (!byId.has(dependency)) return undefined;
      const value = longest(dependency);
      if (value === undefined) return undefined;
      prerequisite = Math.max(prerequisite, value);
    }
    visiting.delete(id);
    const result = prerequisite + Math.max(0, timestamp(task.endedAt) - timestamp(task.startedAt));
    memo.set(id, result);
    return result;
  };
  const paths = fixture.tasks.map((task) => longest(task.id));
  return {
    eligibleCapacityMs: available(eligibleCapacityMs),
    schedulableIdleMs: available(schedulableIdleMs),
    criticalPathMs: paths.some((value) => value === undefined)
      ? unavailable("The benchmark dependency graph is incomplete or cyclic.")
      : available(Math.max(0, ...(paths as number[]))),
  };
}

/** Evaluate one redacted trace without inferring mission success from parked status. */
export function evaluateTraceV1(trace: EvaluationTraceV1): EvaluationMetricsV1 {
  const sanitized = buildEvaluationTraceV1(trace);
  const bounds = traceBounds(sanitized);
  const fixture = fixtureMetrics(sanitized);
  return {
    makespanMs: bounds
      ? available(Math.max(0, bounds.end - bounds.start))
      : unavailable("Lease history is required."),
    slotUtilization: bounds
      ? capacityUtilization(sanitized, bounds)
      : unavailable("Lease and capacity history are required."),
    blockedDwell: blockedDurations(sanitized),
    answeredSupervisorResponseLatency: requestLatencies(sanitized),
    wrapUpLeadTime: wrapLeadTimes(sanitized),
    limitHitRate: limitRate(sanitized),
    childResourceTotals: resourceTotals(sanitized),
    ...fixture,
  };
}
