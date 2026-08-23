import { type ExtensionAPI, keyHint } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { CollectMode, DispatchInput, SubagentManager } from "./manager.js";
import { safeDisplayText } from "./renderers.js";
import type { SupervisorRequest } from "./supervisor.js";
import type { RunSnapshot, Usage } from "./types.js";

function expandHint(): string {
  try {
    return keyHint("app.tools.expand", "to expand");
  } catch {
    return "Ctrl+O to expand";
  }
}

function duration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1_000));
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function age(value: string | undefined, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? Math.max(0, now - parsed) : undefined;
}

export function runState(run: RunSnapshot, now = Date.now()): string {
  if (run.status === "blocked") return "blocked";
  if (run.status === "failed") return "failed";
  if (run.status === "stopped") return "stopped";
  if (run.status === "parked") return "done (parked)";
  if (run.status === "queued" || run.status === "starting") return "starting";
  if (run.wrappingUp) return "wrapping up";
  const lastEventAge = age(run.lastEventAt, now);
  return lastEventAge !== undefined && lastEventAge >= 30_000
    ? `quiet · no event for ${duration(lastEventAge)}`
    : "working";
}

function runLine(run: RunSnapshot): string {
  const icon = run.status === "running" ? "●" : run.status === "blocked" ? "!" : "○";
  const model = run.effectiveModel ? ` · ${safeDisplayText(run.effectiveModel)}` : "";
  return `${icon} ${safeDisplayText(run.name)} · ${runState(run)}${model} · ${safeDisplayText(run.ownership.key)}`;
}

export function runOperationalLines(run: RunSnapshot, now = Date.now()): string[] {
  const leases = run.leaseHistory ?? [];
  const lease =
    leases.find((candidate) => candidate.generation === run.activeLeaseGeneration) ?? leases.at(-1);
  const end = run.finishedAt ? Math.min(now, Date.parse(run.finishedAt)) : now;
  const wall = lease
    ? `lease ${duration(end - Date.parse(lease.startedAt))} elapsed · ${duration(Date.parse(lease.deadlineAt) - end)} remaining`
    : "lease unavailable";
  const turnLimit = lease?.effectiveLimits.maxTurns ?? run.originalEffectiveLimits?.maxTurns;
  const usedTurns = run.turns ?? 0;
  const turns =
    turnLimit === "notApplicable"
      ? "turns not applicable (external)"
      : turnLimit === undefined
        ? "turns unavailable"
        : `turns ${usedTurns} used · ${Math.max(0, turnLimit - usedTurns)} remaining`;
  const lastEventAge = age(run.lastEventAt, now);
  const operationAge = age(run.currentOperation?.startedAt, now);
  return [
    `${wall} · ${turns}`,
    lastEventAge === undefined
      ? "last event unavailable"
      : `last event ${duration(lastEventAge)} ago`,
    ...(run.currentOperation
      ? [
          `operation ${run.currentOperation.kind}: ${safeDisplayText(run.currentOperation.name)} · ${duration(operationAge ?? 0)} old`,
        ]
      : []),
    ...(run.blockedSince ? [`blocked for ${duration(age(run.blockedSince, now) ?? 0)}`] : []),
    ...(run.terminationReason
      ? [
          `termination ${run.terminationReason.code}${run.terminationReason.phase ? ` · phase ${run.terminationReason.phase}` : ""}`,
        ]
      : []),
    ...(run.cleanupFailure
      ? [`cleanup retained · ${safeDisplayText(run.cleanupFailure.message)}`]
      : []),
  ];
}

export function runReport(run: RunSnapshot): string {
  if (run.status !== "failed") return run.report || run.error || "(no report yet)";
  const reason = `Failure reason: ${run.terminationReason?.code ?? "legacy_unknown"}${run.error ? ` · ${run.error}` : ""}`;
  return run.report ? `${reason}\n\nPartial report:\n${run.report}` : reason;
}

