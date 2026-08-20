import { type ExtensionAPI, keyHint } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { CollectMode, DispatchInput, SubagentManager } from "./manager.js";
import { safeDisplayText } from "./renderers.js";
import type { RunSnapshot } from "./types.js";

function expandHint(): string {
  try {
    return keyHint("app.tools.expand", "to expand");
  } catch {
    return "Ctrl+O to expand";
  }
}

function runLine(run: RunSnapshot): string {
  const icon = run.status === "running" ? "●" : run.status === "blocked" ? "!" : "○";
  const model = run.effectiveModel ? ` · ${safeDisplayText(run.effectiveModel)}` : "";
  return `${icon} ${safeDisplayText(run.name)} · ${run.status}${model} · ${safeDisplayText(run.ownership.key)}`;
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
    component.setText(theme.fg("muted", "Subagent operation in progress…"));
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
        ? "Subagent operation failed."
        : "Subagent operation completed.";
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

const dispatchTaskSchema = Type.Object({
  key: Type.String({ description: "Stable unique key for this owned work slice." }),
  agent: Type.String({ description: "Enabled profile name returned by subagent_status." }),
  task: Type.String({ description: "Self-contained bounded assignment." }),
  owns: Type.Array(Type.String(), {
    minItems: 1,
    description: "Owned paths, symbols, or topics. Prefix with path:, symbol:, or topic:.",
  }),
  deliverable: Type.String({ description: "Concrete result this child must return." }),
  context: Type.Optional(
    Type.Union([Type.Literal("fresh"), Type.Literal("decisions"), Type.Literal("plan")]),
  ),
  workspace: Type.Optional(Type.Union([Type.Literal("shared"), Type.Literal("worktree")])),
});

export function registerSubagentTools(pi: ExtensionAPI, manager: SubagentManager): void {
  pi.registerTool({
    name: "subagent_dispatch",
    label: "Dispatch subagents",
    description:
      "Dispatch one or more bounded subagent tasks. Batch every independent ready task in one call. Each task must declare disjoint ownership and a deliverable; the parent must not duplicate active delegated scope.",
    promptSnippet: "Dispatch independent, explicitly owned specialist work in one batch.",
    promptGuidelines: [
      "Use subagents for substantial independent or specialist work, not trivial or tightly sequential steps.",
      "Enumerate ready work, assign one owner per path/symbol/angle, and batch it in one call.",
      "Use Scout/Researcher/Reviewer/Oracle for read-only work and Worker only for an owned implementation slice.",
      "Do not work on a delegated scope while its child is active; continue only unowned work.",
      "The parent reviews reports and runs final integrated verification.",
    ],
    parameters: Type.Object({
      tasks: Type.Array(dispatchTaskSchema, { minItems: 1, maxItems: 16 }),
    }),
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
    label: "Subagent status",
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
          "Runs:",
          ...(hub.runs.length
            ? hub.runs.map(
                (run) =>
                  `${runLine(run)}\n  owns: ${run.ownership.owns.join(", ")}\n  task: ${run.task}`,
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
        ].join("\n");
        return { content: [{ type: "text", text }], details: { runs: hub.runs } };
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
    name: "subagent_collect",
    label: "Collect subagents",
    description:
      "Read selected subagent results, optionally waiting for the next or all selected runs to settle. Settled sessions are already parked and consume no active capacity.",
    parameters: Type.Object({
      ids: Type.Optional(Type.Array(Type.String())),
      wait: Type.Optional(
        Type.Union([Type.Literal("none"), Type.Literal("next"), Type.Literal("all")]),
      ),
    }),
    async execute(_toolCallId, params, signal) {
      const runs = await manager.collect(
        params.ids,
        (params.wait ?? "none") as CollectMode,
        signal,
      );
      return {
        content: [
          {
            type: "text",
            text:
              runs
                .map(
                  (run) =>
                    `## ${run.name} · ${run.status}\nOwned: ${run.ownership.owns.join(", ")}\n\n${run.report || run.error || "(no report yet)"}`,
                )
                .join("\n\n") || "No matching subagents.",
          },
        ],
        details: { runs },
      };
    },
    renderCall(args, theme, context) {
      return callRenderer("subagent_collect", args as Record<string, unknown>, theme, context);
    },
    renderResult: resultRenderer,
  });

  pi.registerTool({
    name: "subagent_steer",
    label: "Steer subagent",
    description:
      "Send guidance to an active subagent, or explicitly revive a parked persistent session with a follow-up.",
    parameters: Type.Object({ id: Type.String(), message: Type.String() }),
    async execute(_toolCallId, params) {
      try {
        const run = await manager.steer(params.id, params.message);
        const snapshot = manager.snapshots().find((item) => item.id === run.id)!;
        return {
          content: [{ type: "text", text: `Guidance accepted by ${run.id}.` }],
          details: { run: snapshot },
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
    label: "Stop subagents",
    description:
      "Stop one or more active subagents and their owned descendants. Persistent transcripts and reports remain available.",
    parameters: Type.Object({ ids: Type.Array(Type.String(), { minItems: 1 }) }),
    async execute(_toolCallId, params) {
      try {
        const stopped: Awaited<ReturnType<SubagentManager["stop"]>>[] = [];
        for (const id of params.ids) stopped.push(await manager.stop(id));
        const snapshots = manager
          .snapshots()
          .filter((snapshot) => stopped.some((run) => run.id === snapshot.id));
        return {
          content: [{ type: "text", text: stopped.map((run) => `Stopped ${run.id}.`).join("\n") }],
          details: { runs: snapshots },
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
