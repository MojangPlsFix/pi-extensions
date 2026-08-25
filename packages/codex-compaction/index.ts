import { createHash, randomUUID } from "node:crypto";
import type { Model, ProviderHeaders } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import {
  type CompactionGateEvent,
  type ContinuationEnqueueEvent,
  events,
} from "../../shared/events.js";
import { loadConfig } from "./config.js";
import {
  buildCodexHeaders,
  buildCompactionRequestBody,
  buildReplacementHistory,
  buildToolPayload,
  callRemoteCompaction,
  effectiveInputForBranch,
  findNativeCheckpoint,
  isJsonObject,
  isOpenAICodexModel,
  type JsonObject,
  mergeFeatureHeader,
  modelKey,
  NATIVE_COMPACTION_KIND,
  NATIVE_COMPACTION_VERSION,
  type NativeCompactionDetails,
  parseNativeCompactionDetails,
  type ResponseItem,
  resolveCodexResponsesUrl,
  stripInputFromPayload,
} from "./native-compaction.js";

type CachedPayloadShape = {
  modelKey: string;
  payload: JsonObject;
};

type CompactionStatus = {
  state: "running" | "complete" | "failed";
  error?: string;
};

type CompactionReason = "manual" | "threshold" | "overflow";

type SessionCompactFailedEvent = {
  reason: CompactionReason;
  errorMessage?: string;
  aborted: boolean;
  willRetry: boolean;
  fromExtension: boolean;
};

type NativeCompactionAttempt = {
  sessionId: string;
  generation: number;
  modelKey: string;
  reason: CompactionReason;
  willRetry: boolean;
  operationId: string;
  abortController: AbortController;
  context: ExtensionContext;
  runningStatusWritten: boolean;
  resultReturned: boolean;
  terminal: "pending" | "complete" | "failed";
};

type ForcedCompactionState = {
  sessionId: string;
  generation: number;
  branchAnchorEntryId: string | null;
  thresholdGateId: string;
  phase: "waitingForSettle" | "compacting";
  nativeAttempt?: NativeCompactionAttempt;
};

const COMPACTION_STATUS_KIND = "openai-codex-compaction-status";
const CONTINUATION_PROMPT = "Compaction completed. Continue.";
export const CODEX_COMPACTION_PRODUCER_ID = "codex-compaction:threshold";
export const CODEX_COMPACTION_CONTINUATION_TYPE = "codex-compaction:continuation";

/**
 * Pi 0.84.3 added this event after the 0.84.0 development peer used by this
 * repository. Keep the event shape local so older Pi declarations and runtime
 * packages continue to typecheck without importing private Pi internals.
 */
type SessionCompactFailedRegistration = (
  event: "session_compact_failed",
  handler: (event: SessionCompactFailedEvent, ctx: ExtensionContext) => void,
) => void;

function registerSessionCompactFailed(
  pi: ExtensionAPI,
  handler: (event: SessionCompactFailedEvent, ctx: ExtensionContext) => void,
): void {
  (pi.on as unknown as SessionCompactFailedRegistration)("session_compact_failed", handler);
}

export function thresholdContinuationRequestId(
  sessionId: string,
  anchorEntryId: string | null,
): string {
  const digest = createHash("sha256")
    .update(sessionId)
    .update("\0")
    .update(anchorEntryId ?? "root")
    .digest("hex")
    .slice(0, 24);
  return `${CODEX_COMPACTION_PRODUCER_ID}:${digest}`;
}

