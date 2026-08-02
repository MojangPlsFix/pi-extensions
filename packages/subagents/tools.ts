import { type ExtensionAPI, keyHint } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { SubagentManager } from "./manager.js";
import { formatAgent } from "./renderers.js";
import type { AgentSnapshot } from "./types.js";

function snapshots(details: unknown): AgentSnapshot[] {
  if (!details || typeof details !== "object") return [];
  const value = details as { agent?: AgentSnapshot; agents?: AgentSnapshot[] };
  return Array.isArray(value.agents) ? value.agents : value.agent ? [value.agent] : [];
}

function expandHint(): string {
  try {
    return keyHint("app.tools.expand", "to expand");
  } catch {
    return "Ctrl+O to expand";
  }
}

function toolSummary(agents: AgentSnapshot[]): string {
  if (!agents.length) return "No matching subagent.";
  return agents
    .map(
      (agent) =>
        `${agent.status === "running" ? "●" : "○"} ${formatAgent(agent)} · ${agent.backend}${agent.herdrPaneId ? ` pane ${agent.herdrPaneId}` : ""} · ${agent.latestActivity ?? "waiting…"}`,
    )
    .join("\n");
}

function resultRenderer(
  result: { details?: unknown; content?: Array<{ type?: string; text?: string }> },
  options: { expanded: boolean; isPartial: boolean },
  theme: { fg(color: string, text: string): string },
  context: { lastComponent?: unknown; isError?: boolean },
) {
  const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
  const agents = snapshots(result.details);
  const content =
    result.content
      ?.filter((item) => item.type === "text")
      .map((item) => item.text ?? "")
      .join("\n") ?? "";
  if (options.isPartial) {
    text.setText(theme.fg("muted", "Subagent operation in progress…"));
    return text;
  }
  // Every completed subagent result is compact by default, including errors and one-line replies.
  if (!options.expanded) {
    const summary = agents.length
      ? toolSummary(agents)
      : context.isError
        ? "Subagent operation failed."
        : "Subagent operation completed.";
    text.setText(
      `${theme.fg(context.isError ? "error" : "muted", summary)}\n${theme.fg("dim", expandHint())}`,
    );
    return text;
  }
  if (context.isError) {
    text.setText(theme.fg("error", content || "Subagent operation failed."));
    return text;
  }
  const details = agents
    .map((agent) =>
      [
        toolSummary([agent]),
        `Task history:\n${agent.taskHistory.map((task, index) => `${index + 1}. ${task}`).join("\n") || "(none)"}`,
        `Requested: ${agent.requestedModel ?? "default"} · ${agent.requestedThinking ?? "default"}`,
        `Effective: ${agent.effectiveModel ?? "pending confirmation"} · ${agent.effectiveThinking ?? "pending confirmation"}`,
        `Started: ${agent.startedAt}${agent.finishedAt ? `\nFinished: ${agent.finishedAt}` : ""}`,
        `Activity:\n${agent.activity.map((entry) => `${entry.at} · ${entry.kind} · ${entry.text}`).join("\n") || "(none)"}`,
        agent.report ? `Report:\n${agent.report}` : "",
        agent.stderr ? `Stderr:\n${agent.stderr}` : "",
        agent.error ? `Error:\n${agent.error}` : "",
      ]
        .filter(Boolean)
        .join("\n\n"),
    )
    .join("\n\n---\n\n");
  text.setText(theme.fg("toolOutput", details || content || "No subagent details."));
  return text;
}

function callRenderer(
  label: string,
  args: Record<string, unknown>,
  theme: { fg(color: string, text: string): string; bold(text: string): string },
  context: { lastComponent?: unknown; isPartial?: boolean },
) {
  const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
  const preview =
    typeof args.task === "string"
      ? args.task
      : typeof args.message === "string"
        ? args.message
        : typeof args.id === "string"
          ? args.id
          : "";
  text.setText(
    theme.fg("toolTitle", theme.bold(`${label} `)) +
      theme.fg("dim", preview.slice(0, 100)) +
      (context.isPartial ? theme.fg("muted", " · working") : ""),
  );
  return text;
}