function runDetails(details: unknown): RunSnapshot[] {
  if (!details || typeof details !== "object") return [];
  const value = details as { runs?: RunSnapshot[]; run?: RunSnapshot };
  return value.runs ?? (value.run ? [value.run] : []);
}

function resultRenderer(
  result: { details?: unknown; content?: Array<{ type?: string; text?: string }> },
  options: { expanded: boolean; isPartial: boolean },
  theme: { fg(color: string, text: string): string },
  context: { lastComponent?: unknown; isError?: boolean },
) {
  const component = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
  if (options.isPartial) {
    component.setText(theme.fg("muted", "Hackler operation in progress…"));
    return component;
  }
  const runs = runDetails(result.details);
  const content =
    result.content
      ?.filter((part) => part.type === "text")
      .map((part) => part.text ?? "")
      .join("\n") ?? "";
  if (!options.expanded) {
    const summary = runs.length
      ? runs.map(runLine).join("\n")
      : context.isError
        ? "Hackler operation failed."
        : "Hackler operation completed.";
    component.setText(
      `${theme.fg(context.isError ? "error" : "muted", summary)}\n${theme.fg("dim", expandHint())}`,
    );
    return component;
  }
  component.setText(
    theme.fg(context.isError ? "error" : "toolOutput", safeDisplayText(content || "No output.")),
  );
  return component;
}

function callRenderer(
  label: string,
  args: Record<string, unknown>,
  theme: { fg(color: string, text: string): string; bold(text: string): string },
  context: { lastComponent?: unknown; isPartial?: boolean },
) {
  const component = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
  const tasks = Array.isArray(args.tasks) ? args.tasks.length : undefined;
  const preview =
    tasks !== undefined
      ? `${tasks} task${tasks === 1 ? "" : "s"}`
      : Array.isArray(args.ids)
        ? args.ids.join(", ")
        : typeof args.id === "string"
          ? args.id
          : "";
  component.setText(
    `${theme.fg("toolTitle", theme.bold(`${label} `))}${theme.fg("dim", safeDisplayText(preview).slice(0, 100))}${context.isPartial ? theme.fg("muted", " · working") : ""}`,
  );
  return component;
}

function usageHasValue(usage: Usage): boolean {
  return (
    usage.input !== 0 ||
    usage.output !== 0 ||
    usage.cacheRead !== 0 ||
    usage.cacheWrite !== 0 ||
    usage.total !== 0 ||
    usage.cost !== 0
  );
}

function nestedUsage(usage: Usage) {
  return {
    input: usage.input,
    output: usage.output,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
    totalTokens: usage.total,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: usage.cost,
    },
  };
}

function supervisorRequestLines(requests: readonly SupervisorRequest[]): string[] {
  return requests.flatMap((request) => [
    `- ${request.id} · ${request.kind} · ${safeDisplayText(request.title)} · from ${request.fromRunId} · ${duration(age(request.createdAt) ?? 0)} old`,
    `  ${safeDisplayText(request.detail)}`,
    `  required action: subagent_respond ${request.id} · choices: ${request.choices.map((choice) => choice.value).join(", ") || "free-form response"}`,
  ]);
}

const dispatchTaskSchema = Type.Object({
  key: Type.String({ description: "Stable unique key for this owned work slice." }),
  agent: Type.String({ description: "Enabled profile name returned by subagent_status." }),
  task: Type.String({ description: "Self-contained bounded assignment." }),
  owns: Type.Array(Type.String(), {
    minItems: 1,
    description: "Owned paths, symbols, or topics. Prefix with path:, symbol:, or topic:.",
  }),
  deliverable: Type.String({
    minLength: 1,
    description: "Concrete result this child must return.",
  }),
  acceptance: Type.String({
    minLength: 1,
    description: "Observable criteria the result must satisfy before it is accepted.",
  }),
  stopConditions: Type.Array(Type.String({ minLength: 1 }), {
    minItems: 1,
    description: "Conditions that end work with either completion or a reported blocker.",
  }),
  context: Type.Optional(
    Type.Union([Type.Literal("fresh"), Type.Literal("decisions"), Type.Literal("plan")]),
  ),
  workspace: Type.Optional(Type.Union([Type.Literal("shared"), Type.Literal("worktree")])),
});

