import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { SubagentManager } from "./manager.js";
import { type AgentsOverlayAction, AgentsViewer, formatAgent } from "./renderers.js";

const help = [
  "/agents shows complete Subagent history; the inline block is intentionally limited to four.",
  "Role models and resources: ~/.pi/agent/subagents/config.json (run /reload after edits).",
  "Use subagent_list or /agents to verify the effective model after the next child spawns.",
  "",
  "↑/↓  Navigate",
  "Enter Guide the selected open agent (also resumes a completed agent)",
  "s    Stop the running turn and redirect it",
  "f    Focus the selected Herdr pane without automatic focus stealing",
  "x    Close the selected agent and release its capacity",
  "r    Refresh",
  "?    Show this help",
  "Esc  Close the overlay",
].join("\n");

export function registerAgentsCommand(pi: ExtensionAPI, manager: SubagentManager): void {
  pi.registerCommand("agents", {
    description: "Open complete Subagent activity, reports, Herdr focus, and cleanup controls",
    handler: async (args, ctx) => {
      if (args.trim().toLowerCase() === "help") {
        if (ctx.mode === "tui" && ctx.hasUI) await ctx.ui.editor("Subagent controls", help);
        else ctx.ui.notify(help, "info");
        return;
      }
      if (ctx.mode !== "tui" || !ctx.hasUI) {
        ctx.ui.notify(
          manager
            .snapshots()
            .map((agent) => `${agent.id}: ${formatAgent(agent)}\n  ${agent.task}`)
            .join("\n") || "No subagents.",
          "info",
        );
        return;
      }
      const action = await ctx.ui.custom<AgentsOverlayAction>(
        (tui, theme, keybindings, done) =>
          new AgentsViewer(tui, theme, keybindings, () => manager.snapshots(), done),
        {
          overlay: true,
          overlayOptions: {
            anchor: "center",
            width: "92%",
            maxHeight: "84%",
            minWidth: 60,
            margin: 1,
          },
        },
      );
      if (action.kind === "help") {
        await ctx.ui.editor("Subagent controls", help);
        return;
      }
      if (!action.id || action.kind === "close") return;
      try {
        if (action.kind === "focus") {
          await manager.focus(action.id);
          return;
        }
        if (action.kind === "closeAgent") {
          if (
            await ctx.ui.confirm(
              "Close subagent?",
              "Its report remains readable, but its transport and Herdr pane are removed.",
            )
          ) {
            await manager.close(action.id);
            ctx.ui.notify("Subagent closed.", "info");
          }
          return;
        }
        const instruction = await ctx.ui.editor(
          action.kind === "guide" ? "Guide subagent" : "Stop & redirect subagent",
          "",
        );
        if (!instruction?.trim()) return;
        if (
          action.kind === "redirect" &&
          !(await ctx.ui.confirm(
            "Stop & redirect subagent?",
            "The active turn will be interrupted before this replacement instruction is sent.",
          ))
        )
          return;
        if (action.kind === "guide") await manager.send(action.id, instruction);
        else await manager.redirect(action.id, instruction);
        ctx.ui.notify(
          action.kind === "guide" ? "Guidance queued." : "Subagent interrupted and redirected.",
          "info",
        );
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });
}
