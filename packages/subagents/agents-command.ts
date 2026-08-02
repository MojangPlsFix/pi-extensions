import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { SubagentManager } from "./manager.js";
import { type AgentsOverlayAction, AgentsViewer, formatAgent } from "./renderers.js";

export function registerAgentsCommand(pi: ExtensionAPI, manager: SubagentManager): void {
  pi.registerCommand("agents", {
    description: "Open the live local subagent activity viewer",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui" || !ctx.hasUI) {
        ctx.ui.notify(
          manager
            .snapshots()
            .map((agent) => `${agent.id}: ${formatAgent(agent)}`)
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
      if (!action.id || action.kind === "close") return;
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
      try {
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