export const LEGACY_STOP_CONDITION =
  "Stop when the deliverable is complete or report a blocker that prevents completion.";

type DispatchArguments = { tasks: DispatchInput[] };
type LegacyDispatchArguments = {
  tasks?: unknown;
  [key: string]: unknown;
};

/** Add the adaptive contract to persisted calls created before it was required. */
export function prepareDispatchArguments(input: unknown): DispatchArguments {
  if (!input || typeof input !== "object") return input as DispatchArguments;
  const args = input as LegacyDispatchArguments;
  if (!Array.isArray(args.tasks)) return input as DispatchArguments;
  return {
    ...args,
    tasks: args.tasks.map((value) => {
      if (!value || typeof value !== "object") return value;
      const task = value as Record<string, unknown>;
      return {
        ...task,
        ...(task.acceptance === undefined && typeof task.deliverable === "string"
          ? { acceptance: task.deliverable }
          : {}),
        ...(task.stopConditions === undefined ? { stopConditions: [LEGACY_STOP_CONDITION] } : {}),
      };
    }),
  } as DispatchArguments;
}

type AdaptiveCollectResult = RunSnapshot[] | { runs: RunSnapshot[]; waitReason?: string };

type AdaptiveCollect = (
  ids: readonly string[] | undefined,
  wait: CollectMode,
  signal?: AbortSignal,
  timeoutSeconds?: number,
) => Promise<AdaptiveCollectResult>;

function unpackCollectResult(result: AdaptiveCollectResult): {
  runs: RunSnapshot[];
  waitReason?: string;
} {
  return Array.isArray(result) ? { runs: result } : result;
}

