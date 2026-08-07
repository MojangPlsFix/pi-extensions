import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { events, type PlanModeEvent, type SubagentsStatusEvent } from "../../shared/events.js";
import { configureBashPolicy } from "./bash-policy.js";
import { type LoadedPlanModeConfig, loadPlanModeConfig, updatePlanModeConfig } from "./config.js";
import { PlanModeEditor } from "./editor.js";
import { extractProposedPlan } from "./plan-parser.js";
import {
  configurePlanModePolicy,
  isDirectlyDisabledInPlanMode,
  planModeToolBlockReason,
} from "./policy.js";
import { appendPlanModePrompt } from "./prompt.js";
import {
  createDefaultPlanModeState,
  PLAN_MODE_STATE_ENTRY,
  type PlanModeState,
  restorePlanModeState,
} from "./state.js";

const implementCurrent = "Yes, implement this plan";
const implementFresh = "Yes, clear context and implement";
const stayInPlanMode = "No, stay in Plan mode";
const implementationMessage = "Implement the approved plan.";
const freshImplementationPrefix =
  "A previous agent produced the plan below for the user's task. Implement it in a fresh context. Treat the plan as the source of user intent, re-read files as needed, and complete implementation and verification.";
const reviewFailedPrefix = "Plan review failed";

type ReviewResult = {
  reviewerId?: string;
  model?: string;
  report?: string;
  error?: string;
};

function modelReference(model: unknown): string | undefined {
  if (!model || typeof model !== "object") return undefined;
  const value = model as { provider?: unknown; id?: unknown };
  if (typeof value.id !== "string" || !value.id) return undefined;
  return typeof value.provider === "string" && value.provider
    ? `${value.provider}/${value.id}`
    : value.id;
}

type MessageEntryLike = {
  type: string;
  id: string;
  message?: { role?: string; content?: unknown };
};

function assistantText(entry: MessageEntryLike): string | undefined {
  if (
    entry.type !== "message" ||
    entry.message?.role !== "assistant" ||
    !Array.isArray(entry.message.content)
  )
    return undefined;
  const text = entry.message.content
    .filter((block): block is { type: "text"; text: string } =>
      Boolean(
        block &&
          typeof block === "object" &&
          (block as { type?: unknown }).type === "text" &&
          typeof (block as { text?: unknown }).text === "string",
      ),
    )
    .map((block) => block.text)
    .join("\n");
  return text || undefined;
}

function unique(names: string[]): string[] {
  return [...new Set(names)];
}

