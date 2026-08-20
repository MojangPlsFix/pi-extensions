import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { capabilityCeilingDiagnostics } from "./capabilities.js";
import { loadSubagentConfig, resolveAgentCapabilities } from "./config.js";
import type { SubagentManager } from "./manager.js";
import { type AgentsOverlayAction, AgentsViewer, formatRun } from "./renderers.js";

const help = [
  "Agent Hub is the authoritative view of active, blocked, parked, and failed subagents.",
  "Completed sessions park automatically and consume no active capacity.",
  "Herdr transcript panes are display-only and never execute or prompt child Pi sessions.",
  "",
  "Tab  Switch Runs / Inbox / Profiles",
  "↑/↓, Home/End, Page Up/Down  Navigate",
  "Enter Answer a request, revive a parked run, or toggle a profile",
  "s    Steer the selected run",
  "x    Stop the selected active run and descendants",
  "t    Open a display-only Herdr transcript",
  "e    Eject a selected built-in profile",
  "r    Refresh configuration and profiles",
  "?    Show this help",
  "Esc  Close the Hub",
].join("\n");

async function openHub(
  manager: SubagentManager,
  ctx: Parameters<Parameters<ExtensionAPI["registerCommand"]>[1]["handler"]>[1],
) {
  for (;;) {
    const initial = await manager.status(ctx);
    const action = await ctx.ui.custom<AgentsOverlayAction>(
      (tui, theme, keybindings, done) =>
        new AgentsViewer(
          tui,
          theme,
          keybindings,
          (listener) => manager.subscribeHub(listener),
          done,
          initial,
        ),
      {
        overlay: true,
        overlayOptions: {
          anchor: "center",
          width: "94%",
          maxHeight: "88%",
          minWidth: 64,
          margin: 1,
        },
      },
    );
    if (action.kind === "close") return;
    if (action.kind === "help") {
      await ctx.ui.editor("Agent Hub controls", help);
      continue;
    }
    if (action.kind === "refresh") continue;
    if (!action.id) continue;
    try {
      if (action.kind === "steer") {
        const guidance = await ctx.ui.editor("Steer or revive subagent", "");
        if (guidance?.trim()) {
          await manager.steer(action.id, guidance);
          ctx.ui.notify("Guidance accepted.", "info");
        }
      } else if (action.kind === "stop") {
        if (
          await ctx.ui.confirm(
            "Stop subagent?",
            "The active turn and descendants stop. Its transcript and current report remain parked.",
          )
        ) {
          await manager.stop(action.id);
          ctx.ui.notify("Subagent stopped and parked.", "info");
        }
      } else if (action.kind === "inspect") {
        await manager.openInspector(action.id);
        ctx.ui.notify("Opened display-only Herdr transcript pane.", "info");
      } else if (action.kind === "answer") {
        const request = manager.inbox.all().find((entry) => entry.id === action.id);
        if (request?.status !== "pending") continue;
        let answer: string | undefined;
        if (request.choices.length) {
          const labels = request.choices.map((choice) =>
            choice.description ? `${choice.label} — ${choice.description}` : choice.label,
          );
          const selected = await ctx.ui.select(request.title, labels);
          const index = selected === undefined ? -1 : labels.indexOf(selected);
          answer = index >= 0 ? request.choices[index]?.value : undefined;
        } else answer = await ctx.ui.editor(request.title, "");
        if (answer?.trim()) await manager.respondRequest(request.id, answer);
      } else if (action.kind === "toggleProfile") {
        const profile = manager
          .hubSnapshot()
          .profiles.find((candidate) => candidate.name === action.id);
        if (!profile) continue;
        const enabled = !(
          profile.metadata?.disabled === true || profile.metadata?.enabled === false
        );
        await manager.setProfileEnabled(profile.name, !enabled, ctx);
        ctx.ui.notify(`${profile.name} ${enabled ? "disabled" : "enabled"}.`, "info");
      } else if (action.kind === "ejectProfile") {
        const target = await ctx.ui.select("Eject profile to", [
          "User configuration",
          "Trusted project",
        ]);
        if (!target) continue;
        const path = await manager.ejectProfile(
          action.id,
          target === "Trusted project" ? "project" : "user",
          ctx,
        );
        ctx.ui.notify(`Ejected profile to ${path}.`, "info");
      }
    } catch (error) {
      ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
    }
  }
}