function localMarker(): string {
  return `OpenAI Codex native compaction checkpoint (${randomUUID()}).`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isCancellationMessage(message: string | undefined): boolean {
  if (!message) return false;
  return /(?:abort|cancel|state changed|newer codex compaction)/i.test(message);
}

function effectiveBaseUrl(model: Model<any>): string | undefined {
  return model.baseUrl;
}

function combineSignals(primary: AbortSignal, secondary: AbortSignal): AbortSignal {
  return AbortSignal.any([primary, secondary]);
}

function setFeatureHeader(headers: ProviderHeaders): void {
  const existing = Object.entries(headers).find(
    ([name]) => name.toLowerCase() === "x-codex-beta-features",
  );
  if (existing) {
    headers[existing[0]] = mergeFeatureHeader(existing[1]);
  } else {
    headers["x-codex-beta-features"] = mergeFeatureHeader(undefined);
  }
}

export default function codexCompactionExtension(pi: ExtensionAPI): void {
  const payloadShapeBySession = new Map<string, CachedPayloadShape>();
  // The abort controller only covers the request while session_before_compact is
  // running. The attempt survives that hook until Pi reports success or failure.
  let activeCompactionAbort: AbortController | undefined;
  let activeNativeCompactionAttempt: NativeCompactionAttempt | undefined;
  const nativeCompactionAttempts = new Set<NativeCompactionAttempt>();
  const activeCompactionGates = new Set<string>();
  let operationGeneration = 0;
  let nativeOperationSequence = 0;
  let forcedCompaction: ForcedCompactionState | undefined;

  const openCompactionGate = (operationId: string): void => {
    if (activeCompactionGates.has(operationId)) return;
    activeCompactionGates.add(operationId);
    pi.events.emit(events.compactionGate, {
      active: true,
      operationId,
    } satisfies CompactionGateEvent);
  };

  const closeCompactionGate = (operationId?: string, resume = false): void => {
    const closing = operationId
      ? activeCompactionGates.has(operationId)
        ? [operationId]
        : []
      : [...activeCompactionGates];
    for (const [index, closedOperationId] of closing.entries()) {
      activeCompactionGates.delete(closedOperationId);
      pi.events.emit(events.compactionGate, {
        active: false,
        operationId: closedOperationId,
        ...(resume && index === closing.length - 1 ? { resume: true } : {}),
      } satisfies CompactionGateEvent);
    }
  };

  pi.registerEntryRenderer<CompactionStatus>(COMPACTION_STATUS_KIND, (entry, _options, theme) => {
    const data = entry.data;
    if (data?.state === "running") {
      return new Text(theme.fg("accent", "◐ OpenAI compaction running…"), 0, 0);
    }
    if (data?.state === "complete") {
      return new Text(theme.fg("success", "✓ OpenAI compaction complete"), 0, 0);
    }
    const suffix = data?.error ? `: ${data.error}` : "";
    return new Text(theme.fg("error", `✗ OpenAI compaction failed${suffix}`), 0, 0);
  });

  const appendCompactionStatus = (ctx: ExtensionContext, status: CompactionStatus): void => {
    if (ctx.mode === "tui") pi.appendEntry(COMPACTION_STATUS_KIND, status);
  };

  const finalizeNativeCompactionAttempt = (
    attempt: NativeCompactionAttempt,
    outcome: {
      state: "complete" | "failed";
      error?: string;
      notify?: boolean;
      closeGate?: boolean;
    },
  ): boolean => {
    if (attempt.terminal !== "pending") return false;
    attempt.terminal = outcome.state;
    nativeCompactionAttempts.delete(attempt);
    if (activeNativeCompactionAttempt === attempt) activeNativeCompactionAttempt = undefined;
    if (activeCompactionAbort === attempt.abortController) activeCompactionAbort = undefined;

    if (attempt.runningStatusWritten) {
      appendCompactionStatus(
        attempt.context,
        outcome.state === "complete"
          ? { state: "complete" }
          : {
              state: "failed",
              ...(outcome.error ? { error: outcome.error } : {}),
            },
      );
    }

    if (outcome.closeGate !== false) closeCompactionGate(attempt.operationId);

    // A native attempt belongs to the threshold reservation only when the
    // exact retained attempt is attached to the exact current generation.
    if (
      outcome.state === "failed" &&
      forcedCompaction?.nativeAttempt === attempt &&
      forcedCompaction.sessionId === attempt.sessionId &&
      forcedCompaction.generation === attempt.generation
    ) {
      const thresholdGateId = forcedCompaction.thresholdGateId;
      forcedCompaction = undefined;
      closeCompactionGate(thresholdGateId);
    }

    if (outcome.notify && attempt.context.hasUI) {
      attempt.context.ui.notify(
        `OpenAI Codex native compaction failed: ${outcome.error ?? "unknown error"}`,
        "error",
      );
    }
    return true;
  };

  const discardPendingNativeAttempts = (): void => {
    for (const attempt of [...nativeCompactionAttempts]) {
      attempt.abortController.abort(new Error("Codex compaction state changed."));
      finalizeNativeCompactionAttempt(attempt, { state: "failed" });
    }
  };

  const createNativeCheckpoint = async (params: {
    ctx: ExtensionContext;
    model: Model<any>;
    input: ResponseItem[];
    basePayload?: JsonObject;
    signal?: AbortSignal;
  }): Promise<{
    details: NativeCompactionDetails;
    usage?: Awaited<ReturnType<typeof callRemoteCompaction>>["usage"];
  }> => {
    const auth = await params.ctx.modelRegistry.getApiKeyAndHeaders(params.model);
    if (!auth.ok || !auth.apiKey) {
      throw new Error(auth.ok ? "OpenAI Codex authentication is unavailable." : auth.error);
    }
    const sessionId = params.ctx.sessionManager.getSessionId();
    const allTools = pi.getAllTools();
    const body = buildCompactionRequestBody({
      basePayload: params.basePayload,
      model: params.model,
      input: params.input,
      instructions: params.ctx.getSystemPrompt(),
      tools: buildToolPayload(allTools, pi.getActiveTools(), params.model),
      sessionId,
    });
    const remote = await callRemoteCompaction({
      url: resolveCodexResponsesUrl(auth.baseUrl ?? effectiveBaseUrl(params.model)),
      headers: buildCodexHeaders({ apiKey: auth.apiKey, headers: auth.headers, sessionId }),
      body,
      model: params.model,
      signal: params.signal,
    });
    return {
      details: {
        kind: NATIVE_COMPACTION_KIND,
        version: NATIVE_COMPACTION_VERSION,
        modelKey: modelKey(params.model),
        replacementHistory: buildReplacementHistory(params.input, remote.compactionItem),
      },
      usage: remote.usage,
    };
  };

  const resetRuntimeState = (): void => {
    operationGeneration++;
    activeCompactionAbort?.abort(new Error("Codex compaction state changed."));
    discardPendingNativeAttempts();
    activeCompactionAbort = undefined;
    activeNativeCompactionAttempt = undefined;
    payloadShapeBySession.clear();
    const pendingThresholdGate = forcedCompaction?.thresholdGateId;
    forcedCompaction = undefined;
    if (pendingThresholdGate) closeCompactionGate(pendingThresholdGate);
    // Reset is an intentional lifecycle boundary; any gate left by a stale
    // callback is local to this extension and can be safely drained here.
    closeCompactionGate();
  };

  pi.on("session_start", resetRuntimeState);
  pi.on("session_shutdown", resetRuntimeState);
  pi.on("model_select", resetRuntimeState);

  pi.on("context", (event, ctx) => {
    if (!isOpenAICodexModel(ctx.model)) return undefined;
    const checkpoint = findNativeCheckpoint(ctx.sessionManager.getBranch() as SessionEntry[]);
    if (
      checkpoint.status !== "valid" ||
      checkpoint.checkpoint.details.modelKey !== modelKey(ctx.model)
    ) {
      return undefined;
    }
    return {
      messages: event.messages.filter((message) => message.role !== "compactionSummary"),
    };
  });

  pi.on("before_provider_headers", (event, ctx) => {
    if (!isOpenAICodexModel(ctx.model)) return;
    setFeatureHeader(event.headers);
  });

  pi.on("before_provider_request", async (event, ctx) => {
    const model = ctx.model;
    if (!isOpenAICodexModel(model) || !isJsonObject(event.payload)) return undefined;

    const sessionId = ctx.sessionManager.getSessionId();
    const basePayload = stripInputFromPayload(event.payload);
    payloadShapeBySession.set(sessionId, { modelKey: modelKey(model), payload: basePayload });

    const branch = ctx.sessionManager.getBranch() as SessionEntry[];
    const checkpoint = findNativeCheckpoint(branch);

    try {
      if (checkpoint.status === "none") return undefined;
      const input = effectiveInputForBranch({ branch, model, tools: pi.getAllTools() });
      const payload: JsonObject = { ...event.payload, input };
      delete payload.messages;
      delete payload.previous_response_id;
      return payload;
    } catch (error) {
      ctx.abort();
      if (ctx.hasUI) {
        ctx.ui.notify(`OpenAI Codex request blocked: ${errorMessage(error)}`, "error");
      }
      const payload: JsonObject = { ...event.payload, input: [] };
      delete payload.messages;
      delete payload.previous_response_id;
      return payload;
    }
  });

  pi.on("session_before_compact", async (event, ctx) => {
    const model = ctx.model;
    if (!isOpenAICodexModel(model)) return undefined;

    const sessionId = ctx.sessionManager.getSessionId();
    const expectedModelKey = modelKey(model);
    const generation = operationGeneration;

    // Pi normally serializes compaction. Retire a previous retained attempt as
    // stale anyway so a late callback cannot act on the next native operation.
    activeCompactionAbort?.abort(new Error("A newer Codex compaction started."));
    if (activeNativeCompactionAttempt?.terminal === "pending") {
      const previousAttempt = activeNativeCompactionAttempt;
      // The newer attempt inherits a still-live threshold reservation. Detach
      // the old identity before finalizing it so its stale failure cannot spend
      // the reservation that belongs to the new operation.
      if (
        forcedCompaction?.nativeAttempt === previousAttempt &&
        forcedCompaction.sessionId === sessionId &&
        forcedCompaction.generation === generation
      ) {
        forcedCompaction.nativeAttempt = undefined;
      }
      finalizeNativeCompactionAttempt(previousAttempt, { state: "failed" });
    }

    const operationAbort = new AbortController();
    const operationId = `codex-native:${sessionId}:${generation}:${++nativeOperationSequence}`;
    const attempt: NativeCompactionAttempt = {
      sessionId,
      generation,
      modelKey: expectedModelKey,
      reason: event.reason,
      willRetry: event.willRetry,
      operationId,
      abortController: operationAbort,
      context: ctx,
      runningStatusWritten: ctx.mode === "tui",
      resultReturned: false,
      terminal: "pending",
    };
    nativeCompactionAttempts.add(attempt);
    activeNativeCompactionAttempt = attempt;
    activeCompactionAbort = operationAbort;
    openCompactionGate(operationId);
    // This boundary deliberately precedes effectiveInputForBranch(): malformed
    // or otherwise unpreparable history still gets one running/terminal pair.
    appendCompactionStatus(ctx, { state: "running" });

    if (
      forcedCompaction &&
      forcedCompaction.sessionId === sessionId &&
      forcedCompaction.generation === generation
    ) {
      forcedCompaction.nativeAttempt = attempt;
    }

    const isCurrentAttempt = (): boolean =>
      activeNativeCompactionAttempt === attempt &&
      attempt.terminal === "pending" &&
      generation === operationGeneration &&
      ctx.sessionManager.getSessionId() === sessionId &&
      isOpenAICodexModel(ctx.model) &&
      modelKey(ctx.model) === expectedModelKey;

    try {
      const branch = event.branchEntries as SessionEntry[];
      const input = effectiveInputForBranch({
        branch,
        model,
        tools: pi.getAllTools(),
        excludeLastAssistantError: event.reason === "overflow" && event.willRetry,
      });
      const cached = payloadShapeBySession.get(sessionId);
      const native = await createNativeCheckpoint({
        ctx,
        model,
        input,
        basePayload: cached?.modelKey === expectedModelKey ? cached.payload : undefined,
        signal: combineSignals(event.signal, operationAbort.signal),
      });
      if (!isCurrentAttempt()) {
        throw new Error("Codex compaction state changed before completion.");
      }
      // Keep the attempt after this hook returns. Pi 0.84.3 can now report a
      // later failure for a custom result, while older Pi versions only report
      // the existing success event/callback.
      attempt.resultReturned = true;

      return {
        compaction: {
          summary: localMarker(),
          firstKeptEntryId: event.preparation.firstKeptEntryId,
          tokensBefore: event.preparation.tokensBefore,
          usage: native.usage,
          details: native.details,
        },
      };
    } catch (error) {
      const stale = !isCurrentAttempt();
      const aborted =
        stale ||
        event.signal.aborted ||
        operationAbort.signal.aborted ||
        isCancellationMessage(errorMessage(error));
      const failureMessage = aborted ? undefined : errorMessage(error);
      finalizeNativeCompactionAttempt(attempt, {
        state: "failed",
        ...(failureMessage ? { error: failureMessage } : {}),
        notify: !aborted,
      });
      return { cancel: true };
    } finally {
      // The controller no longer owns the lifecycle after the hook returns;
      // the retained attempt is closed by session_compact/_failed or onComplete.
      if (activeCompactionAbort === operationAbort) activeCompactionAbort = undefined;
    }
  });

  const currentForcedCompaction = (ctx: ExtensionContext): ForcedCompactionState | undefined => {
    const state = forcedCompaction;
    if (
      !state ||
      state.sessionId !== ctx.sessionManager.getSessionId() ||
      state.generation !== operationGeneration
    ) {
      return undefined;
    }
    return state;
  };

  const pendingNativeAttemptFor = (
    ctx: ExtensionContext,
    reason: CompactionReason,
    requireReturnedResult: boolean,
  ): NativeCompactionAttempt | undefined => {
    const attempt = activeNativeCompactionAttempt;
    if (
      attempt?.terminal !== "pending" ||
      attempt.sessionId !== ctx.sessionManager.getSessionId() ||
      attempt.generation !== operationGeneration ||
      attempt.modelKey !== (isOpenAICodexModel(ctx.model) ? modelKey(ctx.model) : "") ||
      attempt.reason !== reason ||
      (requireReturnedResult && !attempt.resultReturned)
    ) {
      return undefined;
    }
    return attempt;
  };

  const enqueueAfterCompaction = (
    ctx: ExtensionContext,
    expected: ForcedCompactionState,
    compactionAnchorEntryId?: string,
  ): void => {
    if (
      forcedCompaction !== expected ||
      expected.sessionId !== ctx.sessionManager.getSessionId() ||
      expected.generation !== operationGeneration
    ) {
      return;
    }
    const branch = ctx.sessionManager.getBranch() as SessionEntry[];
    const branchIds = new Set(branch.map((entry) => entry.id));
    const anchorEntryId =
      (compactionAnchorEntryId && branchIds.has(compactionAnchorEntryId)
        ? compactionAnchorEntryId
        : branch.at(-1)?.id) ?? expected.branchAnchorEntryId;
    const requestId = thresholdContinuationRequestId(expected.sessionId, anchorEntryId);

    // Consume the in-memory reservation before emitting. The coordinator responds
    // synchronously and reconciles this stable ID against its durable state.
    forcedCompaction = undefined;
    pi.events.emit(events.continuationEnqueue, {
      producerId: CODEX_COMPACTION_PRODUCER_ID,
      requestId,
      dedupeKey: requestId,
      sessionId: expected.sessionId,
      originEntryId: anchorEntryId,
      message: {
        customType: CODEX_COMPACTION_CONTINUATION_TYPE,
        content: CONTINUATION_PROMPT,
        display: true,
        details: {
          reason: "threshold",
          compactionAnchorEntryId: anchorEntryId,
        },
      },
    } satisfies ContinuationEnqueueEvent);
  };

  pi.on("turn_end", (event, ctx) => {
    if (forcedCompaction || !isOpenAICodexModel(ctx.model)) return;
    if (
      event.message.role === "assistant" &&
      (event.message.stopReason === "aborted" ||
        event.message.stopReason === "error" ||
        event.message.stopReason === "length")
    )
      return;
    const config = loadConfig(ctx.cwd, ctx.isProjectTrusted());
    if (!config.autoCompact) return;

    const usage = ctx.getContextUsage();
    if (usage?.percent === null || usage?.percent === undefined) return;
    if (usage.percent < config.thresholdRatio * 100) return;

    const sessionId = ctx.sessionManager.getSessionId();
    const branch = ctx.sessionManager.getBranch() as SessionEntry[];
    const thresholdGateId = `codex-threshold:${thresholdContinuationRequestId(sessionId, branch.at(-1)?.id ?? null)}`;
    forcedCompaction = {
      sessionId,
      generation: operationGeneration,
      branchAnchorEntryId: branch.at(-1)?.id ?? null,
      thresholdGateId,
      phase: "waitingForSettle",
    };
    openCompactionGate(thresholdGateId);
    if (ctx.hasUI) {
      ctx.ui.notify(
        `OpenAI Codex context reached ${usage.percent.toFixed(1)}%; stopping for compaction.`,
        "warning",
      );
    }
    ctx.abort();
  });

  const releaseForcedCompaction = (state: ForcedCompactionState, resume = false): boolean => {
    if (forcedCompaction !== state || state.generation !== operationGeneration) return false;
    forcedCompaction = undefined;
    closeCompactionGate(state.thresholdGateId, resume);
    return true;
  };

  pi.on("session_compact", (event, ctx) => {
    const details = parseNativeCompactionDetails(event.compactionEntry.details);
    const isMatchingNativeCompaction =
      event.fromExtension &&
      isOpenAICodexModel(ctx.model) &&
      details?.modelKey === modelKey(ctx.model);
    const attempt = isMatchingNativeCompaction
      ? pendingNativeAttemptFor(ctx, event.reason, true)
      : undefined;
    const state = currentForcedCompaction(ctx);

    // Keep the status and native gate tied to the attempt that returned this
    // result. A late success from an older generation must be ignored.
    const deferNativeGate = Boolean(
      attempt &&
        state?.phase === "compacting" &&
        state.nativeAttempt === attempt &&
        !event.willRetry,
    );
    if (attempt) {
      finalizeNativeCompactionAttempt(attempt, {
        state: "complete",
        closeGate: !deferNativeGate,
      });
    }

    if (!state) return;
    if (event.reason === "manual" && state.phase === "waitingForSettle") {
      releaseForcedCompaction(state, true);
      return;
    }
    if (event.reason === "manual" && !isMatchingNativeCompaction) {
      releaseForcedCompaction(state, true);
      return;
    }
    // ctx.compact() can report a non-Codex completion before its onComplete callback.
    // Keep the threshold reservation until the callback or a matching native
    // completion has consumed it.
    if (!isMatchingNativeCompaction) return;
    if (event.willRetry) {
      releaseForcedCompaction(state);
      return;
    }
    enqueueAfterCompaction(ctx, state, event.compactionEntry.id);
    if (attempt && deferNativeGate) closeCompactionGate(attempt.operationId);
    closeCompactionGate(state.thresholdGateId, true);
  });

  registerSessionCompactFailed(pi, (event, ctx) => {
    const attempt =
      event.fromExtension && isOpenAICodexModel(ctx.model)
        ? pendingNativeAttemptFor(ctx, event.reason, true)
        : undefined;
    if (attempt) {
      const aborted = event.aborted || isCancellationMessage(event.errorMessage);
      finalizeNativeCompactionAttempt(attempt, {
        state: "failed",
        ...(aborted || !event.errorMessage ? {} : { error: event.errorMessage }),
        notify: !aborted,
      });
      return;
    }

    // Pi emits overflow failures for compactions this extension did not start.
    // They must not consume a threshold reservation or close another operation.
    if (event.reason === "overflow") return;
    const state = currentForcedCompaction(ctx);
    if (!state || state.nativeAttempt?.terminal === "pending") return;
    if (!releaseForcedCompaction(state)) return;

    const aborted = event.aborted || isCancellationMessage(event.errorMessage);
    if (!aborted && ctx.hasUI) {
      ctx.ui.notify(
        `OpenAI Codex native compaction failed: ${event.errorMessage ?? "unknown error"}`,
        "error",
      );
    }
  });

  pi.on("agent_settled", (_event, ctx) => {
    const state = currentForcedCompaction(ctx);
    if (!state || !isOpenAICodexModel(ctx.model)) return;
    if (state.phase !== "waitingForSettle") return;

    const compacting: ForcedCompactionState = {
      ...state,
      phase: "compacting",
      nativeAttempt: undefined,
    };
    forcedCompaction = compacting;
    ctx.compact({
      onComplete: () => {
        if (forcedCompaction !== compacting) return;
        const attempt = compacting.nativeAttempt;
        if (attempt?.terminal === "pending") {
          finalizeNativeCompactionAttempt(attempt, { state: "complete", closeGate: false });
        }
        if (forcedCompaction !== compacting) return;
        enqueueAfterCompaction(ctx, compacting);
        if (attempt) closeCompactionGate(attempt.operationId);
        closeCompactionGate(compacting.thresholdGateId, true);
      },
      onError: (error) => {
        if (forcedCompaction !== compacting) return;
        const attempt = compacting.nativeAttempt;
        const aborted = isCancellationMessage(error.message);
        if (attempt?.terminal === "pending") {
          finalizeNativeCompactionAttempt(attempt, {
            state: "failed",
            ...(!aborted ? { error: error.message } : {}),
            notify: !aborted,
          });
          return;
        }
        if (attempt?.terminal === "complete") return;
        forcedCompaction = undefined;
        closeCompactionGate(compacting.thresholdGateId);
        appendCompactionStatus(
          ctx,
          aborted ? { state: "failed" } : { state: "failed", error: error.message },
        );
        if (!aborted && ctx.hasUI) {
          ctx.ui.notify(`OpenAI Codex compaction failed: ${error.message}`, "error");
        }
      },
    });
  });
}
