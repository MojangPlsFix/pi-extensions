import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, test } from "vitest";
import { loadConfig, resolveConfigPaths } from "../config.js";
import codexCompactionExtension from "../index.js";
import {
  buildCodexHeaders,
  buildCompactionRequestBody,
  buildReplacementHistory,
  callRemoteCompaction,
  effectiveInputForBranch,
  findNativeCheckpoint,
  isOpenAICodexModel,
  type JsonObject,
  mergeFeatureHeader,
  NATIVE_COMPACTION_KIND,
  NATIVE_COMPACTION_VERSION,
  parseNativeCompactionDetails,
  resolveCodexResponsesUrl,
  retainRecentUserMessages,
} from "../native-compaction.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function token(): string {
  const payload = Buffer.from(
    JSON.stringify({
      "https://api.openai.com/auth": { chatgpt_account_id: "account-123" },
    }),
  ).toString("base64url");
  return `header.${payload}.signature`;
}

const model = {
  id: "gpt-test",
  name: "GPT Test",
  api: "openai-codex-responses",
  provider: "openai-codex",
  baseUrl: "https://chatgpt.com/backend-api",
  reasoning: true,
  input: ["text"],
  contextWindow: 200_000,
  maxTokens: 16_384,
  cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0, total: 0 },
} as any;

function userEntry(id: string, text: string): SessionEntry {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp: new Date().toISOString(),
    message: { role: "user", content: [{ type: "text", text }], timestamp: Date.now() },
  } as SessionEntry;
}

function extensionHarness(initialBranch: SessionEntry[]) {
  const handlers = new Map<string, (...args: any[]) => any>();
  const entryRenderers = new Map<string, (...args: any[]) => any>();
  let branch = initialBranch;
  let aborted = false;
  let hasPendingMessages = false;
  let idle = false;
  let usageTokens = 40_000;
  let customEntryId = 0;
  const notifications: string[] = [];
  const compactionRequests: any[] = [];
  const sentUserMessages: Array<{ content: string; options: any }> = [];
  const pi = {
    on(name: string, handler: (...args: any[]) => any) {
      handlers.set(
        name,
        name === "turn_end"
          ? (event: any, ctx: any) =>
              handler(
                {
                  message: { role: "assistant", stopReason: "stop" },
                  ...event,
                },
                ctx,
              )
          : handler,
      );
    },
    getAllTools: () => [],
    getActiveTools: () => [],
    registerEntryRenderer(customType: string, renderer: (...args: any[]) => any) {
      entryRenderers.set(customType, renderer);
    },
    appendEntry(customType: string, data: unknown) {
      branch = [
        ...branch,
        {
          type: "custom",
          id: `custom-${++customEntryId}`,
          parentId: branch.at(-1)?.id ?? null,
          timestamp: new Date().toISOString(),
          customType,
          data,
        } as SessionEntry,
      ];
    },
    sendUserMessage(content: string, options?: any) {
      sentUserMessages.push({ content, options });
    },
  } as any;
  codexCompactionExtension(pi);

  const context = {
    model,
    mode: "tui",
    cwd: "/var/tmp/pi-codex-compaction-test",
    signal: new AbortController().signal,
    hasUI: true,
    ui: { notify: (message: string) => notifications.push(message) },
    abort: () => {
      aborted = true;
    },
    compact: (options: any) => {
      compactionRequests.push(options);
    },
    isIdle: () => idle,
    isProjectTrusted: () => false,
    hasPendingMessages: () => hasPendingMessages,
    getContextUsage: () => ({
      tokens: usageTokens,
      contextWindow: model.contextWindow,
      percent: (usageTokens / model.contextWindow) * 100,
    }),
    getSystemPrompt: () => "You are Codex.",
    sessionManager: {
      getSessionId: () => "session-123",
      getBranch: () => branch,
    },
    modelRegistry: {
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: token(), headers: {} }),
      getProviderAuth: async () => ({ auth: { apiKey: token(), baseUrl: model.baseUrl } }),
      getProvider: () => ({ baseUrl: model.baseUrl }),
    },
  };

  return {
    handlers,
    context,
    setBranch(next: SessionEntry[]) {
      branch = next;
    },
    setHasPendingMessages(pending: boolean) {
      hasPendingMessages = pending;
    },
    setIdle(value: boolean) {
      idle = value;
    },
    setUsageTokens(tokens: number) {
      usageTokens = tokens;
    },
    getBranch() {
      return branch;
    },
    get aborted() {
      return aborted;
    },
    entryRenderers,
    notifications,
    compactionRequests,
    sentUserMessages,
  };
}

function nativeDetails(encryptedContent = "opaque-state"): Record<string, unknown> {
  return {
    kind: NATIVE_COMPACTION_KIND,
    version: NATIVE_COMPACTION_VERSION,
    modelKey: "openai-codex:openai-codex-responses:gpt-test",
    replacementHistory: [{ type: "compaction", encrypted_content: encryptedContent }],
  };
}

function sseResponse(events: unknown[]): Response {
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function compactionSse(encryptedContent = "opaque-state"): Response {
  return sseResponse([
    {
      type: "response.output_item.done",
      item: { type: "compaction", id: "cmp_1", encrypted_content: encryptedContent },
    },
    {
      type: "response.completed",
      response: {
        usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 },
      },
    },
  ]);
}