export function registerSubagentTools(pi: ExtensionAPI, manager: SubagentManager): void {
  pi.registerTool({
    name: "subagent_dispatch",
    label: "Dispatch Hackler",
    description:
      "Dispatch one or more bounded Hackler tasks from the substantial independent ready frontier. Each task must declare disjoint ownership, a deliverable, acceptance criteria, and stop conditions; never invent work to fill capacity.",
    promptSnippet: "Dispatch the smallest justified batch of independent, explicitly owned work.",
    promptGuidelines: [
      "Use Hackler for substantial independent or specialist work, not trivial or tightly sequential steps.",
      "Query capacity, rank an oversized ready frontier, and dispatch the smallest justified batch up to free capacity.",
      "Never invent, split, or duplicate work merely to fill slots; recompute the frontier after each wave.",
      "Use Scout/Researcher/Reviewer/Oracle for read-only work and Worker only for an owned implementation slice.",
      "Do not work on a delegated scope while its child is active; continue only unowned work.",
      "Resolve blockers before waiting again; after repeated correction, narrow or re-dispatch instead of steering repeatedly.",
      "The parent reviews reports and runs final integrated verification.",
    ],
    parameters: Type.Object({
      tasks: Type.Array(dispatchTaskSchema, { minItems: 1, maxItems: 16 }),
    }),
    prepareArguments: prepareDispatchArguments,
    async execute(_toolCallId, params, _signal, _update, ctx) {
      try {
        const runs = await manager.dispatch(params.tasks as DispatchInput[], ctx);
        const snapshots = manager
          .snapshots()
          .filter((snapshot) => runs.some((run) => run.id === snapshot.id));
        return {
          content: [
            {
              type: "text",
              text: runs.map((run) => `${run.ownership.key}: ${run.id} accepted`).join("\n"),
            },
          ],
          details: { runs: snapshots },
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
          details: { runs: [] },
          isError: true,
        };
      }
    },
    renderCall(args, theme, context) {
      return callRenderer("subagent_dispatch", args as Record<string, unknown>, theme, context);
    },
    renderResult: resultRenderer,
  });

  pi.registerTool({
    name: "subagent_status",
    label: "Hackler status",
    description:
      "List enabled profiles, active ownership, capacity, blocked requests, parked reports, and configuration diagnostics.",
    promptSnippet: "Inspect profiles, ownership, lifecycle, and capacity before dispatching.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _update, ctx) {
      try {
        const hub = await manager.status(ctx);
        const visibleProfiles = hub.profiles.filter((profile) => !profile.hidden);
        const text = [
          "Profiles:",
          ...visibleProfiles.map(
            (profile) =>
              `- ${profile.name} (${profile.class}, ${profile.runner}): ${profile.description}`,
          ),
          "",
          `Capacity: slots ${hub.capacity.used}/${hub.capacity.limit} used · ${hub.capacity.free} free · shared writers ${hub.capacity.sharedWritersUsed}/${hub.capacity.sharedWritersLimit}`,
          `Counts: running ${hub.runs.filter((run) => ["queued", "starting", "running"].includes(run.status)).length} · wrapping ${hub.runs.filter((run) => run.wrappingUp && ["queued", "starting", "running", "blocked"].includes(run.status)).length} · blocked ${hub.runs.filter((run) => run.status === "blocked").length} · failed ${hub.runs.filter((run) => run.status === "failed").length} · stopped ${hub.runs.filter((run) => run.status === "stopped").length}`,
          "",
          "Runs:",
          ...(hub.runs.length
            ? hub.runs.map(
                (run) =>
                  `${runLine(run)}\n  ${runOperationalLines(run).join("\n  ")}\n  owns: ${run.ownership.owns.join(", ")}\n  task: ${run.task}`,
              )
            : ["(none)"]),
          "",
          `Pending supervisor requests: ${hub.requests.filter((request) => request.status === "pending").length}`,
          ...(hub.diagnostics.length
            ? [
                "",
                "Diagnostics:",
                ...hub.diagnostics.map((item) => `- ${item.path}: ${item.message}`),
              ]
            : []),
          ...(manager.pendingRequests().length
            ? [
                "",
                "Pending supervisor requests:",
                ...supervisorRequestLines(manager.pendingRequests()),
              ]
            : []),
        ].join("\n");
        return {
          content: [{ type: "text", text }],
          details: { runs: hub.runs, requests: manager.pendingRequests() },
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
          details: { runs: [] },
          isError: true,
        };
      }
    },
    renderCall(args, theme, context) {
      return callRenderer("subagent_status", args as Record<string, unknown>, theme, context);
    },
    renderResult: resultRenderer,
  });

  pi.registerTool({
    name: "subagent_respond",
    label: "Respond to Hackler",
    description:
      "Resolve one pending supervisor request for a blocked Hackler run. Inspect the request with subagent_status first and use an exact choice value when choices are provided.",
    promptSnippet: "Resolve a pending supervisor request so a blocked child can continue.",
    parameters: Type.Object({
      id: Type.String({ description: "Pending supervisor request ID." }),
      answer: Type.String({ description: "Exact choice value or free-form response." }),
    }),
    async execute(_toolCallId, params) {
      try {
        const request = await manager.respondRequest(params.id, params.answer);
        return {
          content: [
            {
              type: "text",
              text: `Supervisor request ${request.id} answered: ${request.answer ?? params.answer}`,
            },
          ],
          details: { request },
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
          details: {},
          isError: true,
        };
      }
    },
    renderCall(args, theme, context) {
      return callRenderer("subagent_respond", args as Record<string, unknown>, theme, context);
    },
    renderResult: resultRenderer,
  });

  pi.registerTool({
    name: "subagent_collect",
    label: "Collect Hackler",
    description:
      "Read selected Hackler results, optionally waiting for the next or all selected runs to settle. Settled sessions are already parked and consume no active capacity.",
    parameters: Type.Object({
      ids: Type.Optional(Type.Array(Type.String())),
      wait: Type.Optional(
        Type.Union([Type.Literal("none"), Type.Literal("next"), Type.Literal("all")]),
      ),
      timeoutSeconds: Type.Optional(
        Type.Integer({
          minimum: 10,
          maximum: 3600,
          description: "Maximum time to wait before returning current state.",
        }),
      ),
    }),
    async execute(_toolCallId, params, signal) {
      const collected = await (manager.collect as AdaptiveCollect)(
        params.ids,
        (params.wait ?? "none") as CollectMode,
        signal,
        params.timeoutSeconds,
      );
      const { runs, waitReason } = unpackCollectResult(collected);
      const usage = manager.takeUnreportedUsage(params.ids);
      const attached = usageHasValue(usage);
      const requests = manager.pendingRequests();
      const reports =
        runs
          .map(
            (run) =>
              `## ${run.name} · ${runState(run)}\n${runOperationalLines(run).join("\n")}\nOwned: ${run.ownership.owns.join(", ")}\n\n${runReport(run)}`,
          )
          .join("\n\n") || "No matching Hackler runs.";
      const requestText = requests.length
        ? `\n\nPending supervisor requests:\n${supervisorRequestLines(requests).join("\n")}`
        : "";
      const waitText = waitReason ? `\n\nWait ended: ${safeDisplayText(waitReason)}` : "";
      return {
        content: [{ type: "text", text: reports + requestText + waitText }],
        ...(attached ? { usage: nestedUsage(usage) } : {}),
        details: {
          runs,
          requests,
          ...(waitReason ? { waitReason } : {}),
          ...(attached ? { subagentUsageAttached: true } : {}),
        },
      };
    },
    renderCall(args, theme, context) {
      return callRenderer("subagent_collect", args as Record<string, unknown>, theme, context);
    },
    renderResult: resultRenderer,
  });

  pi.registerTool({
    name: "subagent_steer",
    label: "Steer Hackler",
    description:
      "Send guidance to an active Hackler run, or explicitly revive a parked persistent session with a follow-up.",
    parameters: Type.Object({ id: Type.String(), message: Type.String() }),
    async execute(_toolCallId, params) {
      try {
        const run = await manager.steer(params.id, params.message);
        const snapshot = manager.snapshots().find((item) => item.id === run.id)!;
        const usage = manager.takeUnreportedUsage([run.id]);
        const attached = usageHasValue(usage);
        return {
          content: [{ type: "text", text: `Guidance accepted by ${run.id}.` }],
          ...(attached ? { usage: nestedUsage(usage) } : {}),
          details: { run: snapshot, ...(attached ? { subagentUsageAttached: true } : {}) },
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
          details: {},
          isError: true,
        };
      }
    },
    renderCall(args, theme, context) {
      return callRenderer("subagent_steer", args as Record<string, unknown>, theme, context);
    },
    renderResult: resultRenderer,
  });

  pi.registerTool({
    name: "subagent_stop",
    label: "Stop Hackler",
    description:
      "Stop one or more active Hackler runs and their owned descendants. Persistent transcripts and reports remain available.",
    parameters: Type.Object({ ids: Type.Array(Type.String(), { minItems: 1 }) }),
    async execute(_toolCallId, params) {
      try {
        const stopped: Awaited<ReturnType<SubagentManager["stop"]>>[] = [];
        for (const id of params.ids) stopped.push(await manager.stop(id));
        const snapshots = manager
          .snapshots()
          .filter((snapshot) => stopped.some((run) => run.id === snapshot.id));
        const usage = manager.takeUnreportedUsage(params.ids);
        const attached = usageHasValue(usage);
        return {
          content: [{ type: "text", text: stopped.map((run) => `Stopped ${run.id}.`).join("\n") }],
          ...(attached ? { usage: nestedUsage(usage) } : {}),
          details: { runs: snapshots, ...(attached ? { subagentUsageAttached: true } : {}) },
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
          details: {},
          isError: true,
        };
      }
    },
    renderCall(args, theme, context) {
      return callRenderer("subagent_stop", args as Record<string, unknown>, theme, context);
    },
    renderResult: resultRenderer,
  });
}