export function registerSubagentTools(pi: ExtensionAPI, manager: SubagentManager): void {
  pi.registerTool({
    name: "subagent_spawn",
    label: "Subagent spawn",
    description:
      "Start a persistent isolated subagent. Omit agent for all read-only investigation, documentation lookup, and current web research: this selects explorer. Specify agent: worker only when the delegated task must modify files. Never invent agent names such as research or web-researcher; custom names are only valid when listed by subagent_list. It returns after prompt acceptance; use subagent_wait or subagent_read for completion.",
    parameters: Type.Object({
      agent: Type.Optional(
        Type.String({
          description:
            "Optional. Omit for read-only research and investigation (explorer is the default). Use worker only for file-changing implementation. Do not invent profile names; use a custom name only after subagent_list shows it.",
        }),
      ),
      task: Type.String(),
    }),
    async execute(_id, params, _signal, _update, ctx) {
      try {
        const agent = await manager.spawn(params.agent, params.task, ctx);
        return {
          content: [{ type: "text", text: `Started ${agent.name} as ${agent.id}.` }],
          details: { agent: manager.snapshots().find((value) => value.id === agent.id)! },
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
      return callRenderer("subagent_spawn", args as Record<string, unknown>, theme, context);
    },
    renderResult: resultRenderer,
  });
  pi.registerTool({
    name: "subagent_send",
    label: "Subagent send",
    description: "Queue a non-destructive follow-up instruction to a persistent subagent.",
    parameters: Type.Object({ id: Type.String(), message: Type.String() }),
    async execute(_id, params) {
      try {
        const agent = await manager.send(params.id, params.message);
        return {
          content: [{ type: "text", text: `Queued follow-up for ${agent.name}.` }],
          details: { agent: manager.snapshots().find((value) => value.id === agent.id)! },
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
      return callRenderer("subagent_send", args as Record<string, unknown>, theme, context);
    },
    renderResult: resultRenderer,
  });
  pi.registerTool({
    name: "subagent_wait",
    label: "Subagent wait",
    description: "Wait until one or all subagents settle and return their reports.",
    parameters: Type.Object({
      id: Type.Optional(Type.String()),
      all: Type.Optional(Type.Boolean()),
    }),
    async execute(_id, params, signal) {
      const done = await manager.wait(params.id, params.all, signal);
      if (!done.length)
        return {
          content: [{ type: "text", text: "No matching running subagents." }],
          details: { agents: [] },
        };
      const agents = manager
        .snapshots()
        .filter((value) => done.some((agent) => agent.id === value.id));
      return {
        content: [
          {
            type: "text",
            text: done
              .map(
                (agent) =>
                  `## ${formatAgent(agent)}\n\n${agent.output || agent.error || "(no report)"}`,
              )
              .join("\n\n"),
          },
        ],
        details: { agents },
      };
    },
    renderCall(args, theme, context) {
      return callRenderer("subagent_wait", args as Record<string, unknown>, theme, context);
    },
    renderResult: resultRenderer,
  });
  pi.registerTool({
    name: "subagent_list",
    label: "Subagent list",
    description: "List current and completed subagents.",
    parameters: Type.Object({}),
    async execute() {
      const agents = manager.snapshots();
      return {
        content: [
          {
            type: "text",
            text:
              agents.map((agent) => `${agent.id}: ${formatAgent(agent)}`).join("\n") ||
              "No subagents.",
          },
        ],
        details: { agents },
      };
    },
    renderCall(args, theme, context) {
      return callRenderer("subagent_list", args as Record<string, unknown>, theme, context);
    },
    renderResult: resultRenderer,
  });
  pi.registerTool({
    name: "subagent_read",
    label: "Subagent read",
    description: "Read a subagent's latest report and usage.",
    parameters: Type.Object({ id: Type.String() }),
    async execute(_id, params) {
      const agent = manager.snapshots().find((value) => value.id === params.id);
      return agent
        ? {
            content: [
              {
                type: "text",
                text: `${formatAgent(agent)}\n\n${agent.report || agent.error || "(running; no report yet)"}`,
              },
            ],
            details: { agent },
          }
        : { content: [{ type: "text", text: "Unknown subagent." }], details: {}, isError: true };
    },
    renderCall(args, theme, context) {
      return callRenderer("subagent_read", args as Record<string, unknown>, theme, context);
    },
    renderResult: resultRenderer,
  });
  pi.registerTool({
    name: "subagent_interrupt",
    label: "Subagent interrupt",
    description: "Interrupt a running subagent.",
    parameters: Type.Object({ id: Type.String() }),
    async execute(_id, params) {
      try {
        const agent = await manager.interrupt(params.id);
        return {
          content: [{ type: "text", text: `Interrupted ${agent.name}.` }],
          details: { agent: manager.snapshots().find((value) => value.id === agent.id)! },
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
      return callRenderer("subagent_interrupt", args as Record<string, unknown>, theme, context);
    },
    renderResult: resultRenderer,
  });
}
