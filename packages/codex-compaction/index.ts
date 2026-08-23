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

type ForcedCompactionState = {
  sessionId: string;
  branchAnchorEntryId: string | null;
  phase: "waitingForSettle" | "compacting";
};

const COMPACTION_STATUS_KIND = "openai-codex-compaction-status";
const CONTINUATION_PROMPT = "Compaction completed. Continue.";
export const CODEX_COMPACTION_PRODUCER_ID = "codex-compaction:threshold";
export const CODEX_COMPACTION_CONTINUATION_TYPE = "codex-compaction:continuation";

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
  let activeCompactionAbort: AbortController | undefined;
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

  const withCompactionStatus = async <T>(
    ctx: ExtensionContext,
    operation: () => Promise<T>,
  ): Promise<T> => {
    appendCompactionStatus(ctx, { state: "running" });
    try {
      return await operation();
    } catch (error) {
      appendCompactionStatus(ctx, { state: "failed", error: errorMessage(error) });
      throw error;
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
    activeCompactionAbort = undefined;
    payloadShapeBySession.clear();
    forcedCompaction = undefined;
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
    activeCompactionAbort?.abort(new Error("A newer Codex compaction started."));
    const operationAbort = new AbortController();
    const operationId = `codex-native:${sessionId}:${generation}:${++nativeOperationSequence}`;
    activeCompactionAbort = operationAbort;
    openCompactionGate(operationId);

    try {
      const branch = event.branchEntries as SessionEntry[];
      const input = effectiveInputForBranch({
        branch,
        model,
        tools: pi.getAllTools(),
        excludeLastAssistantError: event.reason === "overflow" && event.willRetry,
      });
      const cached = payloadShapeBySession.get(sessionId);
      const native = await withCompactionStatus(ctx, async () => {
        const result = await createNativeCheckpoint({
          ctx,
          model,
          input,
          basePayload: cached?.modelKey === expectedModelKey ? cached.payload : undefined,
          signal: combineSignals(event.signal, operationAbort.signal),
        });
        if (
          generation !== operationGeneration ||
          activeCompactionAbort !== operationAbort ||
          ctx.sessionManager.getSessionId() !== sessionId ||
          !isOpenAICodexModel(ctx.model) ||
          modelKey(ctx.model) !== expectedModelKey
        ) {
          throw new Error("Codex compaction state changed before completion.");
        }
        return result;
      });

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
      if (forcedCompaction?.sessionId === ctx.sessionManager.getSessionId()) {
        forcedCompaction = undefined;
      }
      // A threshold-triggered native failure must also release the outer threshold gate.
      closeCompactionGate();
      if (!event.signal.aborted && ctx.hasUI) {
        ctx.ui.notify(`OpenAI Codex native compaction failed: ${errorMessage(error)}`, "error");
      }
      return { cancel: true };
    } finally {
      if (activeCompactionAbort === operationAbort) activeCompactionAbort = undefined;
    }
  });

  const enqueueAfterCompaction = (
    ctx: ExtensionContext,
    expected: ForcedCompactionState,
    compactionAnchorEntryId?: string,
  ): void => {
    if (forcedCompaction !== expected || expected.sessionId !== ctx.sessionManager.getSessionId()) {
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
    forcedCompaction = {
      sessionId,
      branchAnchorEntryId: branch.at(-1)?.id ?? null,
      phase: "waitingForSettle",
    };
    openCompactionGate(
      `codex-threshold:${thresholdContinuationRequestId(sessionId, branch.at(-1)?.id ?? null)}`,
    );
    if (ctx.hasUI) {
      ctx.ui.notify(
        `OpenAI Codex context reached ${usage.percent.toFixed(1)}%; stopping for compaction.`,
        "warning",
      );
    }
    ctx.abort();
  });

  pi.on("session_compact", (event, ctx) => {
    const details = parseNativeCompactionDetails(event.compactionEntry.details);
    const isMatchingNativeCompaction =
      event.fromExtension &&
      isOpenAICodexModel(ctx.model) &&
      details?.modelKey === modelKey(ctx.model);
    if (isMatchingNativeCompaction) appendCompactionStatus(ctx, { state: "complete" });

    const state = forcedCompaction;
    if (!state || state.sessionId !== ctx.sessionManager.getSessionId()) {
      closeCompactionGate(undefined, true);
      return;
    }
    if (event.reason === "manual" && state.phase === "waitingForSettle") {
      forcedCompaction = undefined;
      closeCompactionGate(undefined, true);
      return;
    }
    if (event.reason === "manual" && !isMatchingNativeCompaction) {
      forcedCompaction = undefined;
      closeCompactionGate(undefined, true);
      return;
    }
    // ctx.compact() can report a non-Codex completion before its onComplete callback.
    // Keep both gates closed until that callback enqueues the reserved continuation.
    if (!isMatchingNativeCompaction) return;
    if (event.willRetry) {
      forcedCompaction = undefined;
      closeCompactionGate(undefined, true);
      return;
    }
    enqueueAfterCompaction(ctx, state, event.compactionEntry.id);
    closeCompactionGate(undefined, true);
  });

  pi.on("agent_settled", (_event, ctx) => {
    const state = forcedCompaction;
    if (
      !state ||
      state.sessionId !== ctx.sessionManager.getSessionId() ||
      !isOpenAICodexModel(ctx.model)
    ) {
      return;
    }
    if (state.phase !== "waitingForSettle") return;

    const compacting: ForcedCompactionState = { ...state, phase: "compacting" };
    forcedCompaction = compacting;
    ctx.compact({
      onComplete: () => {
        enqueueAfterCompaction(ctx, compacting);
        closeCompactionGate(undefined, true);
      },
      onError: (error) => {
        if (forcedCompaction !== compacting) return;
        forcedCompaction = undefined;
        closeCompactionGate();
        appendCompactionStatus(ctx, { state: "failed", error: error.message });
        if (ctx.hasUI) {
          ctx.ui.notify(`OpenAI Codex compaction failed: ${error.message}`, "error");
        }
      },
    });
  });
}