describe("pi-codex-compaction", () => {
  test("runs native compaction and never replays the local marker", async () => {
    let requestBody: JsonObject | undefined;
    let requestHeaders: Headers | undefined;
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body));
      requestHeaders = new Headers(init?.headers);
      return compactionSse();
    }) as typeof fetch;

    const firstUser = userEntry("user-1", "Remember BLUE-42.");
    const harness = extensionHarness([firstUser]);
    const compact = harness.handlers.get("session_before_compact")!;
    const result = await compact(
      {
        branchEntries: [firstUser],
        preparation: { firstKeptEntryId: "user-1", tokensBefore: 50_000 },
        reason: "manual",
        willRetry: false,
        signal: new AbortController().signal,
      },
      harness.context,
    );

    expect(result.cancel).toBeUndefined();
    expect(result.compaction.summary).toContain("OpenAI Codex native compaction checkpoint");
    expect(result.compaction.details.kind).toBe(NATIVE_COMPACTION_KIND);
    expect(result.compaction.details.replacementHistory.at(-1)).toEqual({
      type: "compaction",
      id: "cmp_1",
      encrypted_content: "opaque-state",
    });
    expect((requestBody!.input as JsonObject[]).at(-1)).toEqual({ type: "compaction_trigger" });
    expect(JSON.stringify(requestBody)).not.toContain("checkpoint");
    expect(requestHeaders!.get("x-codex-beta-features")).toContain("remote_compaction_v2");
    expect(
      harness
        .getBranch()
        .slice(1)
        .map((entry: any) => entry.data?.state),
    ).toEqual(["running"]);

    const compactionEntry = {
      type: "compaction",
      id: "compact-1",
      parentId: "user-1",
      timestamp: new Date().toISOString(),
      summary: result.compaction.summary,
      firstKeptEntryId: "user-1",
      tokensBefore: 50_000,
      details: result.compaction.details,
    } as SessionEntry;
    const nextUser = {
      ...userEntry("user-2", "What was the code?"),
      parentId: "compact-1",
    } as SessionEntry;
    harness.setBranch([firstUser, compactionEntry, nextUser]);

    const beforeRequest = harness.handlers.get("before_provider_request")!;
    const markerPayload = {
      model: model.id,
      input: [{ role: "user", content: [{ type: "input_text", text: result.compaction.summary }] }],
    };
    const patched = await beforeRequest({ payload: markerPayload }, harness.context);
    const serialized = JSON.stringify(patched);
    expect(serialized).not.toContain(result.compaction.summary);
    expect(patched.input[0]).toEqual({
      role: "user",
      content: [{ type: "input_text", text: "Remember BLUE-42." }],
    });
    expect(patched.input[1]).toEqual({
      type: "compaction",
      id: "cmp_1",
      encrypted_content: "opaque-state",
    });
    expect(patched.input[2]).toMatchObject({ role: "user" });

    const filteredContext = harness.handlers.get("context")!(
      {
        messages: [
          { role: "compactionSummary", summary: result.compaction.summary },
          { role: "user", content: [{ type: "text", text: "What was the code?" }] },
        ],
      },
      harness.context,
    );
    expect(filteredContext.messages).toHaveLength(1);
    expect(filteredContext.messages[0].role).toBe("user");
  });

  test("cancels Pi compaction instead of falling back to text summarization", async () => {
    globalThis.fetch = (async () => new Response("bad request", { status: 400 })) as typeof fetch;
    const entry = userEntry("user-1", "hello");
    const harness = extensionHarness([entry]);
    const result = await harness.handlers.get("session_before_compact")!(
      {
        branchEntries: [entry],
        preparation: { firstKeptEntryId: "user-1", tokensBefore: 50_000 },
        reason: "threshold",
        willRetry: false,
        signal: new AbortController().signal,
      },
      harness.context,
    );

    expect(result).toEqual({ cancel: true });
    expect(harness.notifications[0]).toContain("native compaction failed");
    expect(
      harness
        .getBranch()
        .slice(1)
        .map((entry: any) => entry.data?.state),
    ).toEqual(["running", "failed"]);
  });

  test("retries a message-less compaction stream error", async () => {
    let attempts = 0;
    globalThis.fetch = (async () => {
      attempts++;
      if (attempts === 1) {
        return new Response(`data: ${JSON.stringify({ type: "error" })}\n\n`, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }
      return compactionSse("retried-opaque");
    }) as typeof fetch;
    const entry = userEntry("user-1", "continue after a transient compaction failure");
    const harness = extensionHarness([entry]);
    const result = await harness.handlers.get("session_before_compact")!(
      {
        branchEntries: [entry],
        preparation: { firstKeptEntryId: "user-1", tokensBefore: 50_000 },
        reason: "threshold",
        willRetry: false,
        signal: new AbortController().signal,
      },
      harness.context,
    );

    expect(attempts).toBe(2);
    expect(result.compaction.details.replacementHistory.at(-1)).toEqual({
      type: "compaction",
      id: "cmp_1",
      encrypted_content: "retried-opaque",
    });
    expect(
      harness
        .getBranch()
        .filter((entry: any) => entry.customType === "openai-codex-compaction-status")
        .map((entry: any) => entry.data.state),
    ).toEqual(["running"]);
  });

  test("does not retry an explicit compaction stream error", async () => {
    let attempts = 0;
    globalThis.fetch = (async () => {
      attempts++;
      return new Response(
        `data: ${JSON.stringify({ type: "error", message: "explicit failure" })}\n\n`,
        {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        },
      );
    }) as typeof fetch;
    const entry = userEntry("user-1", "do not retry a permanent compaction failure");
    const harness = extensionHarness([entry]);
    const result = await harness.handlers.get("session_before_compact")!(
      {
        branchEntries: [entry],
        preparation: { firstKeptEntryId: "user-1", tokensBefore: 50_000 },
        reason: "threshold",
        willRetry: false,
        signal: new AbortController().signal,
      },
      harness.context,
    );

    expect(attempts).toBe(1);
    expect(result).toEqual({ cancel: true });
    expect(harness.notifications).toContain(
      "OpenAI Codex native compaction failed: explicit failure",
    );
  });

  test("shows the running marker while Pi compaction is in progress", async () => {
    let resolveFetch: ((response: Response) => void) | undefined;
    globalThis.fetch = (() =>
      new Promise<Response>((resolve) => {
        resolveFetch = resolve;
      })) as typeof fetch;
    const entry = userEntry("user-1", "continue the task");
    const harness = extensionHarness([entry]);
    const pending = harness.handlers.get("session_before_compact")!(
      {
        branchEntries: [entry],
        preparation: { firstKeptEntryId: "user-1", tokensBefore: 50_000 },
        reason: "threshold",
        willRetry: false,
        signal: new AbortController().signal,
      },
      harness.context,
    );

    expect((harness.getBranch().at(-1) as any).data.state).toBe("running");
    await Promise.resolve();
    expect(resolveFetch).toBeDefined();
    resolveFetch!(compactionSse());
    const result = await pending;
    expect((harness.getBranch().at(-1) as any).data.state).toBe("running");
    harness.handlers.get("session_compact")!(
      {
        reason: "threshold",
        willRetry: false,
        fromExtension: true,
        compactionEntry: { details: result.compaction.details },
      },
      harness.context,
    );
    expect((harness.getBranch().at(-1) as any).data.state).toBe("complete");
    const renderer = harness.entryRenderers.get("openai-codex-compaction-status")!;
    const rendered = renderer(
      { data: { state: "complete" } },
      {},
      { fg: (_color: string, text: string) => text },
    )
      .render(80)
      .join("\n");
    expect(rendered).toContain("OpenAI compaction complete");
  });

  test("does not compact inside the provider request hook", async () => {
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return compactionSse();
    }) as typeof fetch;
    const entry = userEntry("user-1", "continue the tool-driven task");
    const harness = extensionHarness([entry]);
    const result = await harness.handlers.get("before_provider_request")!(
      {
        payload: {
          model: model.id,
          input: [
            {
              role: "user",
              content: [{ type: "input_text", text: "continue the tool-driven task" }],
            },
          ],
        },
      },
      harness.context,
    );

    expect(result).toBeUndefined();
    expect(called).toBe(false);
    expect(harness.getBranch()).toEqual([entry]);
  });

  test("aborts at 90 percent, compacts after settlement, and visibly continues", () => {
    const entry = userEntry("user-1", "continue the task");
    const harness = extensionHarness([entry]);
    harness.setUsageTokens(180_000);

    harness.handlers.get("turn_end")!({}, harness.context);
    expect(harness.aborted).toBe(true);
    expect(harness.compactionRequests).toHaveLength(0);

    harness.setIdle(true);
    harness.handlers.get("agent_settled")!({}, harness.context);
    expect(harness.compactionRequests).toHaveLength(1);
    harness.compactionRequests[0].onComplete({});

    expect(harness.sentUserMessages).toEqual([
      {
        content: "Compaction completed. Continue.",
        options: undefined,
      },
    ]);
  });

  test("continues when ctx.compact emits a matching manual event before onComplete", () => {
    const entry = userEntry("user-1", "continue the task");
    const harness = extensionHarness([entry]);
    harness.setUsageTokens(180_000);
    harness.handlers.get("turn_end")!({}, harness.context);
    harness.setIdle(true);
    harness.handlers.get("agent_settled")!({}, harness.context);
    expect(harness.compactionRequests).toHaveLength(1);

    harness.handlers.get("session_compact")!(
      {
        reason: "manual",
        willRetry: false,
        fromExtension: true,
        compactionEntry: { details: nativeDetails() },
      },
      harness.context,
    );
    harness.compactionRequests[0].onComplete({});
    expect(harness.sentUserMessages).toEqual([
      {
        content: "Compaction completed. Continue.",
        options: undefined,
      },
    ]);
  });

  test("continues exactly once after duplicate compaction completion signals", () => {
    const entry = userEntry("user-duplicate", "continue the task");
    const harness = extensionHarness([entry]);
    harness.setUsageTokens(180_000);
    harness.handlers.get("turn_end")!({}, harness.context);
    harness.setIdle(true);
    harness.handlers.get("agent_settled")!({}, harness.context);

    const completionEvent = {
      reason: "manual",
      willRetry: false,
      fromExtension: true,
      compactionEntry: { details: nativeDetails() },
    };
    harness.handlers.get("session_compact")!(completionEvent, harness.context);
    harness.handlers.get("session_compact")!(completionEvent, harness.context);
    harness.compactionRequests[0].onComplete({});
    harness.compactionRequests[0].onComplete({});
    harness.handlers.get("session_compact")!(completionEvent, harness.context);

    expect(harness.sentUserMessages).toEqual([
      {
        content: "Compaction completed. Continue.",
        options: undefined,
      },
    ]);
  });

  test("uses Pi threshold compaction when it finishes before settlement", () => {
    const entry = userEntry("user-1", "continue the task");
    const harness = extensionHarness([entry]);
    harness.setUsageTokens(180_000);
    harness.handlers.get("turn_end")!({}, harness.context);

    harness.handlers.get("session_compact")!(
      {
        reason: "threshold",
        willRetry: false,
        fromExtension: true,
        compactionEntry: { details: nativeDetails() },
      },
      harness.context,
    );
    harness.setIdle(true);
    harness.handlers.get("agent_settled")!({}, harness.context);

    expect(harness.compactionRequests).toHaveLength(0);
    expect(harness.sentUserMessages).toEqual([
      {
        content: "Compaction completed. Continue.",
        options: undefined,
      },
    ]);
  });

  test("does not add a continuation when overflow recovery will retry", () => {
    const entry = userEntry("user-1", "continue the task");
    const harness = extensionHarness([entry]);
    harness.setUsageTokens(180_000);
    harness.handlers.get("turn_end")!({}, harness.context);

    harness.handlers.get("session_compact")!(
      {
        reason: "overflow",
        willRetry: true,
        fromExtension: true,
        compactionEntry: { details: nativeDetails() },
      },
      harness.context,
    );
    harness.setIdle(true);
    harness.handlers.get("agent_settled")!({}, harness.context);

    expect(harness.compactionRequests).toHaveLength(0);
    expect(harness.sentUserMessages).toEqual([]);
  });

  test("does not interrupt below the configured threshold", () => {
    const entry = userEntry("user-1", "continue the task");
    const harness = extensionHarness([entry]);
    harness.setUsageTokens(179_999);
    harness.handlers.get("turn_end")!({}, harness.context);
    expect(harness.aborted).toBe(false);
  });

  test("does not restart aborted, failed, or truncated turns", () => {
    for (const stopReason of ["aborted", "error", "length"]) {
      const harness = extensionHarness([userEntry(`user-${stopReason}`, "stop")]);
      harness.setUsageTokens(200_000);
      harness.handlers.get("turn_end")!(
        { message: { role: "assistant", stopReason } },
        harness.context,
      );
      harness.setIdle(true);
      harness.handlers.get("agent_settled")!({}, harness.context);
      expect(harness.aborted).toBe(false);
      expect(harness.compactionRequests).toEqual([]);
      expect(harness.sentUserMessages).toEqual([]);
    }
  });

  test("continues as a follow-up when input is queued after the abort", () => {
    const entry = userEntry("user-1", "continue the task");
    const harness = extensionHarness([entry]);
    harness.setUsageTokens(180_000);
    harness.handlers.get("turn_end")!({}, harness.context);
    harness.setHasPendingMessages(true);
    harness.handlers.get("agent_settled")!({}, harness.context);
    harness.handlers.get("session_compact")!(
      {
        reason: "manual",
        willRetry: false,
        fromExtension: true,
        compactionEntry: { details: nativeDetails() },
      },
      harness.context,
    );
    harness.compactionRequests[0].onComplete({});
    expect(harness.sentUserMessages).toEqual([
      {
        content: "Compaction completed. Continue.",
        options: { deliverAs: "followUp" },
      },
    ]);
  });

  test("continues when abort clears input that was already queued", () => {
    const harness = extensionHarness([userEntry("user-queued", "continue")]);
    harness.setUsageTokens(180_000);
    harness.setHasPendingMessages(true);
    harness.handlers.get("turn_end")!({}, harness.context);
    harness.setHasPendingMessages(false);
    harness.setIdle(true);
    harness.handlers.get("agent_settled")!({}, harness.context);
    harness.handlers.get("session_compact")!(
      {
        reason: "manual",
        willRetry: false,
        fromExtension: true,
        compactionEntry: { details: nativeDetails() },
      },
      harness.context,
    );
    harness.compactionRequests[0].onComplete({});
    expect(harness.sentUserMessages).toEqual([
      {
        content: "Compaction completed. Continue.",
        options: undefined,
      },
    ]);
  });

  test("a completed manual compaction clears pending automatic compaction", () => {
    const harness = extensionHarness([userEntry("user-manual", "continue")]);
    harness.setUsageTokens(180_000);
    harness.handlers.get("turn_end")!({}, harness.context);
    harness.handlers.get("session_compact")!(
      {
        reason: "manual",
        willRetry: false,
        fromExtension: true,
        compactionEntry: { details: nativeDetails() },
      },
      harness.context,
    );
    harness.setIdle(true);
    harness.handlers.get("agent_settled")!({}, harness.context);
    expect(harness.compactionRequests).toEqual([]);
    expect(harness.sentUserMessages).toEqual([]);
  });

  test("clears pending automatic compaction when the model changes", () => {
    const entry = userEntry("user-1", "continue the task");
    const harness = extensionHarness([entry]);
    harness.setUsageTokens(180_000);
    harness.handlers.get("turn_end")!({}, harness.context);
    harness.handlers.get("model_select")!({ model }, harness.context);
    harness.setIdle(true);
    harness.handlers.get("agent_settled")!({}, harness.context);
    expect(harness.compactionRequests).toEqual([]);
    expect(harness.sentUserMessages).toEqual([]);
  });

  test("cancels an in-flight native request when the model changes", async () => {
    let requestStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      requestStarted = resolve;
    });
    globalThis.fetch = ((_url: string | URL | Request, init?: RequestInit) => {
      requestStarted?.();
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        const abort = () => reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
        if (signal?.aborted) abort();
        else signal?.addEventListener("abort", abort, { once: true });
      });
    }) as typeof fetch;

    const entry = userEntry("user-in-flight", "compact now");
    const harness = extensionHarness([entry]);
    const pending = harness.handlers.get("session_before_compact")!(
      {
        branchEntries: [entry],
        preparation: { firstKeptEntryId: entry.id, tokensBefore: 50_000 },
        reason: "manual",
        willRetry: false,
        signal: new AbortController().signal,
      },
      harness.context,
    );
    await started;
    harness.handlers.get("model_select")!(
      { model: { ...model, id: "gpt-other" }, previousModel: model },
      { ...harness.context, model: { ...model, id: "gpt-other" } },
    );
    await expect(pending).resolves.toEqual({ cancel: true });
    expect(
      harness.getBranch().filter((branchEntry: any) => branchEntry.type === "compaction"),
    ).toEqual([]);
  });

  test("leaves non-Codex providers untouched", async () => {
    const entry = userEntry("user-1", "hello");
    const harness = extensionHarness([entry]);
    const otherContext = {
      ...harness.context,
      model: { ...model, provider: "anthropic", api: "anthropic-messages" },
    };
    const headers = { existing: "value" };

    expect(
      await harness.handlers.get("before_provider_request")!(
        { payload: { input: ["original"] } },
        otherContext,
      ),
    ).toBeUndefined();
    harness.handlers.get("before_provider_headers")!({ headers }, otherContext);
    harness.setUsageTokens(200_000);
    harness.handlers.get("turn_end")!({}, otherContext);
    expect(headers).toEqual({ existing: "value" });
    expect(harness.aborted).toBe(false);
    expect(
      await harness.handlers.get("session_before_compact")!(
        {
          branchEntries: [entry],
          preparation: { firstKeptEntryId: "user-1", tokensBefore: 50_000 },
          reason: "manual",
          willRetry: false,
          signal: new AbortController().signal,
        },
        otherContext,
      ),
    ).toBeUndefined();
  });

  test("aborts rather than sending a malformed local checkpoint", async () => {
    const firstUser = userEntry("user-1", "hello");
    const malformed = {
      type: "compaction",
      id: "compact-1",
      parentId: "user-1",
      timestamp: new Date().toISOString(),
      summary: "local marker",
      firstKeptEntryId: "user-1",
      tokensBefore: 100,
      details: {
        kind: NATIVE_COMPACTION_KIND,
        version: NATIVE_COMPACTION_VERSION,
        modelKey: "bad",
        replacementHistory: [],
      },
    } as SessionEntry;
    const harness = extensionHarness([firstUser, malformed]);
    const patched = await harness.handlers.get("before_provider_request")!(
      {
        payload: { model: model.id, input: [{ role: "user", content: "local marker" }] },
      },
      harness.context,
    );

    expect(harness.aborted).toBe(true);
    expect(patched.input).toEqual([]);
    expect(JSON.stringify(patched)).not.toContain("local marker");
  });
});