export function registerAgentsCommand(pi: ExtensionAPI, manager: SubagentManager): void {
  pi.registerCommand("agents", {
    description: "Open the event-driven Agent Hub or print subagent status",
    handler: async (args, ctx) => {
      const words = args.trim().split(/\s+/u).filter(Boolean);
      const operation = words[0]?.toLowerCase();
      if (operation === "help") {
        if (ctx.mode === "tui" && ctx.hasUI) await ctx.ui.editor("Agent Hub controls", help);
        else ctx.ui.notify(help, "info");
        return;
      }
      if (operation === "enable" || operation === "disable") {
        const name = words[1];
        if (!name) {
          ctx.ui.notify(`Usage: /agents ${operation} <profile>`, "error");
          return;
        }
        try {
          await manager.setProfileEnabled(name, operation === "enable", ctx);
          ctx.ui.notify(`${name} ${operation}d.`, "info");
        } catch (error) {
          ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
        }
        return;
      }
      if (operation === "eject") {
        const name = words[1];
        const target = words[2]?.toLowerCase() === "project" ? "project" : "user";
        if (!name) {
          ctx.ui.notify("Usage: /agents eject <built-in> [user|project]", "error");
          return;
        }
        try {
          const path = await manager.ejectProfile(name, target, ctx);
          ctx.ui.notify(`Ejected profile to ${path}.`, "info");
        } catch (error) {
          ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
        }
        return;
      }
      if (operation === "doctor") {
        const hub = await manager.status(ctx);
        const json = args.includes("--json");
        let config: Awaited<ReturnType<typeof loadSubagentConfig>> | undefined;
        try {
          config = await loadSubagentConfig();
        } catch {
          config = undefined;
        }
        const report = {
          schemaVersion: 2,
          profiles: hub.profiles.map((profile) => {
            const policy = config ? resolveAgentCapabilities(profile, config) : undefined;
            if (policy) policy.diagnostics.push(...capabilityCeilingDiagnostics(profile, policy));
            return {
              name: profile.name,
              class: profile.class,
              runner: profile.runner,
              source: profile.source,
              path: profile.path,
              enabled: !(
                profile.metadata?.disabled === true || profile.metadata?.enabled === false
              ),
              tools: profile.tools,
              capabilities: profile.capabilities,
              effectivePolicy: policy
                ? {
                    tools: policy.tools,
                    executableArgvPrefixes: policy.executableArgvPrefixes,
                    skills: policy.skills,
                    envAllowlist: policy.envAllowlist,
                    state: policy.state,
                    approval: policy.approval,
                    diagnostics: policy.diagnostics,
                  }
                : undefined,
            };
          }),
          capabilityCatalog: Object.values(config?.capabilities ?? {}).map((capability) => ({
            name: capability.name,
            description: capability.description,
            extensionPath: capability.extensionPath,
            extensionPackage: capability.extensionPackage,
            toolPatterns: capability.toolPatterns,
            executableArgvPrefixes: capability.executableArgvPrefixes,
            skills: capability.skills,
            envAllowlist: capability.envAllowlist,
            state: capability.state,
            approval: capability.approval,
          })),
          externalRunners: Object.entries(config?.runners ?? {}).map(([name, runner]) => ({
            name,
            command: runner.command,
            args: runner.args,
            envAllowlist: runner.envAllowlist,
          })),
          herdr: config?.herdr,
          diagnostics: hub.diagnostics,
          runs: hub.runs.map((run) => ({
            id: run.id,
            profile: run.name,
            status: run.status,
            model: run.effectiveModel,
            capabilities: run.capabilityNames,
            effectivePolicy: run.capabilityPolicy,
          })),
        };
        ctx.ui.notify(
          json
            ? JSON.stringify(report, null, 2)
            : [
                "Subagents v2 doctor",
                ...report.profiles.map(
                  (profile) =>
                    `- ${profile.name} (${profile.class}, ${profile.runner}, ${profile.enabled ? "enabled" : "disabled"}) · capabilities: ${profile.capabilities.join(", ") || "none"}`,
                ),
                "Capability catalog:",
                ...(report.capabilityCatalog.length
                  ? report.capabilityCatalog.map(
                      (capability) =>
                        `- ${capability.name} · ${capability.state}/${capability.approval} · tools: ${capability.toolPatterns?.join(", ") || "none"}`,
                    )
                  : ["- (none)"]),
                "External runners:",
                ...(report.externalRunners.length
                  ? report.externalRunners.map(
                      (runner) => `- ${runner.name}: ${runner.command} ${runner.args.join(" ")}`,
                    )
                  : ["- (none)"]),
                ...(hub.diagnostics.length
                  ? [
                      "Diagnostics:",
                      ...hub.diagnostics.map((item) => `- ${item.path}: ${item.message}`),
                    ]
                  : ["No profile discovery diagnostics."]),
              ].join("\n"),
          hub.diagnostics.length ? "warning" : "info",
        );
        return;
      }
      if (ctx.mode !== "tui" || !ctx.hasUI) {
        const hub = await manager.status(ctx);
        ctx.ui.notify(
          hub.runs.map((run) => `${run.id}: ${formatRun(run)}\n  ${run.task}`).join("\n") ||
            "No subagents.",
          "info",
        );
        return;
      }
      await openHub(manager, ctx);
    },
  });

  pi.registerCommand("orchestrate", {
    description: "Start one explicit in-session sidecar orchestrator with exclusive scope",
    handler: async (args, ctx) => {
      if (ctx.mode !== "tui" || !ctx.hasUI) {
        ctx.ui.notify("/orchestrate requires the interactive Pi UI.", "error");
        return;
      }
      const task = args.trim() || (await ctx.ui.editor("Orchestrator mission", ""));
      if (!task?.trim()) return;
      const scopeText = await ctx.ui.editor(
        "Exclusive mission scope",
        "path:packages/example, symbol:Example",
      );
      const scope = (scopeText ?? "")
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean);
      if (!scope.length) {
        ctx.ui.notify(
          "The sidecar needs at least one explicit owned path, symbol, or topic.",
          "error",
        );
        return;
      }
      try {
        const mission = await manager.startMission(task, scope, ctx, "worktree");
        ctx.ui.notify(
          `Started ${mission.id}. The sidecar exclusively owns the declared scope.`,
          "info",
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/uncommitted changes|Git repository/iu.test(message)) {
          const fallback = await ctx.ui.confirm(
            "Use the shared checkout?",
            `${message}\n\nContinue with one shared-tree writer instead? Nothing will be stashed or copied.`,
          );
          if (fallback) {
            try {
              const mission = await manager.startMission(task, scope, ctx, "shared");
              ctx.ui.notify(`Started ${mission.id} in the shared checkout.`, "warning");
            } catch (fallbackError) {
              ctx.ui.notify(
                fallbackError instanceof Error ? fallbackError.message : String(fallbackError),
                "error",
              );
            }
          }
        } else ctx.ui.notify(message, "error");
      }
    },
  });
}
