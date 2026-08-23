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
  let runtimeGeneration = 0;
  let userInteractionDepth = 0;
  let herdrBlockedDepth = 0;
  const finalizationGates = new Set<string>();
  const batchGates = new Map<string, HacklerBatchGateEvent>();

  const coordinator = new ContinuationCoordinator({
    persist(snapshot: ContinuationSnapshot) {
      pi.appendEntry(CONTINUATION_STATE_ENTRY, snapshot);
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
      return { entryId: context?.sessionManager.getLeafId() ?? undefined };
    },
    receipt(event) {
      pi.events.emit(events.continuationReceipt, event);
    },
    activity(event) {
      pi.events.emit(events.continuationActivity, event);
    },
  });

  const persistWave = (): void => pi.appendEntry(FINALIZATION_STATE_ENTRY, wave);

  const setGate = (gateId: string, active: boolean): void => {
    if (active) finalizationGates.add(gateId);
    else finalizationGates.delete(gateId);
    coordinator.setGate(gateId, active);
  };

  const arm = (reason: string, anchorEntryId?: string): void => {
    if (!context) return;
    const branch = context.sessionManager.getBranch() as SessionEntry[];
    const anchor = anchorEntryId ?? branch.at(-1)?.id ?? null;
    wave = advanceImplementationWave(wave, anchor, reason);
    persistWave();
  };

  const reload = (ctx: ExtensionContext): void => {
    runtimeGeneration += 1;
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
    if (typeof event?.active === "boolean") setGate("compaction:external", event.active);
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
    arm(`${event.producerId}: ${event.reason}`, event.branchEntryId);
  });

  pi.on("session_start", (_event, ctx) => reload(ctx));
  pi.on("session_tree", (_event, ctx) => reload(ctx));

  pi.on("session_shutdown", () => {
    runtimeGeneration += 1;
    context = undefined;
    userInteractionDepth = 0;
    herdrBlockedDepth = 0;
    finalizationGates.clear();
    batchGates.clear();
    wave = createImplementationWaveState();
    coordinator.shutdown();
  });

  pi.on("session_before_compact", () => {
    setGate("compaction:native", true);
  });
  pi.on("session_compact", () => {
    setGate("compaction:native", false);
  });

  pi.on("agent_start", () => {
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
    const generation = runtimeGeneration;
    coordinator.setIdle(true);
    coordinator.agentSettled(ctx.sessionManager.getLeafId() ?? undefined);
    if (
      generation !== runtimeGeneration ||
      !wave.armed ||
      finalizationGates.size > 0 ||
      coordinator.hasOpenRequests()
    )
      return;

    const responses = assistantResponsesAfterAnchor(
      ctx.sessionManager.getBranch() as SessionEntry[],
      wave.anchorEntryId,
    );
    const transition = evaluateImplementationFinalization(wave, responses);
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
  });
}