describe("native compaction helpers", () => {
  test("retains only recent user messages before the opaque item", () => {
    const input = [
      { type: "message", role: "user", content: [{ type: "input_text", text: "old" }] },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "reply" }] },
      { type: "function_call", call_id: "call-1" },
      { type: "message", role: "user", content: [{ type: "input_text", text: "new" }] },
    ] as any;
    const retained = retainRecentUserMessages(input);
    expect(retained).toHaveLength(2);
    expect(retained.every((item) => item.role === "user")).toBe(true);

    const replacement = buildReplacementHistory(input, {
      type: "compaction",
      encrypted_content: "opaque",
    });
    expect(replacement.at(-1)).toEqual({ type: "compaction", encrypted_content: "opaque" });
  });

  test("retains image-only user messages and truncates an oversized boundary message", () => {
    const image = {
      role: "user",
      content: [{ type: "input_image", image_url: "data:image/png;base64,aW1hZ2U=" }],
    };
    expect(retainRecentUserMessages([image])).toEqual([image]);

    const oversized = {
      role: "user",
      content: [{ type: "input_text", text: "A".repeat(200) }],
    };
    const retained = retainRecentUserMessages([oversized], 10);
    expect(retained).toHaveLength(1);
    expect(JSON.stringify(retained)).toContain("…");
    expect(JSON.stringify(retained).length).toBeLessThan(JSON.stringify(oversized).length);
  });

  test("repeated compaction replaces rather than nests the old opaque item", () => {
    const firstUser = userEntry("user-1", "old user fact");
    const firstCheckpoint = {
      type: "compaction",
      id: "compact-1",
      parentId: "user-1",
      timestamp: new Date().toISOString(),
      summary: "local marker 1",
      firstKeptEntryId: "user-1",
      tokensBefore: 100,
      details: {
        kind: NATIVE_COMPACTION_KIND,
        version: NATIVE_COMPACTION_VERSION,
        modelKey: "openai-codex:openai-codex-responses:gpt-test",
        replacementHistory: [
          { role: "user", content: [{ type: "input_text", text: "old user fact" }] },
          { type: "compaction", encrypted_content: "opaque-1" },
        ],
      },
    } as SessionEntry;
    const nextUser = {
      ...userEntry("user-2", "new user fact"),
      parentId: "compact-1",
    } as SessionEntry;
    const input = effectiveInputForBranch({
      branch: [firstUser, firstCheckpoint, nextUser],
      model,
      tools: [],
    });
    expect(input.filter((item) => item.type === "compaction")).toHaveLength(1);

    const replacement = buildReplacementHistory(input, {
      type: "compaction",
      encrypted_content: "opaque-2",
    });
    expect(replacement.filter((item) => item.type === "compaction")).toEqual([
      { type: "compaction", encrypted_content: "opaque-2" },
    ]);
    expect(JSON.stringify(replacement)).toContain("new user fact");
  });

  test("overflow recovery excludes the failed assistant response", () => {
    const user = userEntry("user-1", "large request");
    const failure = {
      type: "message",
      id: "assistant-error",
      parentId: "user-1",
      timestamp: new Date().toISOString(),
      message: {
        role: "assistant",
        content: [{ type: "text", text: "context window exceeded" }],
        provider: "openai-codex",
        api: "openai-codex-responses",
        model: model.id,
        stopReason: "error",
        timestamp: Date.now(),
      },
    } as SessionEntry;
    const input = effectiveInputForBranch({
      branch: [user, failure],
      model,
      tools: [],
      excludeLastAssistantError: true,
    });
    expect(JSON.stringify(input)).not.toContain("context window exceeded");
    expect(JSON.stringify(input)).toContain("large request");
  });

  test("overflow recovery removes a truncated assistant and its synthetic tool results", () => {
    const user = userEntry("user-length", "large request");
    const truncated = {
      type: "message",
      id: "assistant-length",
      parentId: user.id,
      timestamp: new Date().toISOString(),
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "call-length|fc_length", name: "edit", arguments: {} }],
        provider: "openai-codex",
        api: "openai-codex-responses",
        model: model.id,
        stopReason: "length",
        timestamp: Date.now(),
      },
    } as SessionEntry;
    const syntheticResult = {
      type: "message",
      id: "result-length",
      parentId: "assistant-length",
      timestamp: new Date().toISOString(),
      message: {
        role: "toolResult",
        toolCallId: "call-length|fc_length",
        toolName: "edit",
        content: [{ type: "text", text: "Tool call arguments were truncated" }],
        isError: true,
        timestamp: Date.now(),
      },
    } as SessionEntry;
    const input = effectiveInputForBranch({
      branch: [user, truncated, syntheticResult],
      model,
      tools: [],
      excludeLastAssistantError: true,
    });
    expect(JSON.stringify(input)).not.toContain("call-length");
    expect(JSON.stringify(input)).not.toContain("arguments were truncated");
  });

  test("does not replay partial tool calls from an aborted assistant after a checkpoint", () => {
    const checkpoint = {
      type: "custom",
      id: "checkpoint",
      parentId: null,
      timestamp: new Date().toISOString(),
      customType: NATIVE_COMPACTION_KIND,
      data: {
        kind: NATIVE_COMPACTION_KIND,
        version: NATIVE_COMPACTION_VERSION,
        modelKey: "openai-codex:openai-codex-responses:gpt-test",
        replacementHistory: [{ type: "compaction", encrypted_content: "opaque" }],
      },
    } as SessionEntry;
    const aborted = {
      type: "message",
      id: "assistant-aborted",
      parentId: "checkpoint",
      timestamp: new Date().toISOString(),
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call-aborted|fc_aborted",
            name: "edit",
            arguments: { path: "src/client/input.rs" },
          },
        ],
        provider: "openai-codex",
        api: "openai-codex-responses",
        model: model.id,
        stopReason: "aborted",
        timestamp: Date.now(),
      },
    } as unknown as SessionEntry;
    const user = {
      ...userEntry("user-after-abort", "what happened?"),
      parentId: "assistant-aborted",
    } as SessionEntry;

    const input = effectiveInputForBranch({
      branch: [checkpoint, aborted, user],
      model,
      tools: [],
    });
    expect(JSON.stringify(input)).not.toContain("call-aborted");
    expect(JSON.stringify(input)).toContain("what happened?");
  });

  test("synthesizes outputs for non-aborted orphaned tool calls", () => {
    const assistant = {
      type: "message",
      id: "assistant-tool",
      parentId: null,
      timestamp: new Date().toISOString(),
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "call-orphan|fc_orphan", name: "edit", arguments: {} }],
        provider: "openai-codex",
        api: "openai-codex-responses",
        model: model.id,
        stopReason: "toolUse",
        timestamp: Date.now(),
      },
    } as SessionEntry;
    const user = {
      ...userEntry("user-after-tool", "interrupt"),
      parentId: "assistant-tool",
    } as SessionEntry;

    const input = effectiveInputForBranch({ branch: [assistant, user], model, tools: [] });
    expect(input).toContainEqual({
      type: "function_call_output",
      call_id: "call-orphan",
      output: "No result provided",
    });
  });

  test("latest compaction on the active branch is authoritative", () => {
    const native = {
      type: "compaction",
      id: "native",
      parentId: null,
      timestamp: new Date().toISOString(),
      summary: "marker",
      firstKeptEntryId: "user",
      tokensBefore: 100,
      details: {
        kind: NATIVE_COMPACTION_KIND,
        version: NATIVE_COMPACTION_VERSION,
        modelKey: "openai-codex:openai-codex-responses:gpt-test",
        replacementHistory: [{ type: "compaction", encrypted_content: "opaque" }],
      },
    } as SessionEntry;
    expect(findNativeCheckpoint([native]).status).toBe("valid");
    expect(
      findNativeCheckpoint([native, { ...native, id: "local", details: {} } as SessionEntry])
        .status,
    ).toBe("none");
  });

  test("merges the beta feature without removing existing features", () => {
    expect(mergeFeatureHeader("foo, remote_compaction_v2")).toBe("foo,remote_compaction_v2");
  });

  test("rejects empty, wrong-version, and request-only checkpoint data", () => {
    expect(
      parseNativeCompactionDetails({
        kind: NATIVE_COMPACTION_KIND,
        version: NATIVE_COMPACTION_VERSION,
        modelKey: "",
        replacementHistory: [{ type: "compaction", encrypted_content: "opaque" }],
      }),
    ).toBeUndefined();
    expect(
      parseNativeCompactionDetails({
        kind: NATIVE_COMPACTION_KIND,
        version: NATIVE_COMPACTION_VERSION,
        modelKey: "openai-codex:openai-codex-responses:gpt-test",
        replacementHistory: [{ type: "compaction", encrypted_content: "  " }],
      }),
    ).toBeUndefined();
    expect(
      parseNativeCompactionDetails({
        ...nativeDetails(),
        version: NATIVE_COMPACTION_VERSION + 1,
      }),
    ).toBeUndefined();
    expect(
      parseNativeCompactionDetails({
        ...nativeDetails(),
        replacementHistory: [
          { type: "compaction_trigger" },
          { type: "compaction", encrypted_content: "opaque" },
        ],
      }),
    ).toBeUndefined();
    expect(() =>
      buildReplacementHistory([], { type: "compaction", encrypted_content: "" }),
    ).toThrow();
  });

  test("accepts only the exact Codex provider and API combination", () => {
    expect(isOpenAICodexModel(model)).toBe(true);
    for (const other of [
      { ...model, provider: "github-copilot" },
      { ...model, provider: "openai" },
      { ...model, api: "openai-responses" },
      undefined,
    ]) {
      expect(isOpenAICodexModel(other)).toBe(false);
    }
  });

  test("uses the newest native checkpoint and rejects a checkpoint from another model", () => {
    const first = {
      type: "custom",
      id: "native-1",
      parentId: null,
      timestamp: new Date().toISOString(),
      customType: NATIVE_COMPACTION_KIND,
      data: nativeDetails("opaque-1"),
    } as SessionEntry;
    const second = {
      ...first,
      id: "native-2",
      parentId: "native-1",
      data: nativeDetails("opaque-2"),
    } as SessionEntry;
    const lookup = findNativeCheckpoint([first, second]);
    expect(lookup.status).toBe("valid");
    if (lookup.status === "valid") expect(lookup.checkpoint.entryId).toBe("native-2");

    const foreign = {
      ...second,
      data: {
        ...nativeDetails(),
        modelKey: "openai-codex:openai-codex-responses:gpt-other",
      },
    } as SessionEntry;
    expect(() => effectiveInputForBranch({ branch: [foreign], model, tools: [] })).toThrow(
      "different model",
    );
  });

  test("converts multimodal reasoning, calls, outputs, and dynamic tools", () => {
    const assistant = {
      type: "message",
      id: "assistant-1",
      parentId: null,
      timestamp: new Date().toISOString(),
      message: {
        role: "assistant",
        content: [
          {
            type: "thinking",
            thinking: "private reasoning",
            thinkingSignature: JSON.stringify({ type: "reasoning", id: "reason-1" }),
          },
          { type: "text", text: "I will inspect it." },
          { type: "toolCall", id: "call-1|fc_1", name: "inspect", arguments: { path: "a" } },
        ],
        provider: "openai-codex",
        api: "openai-codex-responses",
        model: model.id,
        stopReason: "toolUse",
        timestamp: Date.now(),
      },
    } as unknown as SessionEntry;
    const result = {
      type: "message",
      id: "result-1",
      parentId: "assistant-1",
      timestamp: new Date().toISOString(),
      message: {
        role: "toolResult",
        toolCallId: "call-1|fc_1",
        toolName: "inspect",
        content: [
          { type: "text", text: "found it" },
          { type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
        ],
        addedToolNames: ["dynamic"],
        isError: false,
        timestamp: Date.now(),
      },
    } as unknown as SessionEntry;
    const input = effectiveInputForBranch({
      branch: [userEntry("user-1", "look at this"), assistant, result],
      model: {
        ...model,
        input: ["text", "image"],
        compat: { supportsToolSearch: true },
      },
      tools: [
        {
          name: "dynamic",
          description: "A dynamic tool",
          parameters: { type: "object", properties: {} },
        } as any,
      ],
    });
    expect(input).toContainEqual({
      type: "reasoning",
      id: "reason-1",
    });
    expect(input).toContainEqual(
      expect.objectContaining({ type: "function_call", call_id: "call-1" }),
    );
    expect(input).toContainEqual(
      expect.objectContaining({ type: "function_call_output", call_id: "call-1" }),
    );
    expect(input.some((item) => item.type === "tool_search_call")).toBe(true);
    expect(JSON.stringify(input)).toContain("input_image");
  });

  test("downgrades unsupported images and does not replay foreign encrypted reasoning", () => {
    const userWithImage = {
      type: "message",
      id: "user-image",
      parentId: null,
      timestamp: new Date().toISOString(),
      message: {
        role: "user",
        content: [{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }],
        timestamp: Date.now(),
      },
    } as SessionEntry;
    const foreignAssistant = {
      type: "message",
      id: "assistant-foreign-model",
      parentId: "user-image",
      timestamp: new Date().toISOString(),
      message: {
        role: "assistant",
        content: [
          {
            type: "thinking",
            thinking: "readable prior reasoning",
            thinkingSignature: JSON.stringify({
              type: "reasoning",
              encrypted_content: "foreign-secret",
            }),
          },
          {
            type: "toolCall",
            id: "call-foreign|fc_foreign",
            name: "read",
            arguments: {},
          },
        ],
        provider: "openai-codex",
        api: "openai-codex-responses",
        model: "gpt-other",
        stopReason: "toolUse",
        timestamp: Date.now(),
      },
    } as unknown as SessionEntry;
    const input = effectiveInputForBranch({
      branch: [userWithImage, foreignAssistant],
      model,
      tools: [],
    });
    const serialized = JSON.stringify(input);
    expect(serialized).toContain("image omitted: model does not support images");
    expect(serialized).toContain("readable prior reasoning");
    expect(serialized).not.toContain("foreign-secret");
    expect(input.find((item) => item.type === "function_call")).not.toHaveProperty("id");
  });

  test("builds one compaction trigger from the current request shape", () => {
    const body = buildCompactionRequestBody({
      basePayload: {
        input: [{ type: "compaction_trigger" }],
        messages: ["remove"],
        previous_response_id: "remove",
        include: ["existing.feature"],
        reasoning: { effort: "high" },
        temperature: 0.2,
        tools: ["stale"],
      },
      model,
      input: [
        { role: "user", content: [{ type: "input_text", text: "hello" }] },
        { type: "compaction_trigger" },
      ],
      instructions: "Current instructions",
      tools: [{ type: "function", name: "active" }],
      sessionId: "session-identity",
    });
    const input = body.input as JsonObject[];
    expect(input.filter((item) => item.type === "compaction_trigger")).toHaveLength(1);
    expect(input.at(-1)).toEqual({ type: "compaction_trigger" });
    expect(body.messages).toBeUndefined();
    expect(body.previous_response_id).toBeUndefined();
    expect(body.instructions).toBe("Current instructions");
    expect(body.prompt_cache_key).toBe("session-identity");
    expect(body.include).toEqual(["existing.feature", "reasoning.encrypted_content"]);
    expect(body.reasoning).toEqual({ effort: "high" });
    expect(body.temperature).toBe(0.2);
    expect(body.tools).toEqual([{ type: "function", name: "active" }]);
  });

  test("rejects missing, duplicate, malformed, and unencrypted compaction items", async () => {
    const completed = { type: "response.completed", response: {} };
    const invalidStreams = [
      () => sseResponse([completed]),
      () =>
        sseResponse([
          {
            type: "response.output_item.done",
            item: { type: "compaction", encrypted_content: "one" },
          },
          {
            type: "response.output_item.done",
            item: { type: "compaction", encrypted_content: "two" },
          },
          completed,
        ]),
      () =>
        sseResponse([
          {
            type: "response.output_item.done",
            item: { type: "compaction", encrypted_content: "" },
          },
          completed,
        ]),
      () =>
        new Response("data: {not-json}\n\n", {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
    ];

    for (const stream of invalidStreams) {
      let attempts = 0;
      await expect(
        callRemoteCompaction({
          url: resolveCodexResponsesUrl(model.baseUrl),
          headers: buildCodexHeaders({ apiKey: token(), sessionId: "session-1" }),
          body: { model: model.id },
          model,
          delay: async () => {},
          fetchImpl: async () => {
            attempts++;
            return stream();
          },
        }),
      ).rejects.toThrow();
      expect(attempts).toBe(1);
    }
  });

  test("checks response.done terminal status before accepting a checkpoint", async () => {
    let incompleteAttempts = 0;
    const retried = await callRemoteCompaction({
      url: resolveCodexResponsesUrl(model.baseUrl),
      headers: buildCodexHeaders({ apiKey: token(), sessionId: "session-1" }),
      body: { model: model.id },
      model,
      delay: async () => {},
      fetchImpl: async () => {
        incompleteAttempts++;
        return incompleteAttempts === 1
          ? sseResponse([
              {
                type: "response.output_item.done",
                item: { type: "compaction", encrypted_content: "not-complete" },
              },
              { type: "response.done", response: { status: "incomplete" } },
            ])
          : compactionSse("complete-status");
      },
    });
    expect(incompleteAttempts).toBe(2);
    expect(retried.compactionItem.encrypted_content).toBe("complete-status");

    let failedAttempts = 0;
    await expect(
      callRemoteCompaction({
        url: resolveCodexResponsesUrl(model.baseUrl),
        headers: buildCodexHeaders({ apiKey: token(), sessionId: "session-1" }),
        body: { model: model.id },
        model,
        delay: async () => {},
        fetchImpl: async () => {
          failedAttempts++;
          return sseResponse([
            {
              type: "response.output_item.done",
              item: { type: "compaction", encrypted_content: "failed" },
            },
            {
              type: "response.done",
              response: { status: "failed", error: { message: "terminal failure" } },
            },
          ]);
        },
      }),
    ).rejects.toThrow("terminal failure");
    expect(failedAttempts).toBe(1);
  });

  test("retries incomplete streams and transport errors at most twice", async () => {
    let incompleteAttempts = 0;
    const incomplete = await callRemoteCompaction({
      url: resolveCodexResponsesUrl(model.baseUrl),
      headers: buildCodexHeaders({ apiKey: token(), sessionId: "session-1" }),
      body: { model: model.id },
      model,
      delay: async () => {},
      fetchImpl: async () => {
        incompleteAttempts++;
        return incompleteAttempts === 1
          ? sseResponse([
              {
                type: "response.output_item.done",
                item: { type: "compaction", encrypted_content: "incomplete" },
              },
            ])
          : compactionSse("complete-after-retry");
      },
    });
    expect(incompleteAttempts).toBe(2);
    expect(incomplete.compactionItem.encrypted_content).toBe("complete-after-retry");

    let transportAttempts = 0;
    const delays: number[] = [];
    const transported = await callRemoteCompaction({
      url: resolveCodexResponsesUrl(model.baseUrl),
      headers: buildCodexHeaders({ apiKey: token(), sessionId: "session-1" }),
      body: { model: model.id },
      model,
      delay: async (milliseconds) => {
        delays.push(milliseconds);
      },
      fetchImpl: async () => {
        transportAttempts++;
        if (transportAttempts < 3) throw new TypeError("network unavailable");
        return compactionSse("complete-after-transport");
      },
    });
    expect(transportAttempts).toBe(3);
    expect(delays).toEqual([1000, 2000]);
    expect(transported.compactionItem.encrypted_content).toBe("complete-after-transport");
  });

  test("honors Retry-After while allowing retry delays to be injected", async () => {
    let attempts = 0;
    const delays: number[] = [];
    const headers = buildCodexHeaders({ apiKey: token(), sessionId: "session-1" });
    const result = await callRemoteCompaction({
      url: resolveCodexResponsesUrl(model.baseUrl),
      headers,
      body: { model: model.id },
      model,
      delay: async (milliseconds) => {
        delays.push(milliseconds);
      },
      fetchImpl: async () => {
        attempts++;
        return attempts === 1
          ? new Response("busy", { status: 429, headers: { "retry-after": "7" } })
          : compactionSse("retry-success");
      },
    });
    expect(attempts).toBe(2);
    expect(delays).toEqual([7000]);
    expect(result.compactionItem.encrypted_content).toBe("retry-success");
  });

  test("gates context rewriting for non-Codex models", () => {
    const entry = userEntry("user-1", "hello");
    const native = {
      type: "compaction",
      id: "native",
      parentId: "user-1",
      timestamp: new Date().toISOString(),
      summary: "marker",
      firstKeptEntryId: "user-1",
      tokensBefore: 100,
      details: {
        kind: NATIVE_COMPACTION_KIND,
        version: NATIVE_COMPACTION_VERSION,
        modelKey: "openai-codex:openai-codex-responses:gpt-test",
        replacementHistory: [{ type: "compaction", encrypted_content: "opaque" }],
      },
    } as SessionEntry;
    const harness = extensionHarness([entry, native]);
    const result = harness.handlers.get("context")!(
      { messages: [{ role: "compactionSummary", summary: "marker" }] },
      { ...harness.context, model: { ...model, provider: "anthropic", api: "anthropic-messages" } },
    );
    expect(result).toBeUndefined();
  });

  test("uses defaults when global and untrusted project config are unavailable", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-codex-default-config-"));
    const previous = process.env.PI_CODING_AGENT_DIR;
    try {
      process.env.PI_CODING_AGENT_DIR = root;
      const project = join(root, "project");
      const projectPath = join(project, ".pi", "pi-codex-compaction.json");
      mkdirForFile(projectPath);
      writeFileSync(projectPath, JSON.stringify({ autoCompact: false, thresholdRatio: 0.5 }));
      expect(loadConfig(project, false)).toEqual({ autoCompact: true, thresholdRatio: 0.9 });
    } finally {
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("uses trusted project config precedence and ignores invalid values", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-codex-config-"));
    const previous = process.env.PI_CODING_AGENT_DIR;
    try {
      process.env.PI_CODING_AGENT_DIR = root;
      const paths = resolveConfigPaths(join(root, "project"), true);
      writeFileSync(paths.globalPath, JSON.stringify({ autoCompact: false, thresholdRatio: 0.8 }));
      mkdirForFile(paths.projectPath!);
      writeFileSync(
        paths.projectPath!,
        JSON.stringify({ autoCompact: true, thresholdRatio: "invalid" }),
      );
      expect(loadConfig(join(root, "project"), true)).toEqual({
        autoCompact: true,
        thresholdRatio: 0.8,
      });
      expect(loadConfig(join(root, "project"), false)).toEqual({
        autoCompact: false,
        thresholdRatio: 0.8,
      });
    } finally {
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
      rmSync(root, { recursive: true, force: true });
    }
  });
});

function mkdirForFile(path: string): void {
  const directory = path.slice(0, path.lastIndexOf("/"));
  if (directory) mkdirSync(directory, { recursive: true });
}