export default function planModeExtension(pi: ExtensionAPI): void {
  let state = createDefaultPlanModeState();
  let approvalOpen = false;
  let freshSessionScheduled = false;
  let latestCommandContext: ExtensionCommandContext | undefined;
  let activeTui: TUI | undefined;
  let previousEditorFactory: ReturnType<ExtensionContext["ui"]["getEditorComponent"]> | undefined;
  let editorInstalled = false;
  let activeWorkers = 0;
  let loadedConfig: LoadedPlanModeConfig = {
    readOnlyTools: [],
    readOnlyCommands: {},
    warnings: [],
    globalPath: "",
  };

  async function reloadPolicy(ctx: ExtensionContext): Promise<void> {
    loadedConfig = await loadPlanModeConfig({
      cwd: ctx.cwd,
      trusted: typeof ctx.isProjectTrusted === "function" && ctx.isProjectTrusted(),
    });
    configurePlanModePolicy(loadedConfig);
    configureBashPolicy(loadedConfig);
    for (const warning of loadedConfig.warnings) {
      if (ctx.hasUI) ctx.ui.notify(warning, "warning");
      else console.error(`[plan-mode] ${warning}`);
    }
  }

  async function selectReviewerModel(ctx: ExtensionCommandContext): Promise<string | undefined> {
    if (!ctx.hasUI) {
      ctx.ui.notify(`${reviewFailedPrefix}: interactive model selection is unavailable.`, "error");
      return undefined;
    }
    try {
      await ctx.modelRegistry.refresh();
      const scoped = (ctx.scopedModels ?? [])
        .map((entry) => modelReference(entry.model))
        .filter((model): model is string => Boolean(model));
      const available = scoped.length
        ? scoped
        : ctx.modelRegistry
            .getAll()
            .map((model) => modelReference(model))
            .filter((model): model is string => Boolean(model));
      const models = [...new Set(available)].sort();
      if (!models.length) {
        ctx.ui.notify(`${reviewFailedPrefix}: no scoped or available models.`, "error");
        return undefined;
      }
      const selected = await ctx.ui.select("Select a model for this plan review", models);
      if (!selected) {
        ctx.ui.notify(`${reviewFailedPrefix}: cancelled.`, "warning");
        return undefined;
      }
      if (!models.includes(selected)) {
        ctx.ui.notify(`${reviewFailedPrefix}: selected model is unavailable.`, "error");
        return undefined;
      }
      return selected;
    } catch (error) {
      ctx.ui.notify(
        `${reviewFailedPrefix}: could not load available models: ${error instanceof Error ? error.message : String(error)}`,
        "error",
      );
      return undefined;
    }
  }

  function requestPlanReview(
    task: string,
    model: string,
    ctx: ExtensionCommandContext,
  ): Promise<ReviewResult> {
    return new Promise((resolve) => {
      let settled = false;
      let accepted = false;
      const finish = (result: ReviewResult): void => {
        if (settled) return;
        settled = true;
        resolve(result);
      };
      pi.events.emit(events.planReview, {
        task,
        model,
        ctx,
        accept: () => {
          accepted = true;
        },
        respond: finish,
      });
      // A Plan Mode-only installation has no reviewer service; fail clearly rather than hanging.
      setTimeout(() => {
        if (!accepted) finish({ error: "Subagent reviewer service is unavailable." });
      }, 100);
    });
  }

  const requestRender = (): void => activeTui?.requestRender();
  const emitMode = (): void =>
    pi.events.emit(events.planMode, { enabled: state.mode === "plan" } satisfies PlanModeEvent);

  function persistState(): void {
    pi.appendEntry(PLAN_MODE_STATE_ENTRY, {
      ...state,
      disabledTools: [...state.disabledTools],
      ...(state.latestPlan ? { latestPlan: { ...state.latestPlan } } : {}),
    });
  }

  function restoreTools(names: string[]): void {
    if (names.length === 0) return;
    const available = new Set(pi.getAllTools().map((tool) => tool.name));
    pi.setActiveTools(
      unique([...pi.getActiveTools(), ...names.filter((name) => available.has(name))]),
    );
  }

  function disableDirectMutators(): boolean {
    const active = pi.getActiveTools();
    const removed = active.filter(isDirectlyDisabledInPlanMode);
    if (removed.length === 0) return false;
    state.disabledTools = unique([...state.disabledTools, ...removed]);
    pi.setActiveTools(active.filter((name) => !isDirectlyDisabledInPlanMode(name)));
    return true;
  }

  function synchronizeState(ctx: ExtensionContext): void {
    restoreTools(state.disabledTools);
    state = restorePlanModeState(ctx.sessionManager.getBranch());
    if (state.mode === "plan") disableDirectMutators();
    emitMode();
    requestRender();
  }

  function enter(ctx: ExtensionContext): void {
    if (state.mode === "plan") return;
    state = { ...state, mode: "plan", disabledTools: [] };
    disableDirectMutators();
    persistState();
    emitMode();
    requestRender();
    ctx.ui.notify("Plan Mode enabled. Use /plan off to leave without implementing.", "info");
  }

  function leave(ctx: ExtensionContext, notify = true): void {
    if (state.mode !== "plan") return;
    restoreTools(state.disabledTools);
    state = { ...state, mode: "default", disabledTools: [] };
    persistState();
    emitMode();
    requestRender();
    if (notify) ctx.ui.notify("Plan Mode disabled.", "info");
  }

  function installEditorIndicator(ctx: ExtensionContext): void {
    if (ctx.mode !== "tui" || editorInstalled) return;
    previousEditorFactory = ctx.ui.getEditorComponent();
    // Never replace another extension's concrete editor: preserving its input behavior takes precedence.
    if (previousEditorFactory) return;
    ctx.ui.setEditorComponent((tui, theme, keybindings) => {
      activeTui = tui;
      return new PlanModeEditor(tui, theme, keybindings, () => state.mode === "plan");
    });
    editorInstalled = true;
  }

  async function startFreshImplementation(
    plan: string,
    ctx: ExtensionCommandContext,
  ): Promise<void> {
    if (!ctx.isIdle()) {
      ctx.ui.notify("Fresh implementation is unavailable while the agent is working.", "warning");
      return;
    }
    const sourceEntryId = state.latestPlan?.sourceEntryId;
    const replacementState: PlanModeState = {
      ...createDefaultPlanModeState(),
      ...(state.latestPlan ? { latestPlan: { ...state.latestPlan } } : {}),
      ...(state.lastOfferedEntryId ? { lastOfferedEntryId: state.lastOfferedEntryId } : {}),
      ...(sourceEntryId ? { implementedPlanSourceEntryId: sourceEntryId } : {}),
      ...(state.lastReview ? { lastReview: { ...state.lastReview } } : {}),
    };
    const result = await ctx.newSession({
      parentSession: ctx.sessionManager.getSessionFile(),
      setup: async (sessionManager) => {
        sessionManager.appendCustomEntry(PLAN_MODE_STATE_ENTRY, replacementState);
      },
      withSession: async (replacement) => {
        await replacement.sendUserMessage(`${freshImplementationPrefix}\n\n${plan}`);
      },
    });
    if (result?.cancelled !== true && sourceEntryId) consumePlan(sourceEntryId);
  }

  function consumePlan(sourceEntryId: string): void {
    state = { ...state, implementedPlanSourceEntryId: sourceEntryId };
    persistState();
  }

  async function implementPlan(args: string, ctx: ExtensionCommandContext): Promise<void> {
    latestCommandContext = ctx;
    if (!ctx.isIdle()) {
      ctx.ui.notify("Plan implementation is unavailable while the agent is working.", "warning");
      return;
    }
    const plan = state.latestPlan?.markdown;
    if (!plan) {
      ctx.ui.notify("No approved plan is available.", "warning");
      return;
    }
    const sourceEntryId = state.latestPlan!.sourceEntryId;
    if (state.implementedPlanSourceEntryId === sourceEntryId) {
      ctx.ui.notify(
        "This plan has already been implemented. Produce a newer plan before retrying.",
        "warning",
      );
      return;
    }
    if (args.trim().toLowerCase() === "fresh") {
      await startFreshImplementation(plan, ctx);
      return;
    }
    consumePlan(sourceEntryId);
    leave(ctx, false);
    pi.sendUserMessage(implementationMessage);
  }

  pi.registerCommand("plan", {
    description: "Enter Plan Mode; use /plan off to leave or /plan <request> to start planning",
    getArgumentCompletions: (argumentPrefix) =>
      state.mode === "plan" && "off".startsWith(argumentPrefix.trim().toLowerCase())
        ? [{ value: "off", label: "off", description: "Leave Plan Mode" }]
        : null,
    handler: async (args, ctx) => {
      latestCommandContext = ctx;
      if (!ctx.isIdle()) {
        ctx.ui.notify("Plan Mode is unavailable while the agent is working.", "warning");
        return;
      }
      const request = args.trim();
      if (request.toLowerCase() === "off") {
        if (state.mode !== "plan") ctx.ui.notify("Plan Mode is not active.", "info");
        else leave(ctx);
        return;
      }
      if (state.mode !== "plan" && activeWorkers > 0) {
        ctx.ui.notify("Plan Mode cannot start while a worker subagent is running.", "warning");
        return;
      }
      if (state.mode === "plan" && !request) {
        ctx.ui.notify("Plan Mode is already active. Use /plan off to leave.", "info");
        return;
      }
      enter(ctx);
      if (request) pi.sendUserMessage(request);
    },
  });

  pi.registerCommand("plan-implement", {
    description: "Implement the latest proposed plan; pass 'fresh' to use a new session",
    getArgumentCompletions: (argumentPrefix) =>
      "fresh".startsWith(argumentPrefix.trim().toLowerCase())
        ? [{ value: "fresh", label: "fresh", description: "Use a new session" }]
        : null,
    handler: implementPlan,
  });

  pi.registerCommand("plan-review", {
    description: "Review the latest plan with a selected read-only Explorer model",
    handler: async (_args, ctx) => {
      latestCommandContext = ctx;
      if (state.mode !== "plan") {
        ctx.ui.notify(`${reviewFailedPrefix}: Plan Mode is not active.`, "error");
        return;
      }
      if (!state.latestPlan?.markdown) {
        ctx.ui.notify(`${reviewFailedPrefix}: no latest plan is available.`, "error");
        return;
      }
      if (state.implementedPlanSourceEntryId === state.latestPlan.sourceEntryId) {
        ctx.ui.notify(
          `${reviewFailedPrefix}: the latest plan was already consumed; produce a newer plan.`,
          "error",
        );
        return;
      }
      if (!ctx.isIdle()) {
        ctx.ui.notify(`${reviewFailedPrefix}: the parent agent must be idle.`, "error");
        return;
      }
      if (activeWorkers > 0) {
        ctx.ui.notify(`${reviewFailedPrefix}: a Worker is active.`, "error");
        return;
      }
      const model = await selectReviewerModel(ctx);
      if (!model) return;
      const sourceEntryId = state.latestPlan.sourceEntryId;
      const result = await requestPlanReview(
        [
          "Review this Plan Mode proposal. The report is advisory: never approve or implement it.",
          `Plan source ID: ${sourceEntryId}`,
          "Return findings, risks, omissions, and concrete revisions for the parent.",
          "",
          state.latestPlan.markdown,
        ].join("\n\n"),
        model,
        ctx,
      );
      if (result.error || !result.report || !result.reviewerId || !result.model) {
        ctx.ui.notify(
          `${reviewFailedPrefix}: ${result.error ?? "reviewer returned no report."}`,
          "error",
        );
        return;
      }
      const review = {
        planSourceEntryId: sourceEntryId,
        reviewerId: result.reviewerId,
        model: result.model,
        reviewedAt: new Date().toISOString(),
        report: result.report,
      };
      state = { ...state, lastReview: review };
      persistState();
      pi.sendMessage(
        {
          customType: "plan-review",
          content: [
            `Advisory plan review for ${sourceEntryId} using ${result.model}:`,
            "",
            result.report,
            "",
            "Plan Mode revision instruction: Treat this report as advisory. Review the findings and revise the proposed plan if needed, then remain in Plan Mode. Do not approve or implement the plan in this turn.",
          ].join("\n"),
          display: true,
          details: review,
        },
        { triggerTurn: true },
      );
      ctx.ui.notify(
        "Plan review completed. The report is available for revising the plan; it did not approve implementation.",
        "info",
      );
    },
  });

  pi.registerCommand("plan-tools", {
    description: "Review and configure read-only Pi tools and CLI commands for Plan Mode",
    handler: async (_args, ctx) => {
      if (state.mode === "plan") {
        ctx.ui.notify(
          "Plan Mode is active. Leave Plan Mode before changing its tool policy.",
          "warning",
        );
        return;
      }
      if (!ctx.hasUI) {
        ctx.ui.notify("/plan-tools requires interactive UI.", "warning");
        return;
      }
      const scopeChoice = await ctx.ui.select("Where should approvals be stored?", [
        "Global",
        ...(typeof ctx.isProjectTrusted === "function" && ctx.isProjectTrusted()
          ? ["Project"]
          : []),
      ]);
      if (!scopeChoice) return;
      const path = scopeChoice === "Project" ? loadedConfig.projectPath : loadedConfig.globalPath;
      if (!path) {
        ctx.ui.notify(
          "The project is not trusted, so project configuration is unavailable.",
          "warning",
        );
        return;
      }
      const kind = await ctx.ui.select("What should Plan Mode allow?", [
        "Pi tool",
        "CLI program",
        "Remove approval",
        "Done",
      ]);
      if (kind === "Pi tool") {
        const tools = pi.getAllTools().filter((tool) => !isDirectlyDisabledInPlanMode(tool.name));
        const selected = await ctx.ui.select("Select an external Pi tool to allow", [
          ...tools.map((tool) => `${tool.name} — ${tool.sourceInfo.source}`),
          "Cancel",
        ]);
        const name = selected?.split(" — ")[0];
        if (name && name !== "Cancel") {
          const accepted = await ctx.ui.confirm(
            "Confirm Plan Mode approval",
            `Allow Pi tool '${name}'?`,
          );
          if (!accepted) return;
          await updatePlanModeConfig(path, { addTools: [name] });
          await reloadPolicy(ctx);
          ctx.ui.notify(`Approved Pi tool '${name}' for Plan Mode.`, "info");
        }
      } else if (kind === "CLI program") {
        const program = await ctx.ui.input("Program", "example-cli");
        const commandText = await ctx.ui.input(
          "Read-only subcommands (comma separated)",
          "help, inspect, list",
        );
        if (!program || !commandText) return;
        const commands = commandText
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean);
        const accepted = await ctx.ui.confirm(
          "Confirm Plan Mode approval",
          `${program}: ${commands.join(", ")}`,
        );
        if (!accepted) return;
        await updatePlanModeConfig(path, { addCommands: { [program.trim()]: commands } });
        await reloadPolicy(ctx);
        ctx.ui.notify(`Approved read-only commands for '${program.trim()}'.`, "info");
      } else if (kind === "Remove approval") {
        const programs = Object.keys(loadedConfig.readOnlyCommands);
        const selected = await ctx.ui.select("Select an approval to remove", [
          ...loadedConfig.readOnlyTools.map((name) => `tool:${name}`),
          ...programs.flatMap((program) =>
            (loadedConfig.readOnlyCommands[program] ?? []).map(
              (command) => `command:${program}:${command}`,
            ),
          ),
          "Cancel",
        ]);
        if (!selected || selected === "Cancel") return;
        if (selected.startsWith("tool:"))
          await updatePlanModeConfig(path, { removeTools: [selected.slice(5)] });
        else if (selected.startsWith("command:")) {
          const [, program, command] = selected.split(":");
          if (!program || !command) return;
          await updatePlanModeConfig(path, { removeCommands: { [program]: [command] } });
        }
        await reloadPolicy(ctx);
        ctx.ui.notify("Plan Mode approval removed.", "info");
      }
    },
  });

  pi.on("tool_call", (event) => {
    if (state.mode !== "plan") return;
    const reason = planModeToolBlockReason(event.toolName, event.input);
    return reason ? { block: true, reason } : undefined;
  });

  pi.on("before_agent_start", (event) => {
    if (state.mode !== "plan") return;
    if (disableDirectMutators()) persistState();
    return { systemPrompt: appendPlanModePrompt(event.systemPrompt) };
  });

  pi.on("agent_settled", async (_event, ctx) => {
    if (
      state.mode !== "plan" ||
      approvalOpen ||
      !ctx.hasUI ||
      !ctx.isIdle() ||
      ctx.hasPendingMessages()
    )
      return;
    const latest = [...ctx.sessionManager.getBranch()]
      .reverse()
      .find((entry) => assistantText(entry as MessageEntryLike)) as MessageEntryLike | undefined;
    if (!latest || latest.id === state.lastOfferedEntryId) return;
    const parsed = extractProposedPlan(assistantText(latest) ?? "");
    if (!parsed.plan) {
      if (parsed.error)
        ctx.ui.notify(`Invalid <proposed_plan> response: ${parsed.error}.`, "warning");
      return;
    }
    state = {
      ...state,
      latestPlan: { markdown: parsed.plan, sourceEntryId: latest.id },
      implementedPlanSourceEntryId: undefined,
      lastReview: undefined,
      lastOfferedEntryId: latest.id,
    };
    persistState();
    requestRender();

    approvalOpen = true;
    try {
      const choice = await ctx.ui.select("Implement this plan?", [
        implementCurrent,
        implementFresh,
        stayInPlanMode,
      ]);
      if (choice === implementCurrent) {
        consumePlan(latest.id);
        leave(ctx, false);
        pi.sendUserMessage(implementationMessage, { deliverAs: "followUp" });
      } else if (choice === implementFresh) {
        const plan = state.latestPlan?.markdown;
        if (!latestCommandContext || !plan) {
          ctx.ui.setEditorText("/plan-implement fresh");
          ctx.ui.notify(
            "Fresh implementation is ready. Press Enter to run /plan-implement fresh.",
            "warning",
          );
        } else if (!freshSessionScheduled) {
          const commandContext = latestCommandContext;
          freshSessionScheduled = true;
          setImmediate(() => {
            void startFreshImplementation(plan, commandContext)
              .catch((error: unknown) =>
                commandContext.ui.notify(
                  `Could not start fresh implementation: ${error instanceof Error ? error.message : String(error)}`,
                  "error",
                ),
              )
              .finally(() => {
                freshSessionScheduled = false;
              });
          });
        }
      }
    } finally {
      approvalOpen = false;
    }
  });

  pi.events.on(events.subagentsStatus, (data: unknown) => {
    const status = data as Partial<SubagentsStatusEvent> | undefined;
    activeWorkers = typeof status?.workers === "number" ? status.workers : 0;
  });

  pi.on("session_start", async (_event, ctx) => {
    await reloadPolicy(ctx);
    synchronizeState(ctx);
    installEditorIndicator(ctx);
  });
  pi.on("session_tree", async (_event, ctx) => {
    await reloadPolicy(ctx);
    synchronizeState(ctx);
  });
  pi.on("session_shutdown", (_event, ctx) => {
    restoreTools(state.disabledTools);
    if (editorInstalled && ctx.mode === "tui") ctx.ui.setEditorComponent(previousEditorFactory);
    activeTui = undefined;
    previousEditorFactory = undefined;
    editorInstalled = false;
  });
}
