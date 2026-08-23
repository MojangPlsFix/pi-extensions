import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import {
  type CompactionGateEvent,
  type ContinuationCancelEvent,
  type ContinuationEnqueueEvent,
  type ContinuationGateEvent,
  events,
  type HacklerActivityEvent,
  type HacklerBatchGateEvent,
  type HerdrBlockedEvent,
  type ImplementationWaveAdvanceEvent,
  type UserInteractionEvent,
} from "../../shared/events.js";
import {
  CONTINUATION_MESSAGE_TYPE,
  CONTINUATION_STATE_ENTRY,
  ContinuationCoordinator,
  type ContinuationSnapshot,
  type PersistedContinuationRequest,
  withContinuationDetails,
} from "./coordinator.js";
import {
  advanceImplementationWave,
  assistantResponsesAfterAnchor,
  createImplementationWaveState,
  evaluateImplementationFinalization,
  FINALIZATION_PRODUCER_ID,
  FINALIZATION_STATE_ENTRY,
  IMPLEMENTATION_SUMMARY_CONTRACT,
  IMPLEMENTATION_SUMMARY_CORRECTION,
  type ImplementationWaveState,
  parseImplementationWaveState,
  shouldArmForToolResult,
} from "./finalization.js";

export * from "./coordinator.js";
export * from "./finalization.js";

function restoreWave(branch: SessionEntry[]): ImplementationWaveState {
  let state = createImplementationWaveState();
  for (const entry of branch) {
    if (entry.type !== "custom" || entry.customType !== FINALIZATION_STATE_ENTRY) continue;
    const parsed = parseImplementationWaveState(entry.data);
    if (parsed) state = parsed;
  }
  return state;
}

