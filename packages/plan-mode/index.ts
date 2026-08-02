import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { events, type PlanModeEvent, type SubagentsStatusEvent } from "../../shared/events.js";
import { PlanModeEditor } from "./editor.js";
import { extractProposedPlan } from "./plan-parser.js";
import { isDirectlyDisabledInPlanMode, planModeToolBlockReason } from "./policy.js";
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
    const replacementState: PlanModeState = {
      ...createDefaultPlanModeState(),
      ...(state.latestPlan ? { latestPlan: { ...state.latestPlan } } : {}),
      ...(state.lastOfferedEntryId ? { lastOfferedEntryId: state.lastOfferedEntryId } : {}),
    };
    await ctx.newSession({
      parentSession: ctx.sessionManager.getSessionFile(),
      setup: async (sessionManager) => {
        sessionManager.appendCustomEntry(PLAN_MODE_STATE_ENTRY, replacementState);
      },
      withSession: async (replacement) => {
        await replacement.sendUserMessage(`${freshImplementationPrefix}\n\n${plan}`);
      },
    });
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
    if (args.trim().toLowerCase() === "fresh") {
      await startFreshImplementation(plan, ctx);
      return;
    }
    leave(ctx, false);
    pi.sendUserMessage(implementationMessage);
  }

  pi.registerCommand("plan", {
    description: "Enter Plan Mode; use /plan off to leave or /plan <request> to start planning",
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
    handler: implementPlan,
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

  pi.on("session_start", (_event, ctx) => {
    synchronizeState(ctx);
    installEditorIndicator(ctx);
  });
  pi.on("session_tree", (_event, ctx) => synchronizeState(ctx));
  pi.on("session_shutdown", (_event, ctx) => {
    restoreTools(state.disabledTools);
    if (editorInstalled && ctx.mode === "tui") ctx.ui.setEditorComponent(previousEditorFactory);
    activeTui = undefined;
    previousEditorFactory = undefined;
    editorInstalled = false;
  });
}