export default function workflowFinalization(pi: ExtensionAPI): void {
  let context: ExtensionContext | undefined;
  let wave = createImplementationWaveState();
  let userInteractionDepth = 0;
  let herdrBlockedDepth = 0;
  const finalizationGates = new Set<string>();
  const batchGates = new Map<string, HacklerBatchGateEvent>();

  const coordinator = new ContinuationCoordinator({
    persist(snapshot: ContinuationSnapshot) {
      pi.appendEntry(CONTINUATION_STATE_ENTRY, snapshot);
    },
    canDispatch() {
      return context?.isIdle() ?? false;
    },
    send(request: PersistedContinuationRequest) {
      pi.sendMessage(
        {
          customType: request.message.customType ?? CONTINUATION_MESSAGE_TYPE,
          content: request.message.content,
          display: request.message.display ?? true,
          details: withContinuationDetails(request.message.details, {
            version: 1,
            requestId: request.requestId,
            producerId: request.producerId,
          }),
        },
        { triggerTurn: true },
      );
      return undefined;
    },
    receipt(event) {
      pi.events.emit(events.continuationReceipt, event);
    },
    activity(event) {
      pi.events.emit(events.continuationActivity, event);
    },
  });

  const persistWave = (): void => pi.appendEntry(FINALIZATION_STATE_ENTRY, wave);

  function maybeFinalize(ctx: ExtensionContext): void {
    if (
      context?.sessionManager.getSessionId() !== ctx.sessionManager.getSessionId() ||
      !ctx.isIdle() ||
      !wave.armed ||
      finalizationGates.size > 0 ||
      coordinator.hasOpenRequests()
    )
      return;

    const branch = ctx.sessionManager.getBranch() as SessionEntry[];
    coordinator.setBranch(branch);
    const transition = evaluateImplementationFinalization(
      wave,
      assistantResponsesAfterAnchor(branch, wave.anchorEntryId),
    );
    if (transition.state !== wave) {
      wave = transition.state;
      persistWave();
    }
    if (transition.action === "queue-correction") {
      const expectedWave = wave.wave;
      pi.events.emit(events.continuationEnqueue, {
        producerId: FINALIZATION_PRODUCER_ID,
        dedupeKey: `wave:${expectedWave}:correction`,
        message: {
          customType: "implementation-summary-correction",
          content: IMPLEMENTATION_SUMMARY_CORRECTION,
          display: true,
        },
        respond(result) {
          if (wave.wave !== expectedWave || !result.requestId) return;
          if (wave.correctionRequestId === result.requestId) return;
          wave = { ...wave, correctionRequestId: result.requestId };
          persistWave();
        },
      } satisfies ContinuationEnqueueEvent);
    } else if (transition.action === "warn" && ctx.hasUI) {
      ctx.ui.notify(
        `Implementation summary is still invalid after one correction (${transition.errors?.join("; ") ?? "unknown error"}).`,
        "warning",
      );
    }
  }

  const setGate = (gateId: string, active: boolean, pump = true, evaluate = true): void => {
    if (active) finalizationGates.add(gateId);
    else finalizationGates.delete(gateId);
    coordinator.setGate(gateId, active, pump);
    if (!active && evaluate && finalizationGates.size === 0 && context) maybeFinalize(context);
  };

  const arm = (reason: string, anchorEntryId?: string): void => {
    if (!context) return;
    const branch = context.sessionManager.getBranch() as SessionEntry[];
    const requestedAnchor =
      typeof anchorEntryId === "string" && branch.some((entry) => entry.id === anchorEntryId)
        ? anchorEntryId
        : undefined;
    const anchor = requestedAnchor ?? branch.at(-1)?.id ?? null;
    wave = advanceImplementationWave(wave, anchor, reason);
    persistWave();
  };

  const reload = (ctx: ExtensionContext): void => {
    context = ctx;
    const branch = ctx.sessionManager.getBranch() as SessionEntry[];
    wave = restoreWave(branch);
    coordinator.restore(
      ctx.sessionManager.getSessionId(),
      ctx.sessionManager.getEntries() as SessionEntry[],
      branch,
      false,
    );
    // restore() intentionally resets runtime gates. Reapply live application
    // gates before allowing an idle dispatch on the newly active branch.
    for (const gateId of finalizationGates) coordinator.setGate(gateId, true);
    coordinator.setIdle(ctx.isIdle());
  };

  pi.events.on(events.continuationEnqueue, (value: unknown) => {
    const event = value as Partial<ContinuationEnqueueEvent> | undefined;
    if (!event || typeof event.producerId !== "string" || !event.message) {
      event?.respond?.({ accepted: false, reason: "invalid continuation request" });
      return;
    }
    if (context) coordinator.setBranch(context.sessionManager.getBranch() as SessionEntry[]);
    const result = coordinator.enqueue(event as ContinuationEnqueueEvent);
    event.respond?.(result);
  });

  pi.events.on(events.continuationCancel, (value: unknown) => {
    const event = value as Partial<ContinuationCancelEvent> | undefined;
    if (typeof event?.producerId === "string")
      coordinator.cancel(event.producerId, event.requestId);
  });

  pi.events.on(events.continuationGate, (value: unknown) => {
    const event = value as Partial<ContinuationGateEvent> | undefined;
    if (typeof event?.gateId === "string" && typeof event.active === "boolean")
      setGate(`external:${event.gateId}`, event.active);
  });

  pi.events.on(events.compactionGate, (value: unknown) => {
    const event = value as Partial<CompactionGateEvent> | undefined;
    if (typeof event?.active !== "boolean") return;
    const operationId =
      typeof event.operationId === "string" && event.operationId ? event.operationId : "legacy";
    const resume = !event.active && event.resume === true;
    // Failure callbacks close gates without re-entering Pi. Successful lifecycle
    // boundaries set resume so the final close can pump and evaluate once.
    setGate(`compaction:external:${operationId}`, event.active, false, false);
    if (!event.active) setGate("compaction:native", false, resume, resume);
  });

  pi.events.on(events.userInteraction, (value: unknown) => {
    const event = value as Partial<UserInteractionEvent> | undefined;
    if (typeof event?.active !== "boolean") return;
    userInteractionDepth = Math.max(0, userInteractionDepth + (event.active ? 1 : -1));
    setGate("ui:user-interaction", userInteractionDepth > 0);
  });

  pi.events.on(events.herdrBlocked, (value: unknown) => {
    const event = value as Partial<HerdrBlockedEvent> | undefined;
    if (typeof event?.active !== "boolean") return;
    herdrBlockedDepth = Math.max(0, herdrBlockedDepth + (event.active ? 1 : -1));
    setGate("ui:herdr", herdrBlockedDepth > 0);
  });

  pi.events.on(events.hacklerBatchGate, (value: unknown) => {
    const event = value as Partial<HacklerBatchGateEvent> | undefined;
    if (!event || typeof event.batchId !== "string" || typeof event.active !== "boolean") return;
    if (event.active && event.relevant !== false)
      batchGates.set(event.batchId, event as HacklerBatchGateEvent);
    else batchGates.delete(event.batchId);
    setGate(`hackler-batch:${event.batchId}`, batchGates.has(event.batchId));
  });

  pi.events.on(events.hacklerActivity, (value: unknown) => {
    const event = value as Partial<HacklerActivityEvent> | undefined;
    if (!event) return;
    const active =
      (typeof event.writers === "number" && event.writers > 0) ||
      (typeof event.integrating === "number" && event.integrating > 0);
    setGate("hackler:write-or-integration", active);
  });

  pi.events.on(events.implementationWaveAdvance, (value: unknown) => {
    const event = value as Partial<ImplementationWaveAdvanceEvent> | undefined;
    if (typeof event?.producerId !== "string" || typeof event.reason !== "string") return;
    if (event.requiresArmed === true && !wave.armed) return;
    arm(
      `${event.producerId}: ${event.reason}`,
      typeof event.branchEntryId === "string" ? event.branchEntryId : undefined,
    );
  });

  pi.on("session_start", (_event, ctx) => reload(ctx));
  pi.on("session_tree", (_event, ctx) => reload(ctx));

  pi.on("session_shutdown", () => {
    context = undefined;
    userInteractionDepth = 0;
    herdrBlockedDepth = 0;
    finalizationGates.clear();
    batchGates.clear();
    wave = createImplementationWaveState();
    coordinator.shutdown();
  });

  pi.on("session_before_compact", () => {
    setGate("compaction:native", true, true, false);
  });
  pi.on("session_compact", (_event, ctx) => {
    context = ctx;
    setGate("compaction:native", false, false, false);
    coordinator.setIdle(ctx.isIdle());
    maybeFinalize(ctx);
  });

  pi.on("agent_start", (_event, ctx) => {
    context = ctx;
    coordinator.setIdle(false);
    coordinator.agentStarted();
  });

  pi.on("tool_result", (event, ctx) => {
    context = ctx;
    if (shouldArmForToolResult(event)) arm(`successful ${event.toolName}`);
  });

  pi.on("before_agent_start", (event) => {
    if (!wave.armed) return;
    return { systemPrompt: `${event.systemPrompt}\n\n${IMPLEMENTATION_SUMMARY_CONTRACT}` };
  });

  pi.on("agent_settled", (_event, ctx) => {
    context = ctx;
    const branch = ctx.sessionManager.getBranch() as SessionEntry[];
    coordinator.observeBranch(ctx.sessionManager.getEntries() as SessionEntry[], branch);
    // Close the flight that just settled before another queued request can start.
    coordinator.agentSettled(ctx.sessionManager.getLeafId() ?? undefined);
    coordinator.setIdle(ctx.isIdle());
    maybeFinalize(ctx);
  });
}
