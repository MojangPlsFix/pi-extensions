import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, test } from "vitest";
import sessionSummaryExtension, { buildSessionSummaryRequest } from "../index.js";

type SummaryModel = Parameters<typeof buildSessionSummaryRequest>[0];
type SummaryAuth = Parameters<typeof buildSessionSummaryRequest>[1];
type Handler = (...args: any[]) => any;

type Harness = ReturnType<typeof createHarness>;

const originalSummarySetting = process.env.PI_SESSION_SUMMARY;

function makeUsage(input = 3, output = 4): Usage {
  return {
    input,
    output,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: input + output,
    cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 },
  };
}

function makeModel(): SummaryModel {
  return {
    provider: "github-copilot",
    id: "gpt-5.6-luna",
    name: "GPT-5.6 Luna",
    api: "openai-responses",
    baseUrl: "https://api.individual.githubcopilot.com",
    reasoning: true,
    input: ["text"],
    cost: { input: 0.2, output: 1.2, cacheRead: 0.02, cacheWrite: 0 },
    contextWindow: 1_050_000,
    maxTokens: 128_000,
  } as SummaryModel;
}

function makeUserEntry(text = "Implement session title generation", id = "user-1"): SessionEntry {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp: new Date(0).toISOString(),
    message: {
      role: "user",
      content: [{ type: "text", text }],
      timestamp: 0,
    },
  } as SessionEntry;
}

function makeAssistantMessage(
  content: AssistantMessage["content"],
  usage = makeUsage(),
  stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "openai-responses",
    provider: "github-copilot",
    model: "gpt-5.6-luna",
    usage,
    stopReason,
    timestamp: Date.now(),
  };
}

function makeAssistantEntry(message: AssistantMessage, id = "assistant-1"): SessionEntry {
  return {
    type: "message",
    id,
    parentId: "user-1",
    timestamp: new Date().toISOString(),
    message,
  } as SessionEntry;
}

function createHarness(options?: {
  branch?: SessionEntry[];
  model?: SummaryModel;
  modelUnavailable?: boolean;
  auth?: unknown;
  response?: AssistantMessage;
  completeError?: Error;
  name?: string;
  hasUI?: boolean;
}) {
  const entries = [...(options?.branch ?? [makeUserEntry()])];
  const model = options?.model ?? makeModel();
  const events = new Map<string, Handler[]>();
  const commands = new Map<string, Handler>();
  const statuses: Array<{ key: string; text: string | undefined }> = [];
  const notices: Array<{ message: string; type?: string }> = [];
  const completionCalls: Array<{
    model: SummaryModel;
    context: unknown;
    options: Record<string, unknown>;
  }> = [];
  const findCalls: Array<{ provider: string; model: string }> = [];
  const authCalls: SummaryModel[] = [];
  const emittedEvents: string[] = [];
  let sessionName = options?.name;

  const registry = {
    find(provider: string, modelId: string) {
      findCalls.push({ provider, model: modelId });
      return options?.modelUnavailable ? undefined : model;
    },
    async getApiKeyAndHeaders(foundModel: SummaryModel) {
      authCalls.push(foundModel);
      return (
        options?.auth ?? {
          ok: true,
          apiKey: "test-token",
          headers: { "x-test": "value" },
          baseUrl: foundModel.baseUrl,
          env: { TEST_PROVIDER_ENV: "value" },
        }
      );
    },
    async complete(
      foundModel: SummaryModel,
      context: unknown,
      requestOptions: Record<string, unknown>,
    ) {
      completionCalls.push({ model: foundModel, context, options: requestOptions });
      if (options?.completeError) throw options.completeError;
      return (
        options?.response ??
        makeAssistantMessage([{ type: "text", text: "Implement session titles" }])
      );
    },
  };

  const context = {
    mode: "tui",
    hasUI: options?.hasUI ?? true,
    cwd: "/tmp/session-summary-test",
    model,
    modelRegistry: registry,
    scopedModels: [],
    ui: {
      theme: { fg: (_color: string, text: string) => text },
      setStatus(key: string, text: string | undefined) {
        statuses.push({ key, text });
      },
      notify(message: string, type?: string) {
        notices.push({ message, type });
      },
    },
    sessionManager: {
      getSessionId: () => "session-1",
      getBranch: () => entries,
      getEntries: () => entries,
      getSessionFile: () => "/tmp/session-summary-test.jsonl",
      getSessionDir: () => "/tmp",
    },
    isIdle: () => true,
    isProjectTrusted: () => true,
    signal: undefined,
    abort: () => {},
    hasPendingMessages: () => false,
    shutdown: () => {},
    getContextUsage: () => undefined,
    compact: () => {},
    getSystemPrompt: () => "",
  } as unknown as ExtensionContext;

  const api = {
    on(name: string, handler: Handler) {
      events.set(name, [...(events.get(name) ?? []), handler]);
    },
    registerCommand(name: string, options: { handler: Handler }) {
      commands.set(name, options.handler);
    },
    setSessionName(name: string) {
      sessionName = name;
      entries.push({
        type: "session_info",
        id: `session-info-${entries.length}`,
        parentId: entries.at(-1)?.id ?? null,
        timestamp: new Date().toISOString(),
        name,
      } as SessionEntry);
    },
    getSessionName: () => sessionName,
    appendEntry(customType: string, data: unknown) {
      entries.push({
        type: "custom",
        customType,
        id: `custom-${entries.length}`,
        parentId: entries.at(-1)?.id ?? null,
        timestamp: new Date().toISOString(),
        data,
      } as SessionEntry);
    },
    events: {
      emit(name: string) {
        emittedEvents.push(name);
      },
    },
  } as unknown as ExtensionAPI;

  sessionSummaryExtension(api);

  return {
    api,
    context,
    entries,
    events,
    commands,
    statuses,
    notices,
    completionCalls,
    findCalls,
    authCalls,
    emittedEvents,
    getSessionName: () => sessionName,
  };
}

async function emit(harness: Harness, eventName: string, event: unknown): Promise<unknown[]> {
  const results: unknown[] = [];
  for (const handler of harness.events.get(eventName) ?? []) {
    results.push(await handler(event, harness.context));
  }
  return results;
}

async function startSession(harness: Harness): Promise<void> {
  await emit(harness, "session_start", { type: "session_start" });
}

async function emitAssistant(harness: Harness, message: AssistantMessage): Promise<unknown[]> {
  const results = await emit(harness, "message_end", { message });
  harness.entries.push(makeAssistantEntry(message, `assistant-${harness.entries.length}`));
  return results;
}

afterEach(() => {
  if (originalSummarySetting === undefined) delete process.env.PI_SESSION_SUMMARY;
  else process.env.PI_SESSION_SUMMARY = originalSummarySetting;
});

describe("session summary request auth", () => {
  test("preserves nullable provider headers and the resolved base URL", () => {
    const model = makeModel();
    const headers = { "x-keep": "value", "x-remove": null };
    const auth: SummaryAuth = {
      apiKey: "token",
      headers,
      baseUrl: "https://copilot-business.example.test",
      env: { COPILOT_GITHUB_TOKEN: "token" },
    };

    const request = buildSessionSummaryRequest(model, auth);

    expect(request.model.baseUrl).toBe(auth.baseUrl);
    expect(request.auth.headers).toBe(headers);
    expect(request.auth.headers).toEqual({ "x-keep": "value", "x-remove": null });
    expect(request.auth.env).toEqual(auth.env);
  });
});

describe("session summary title generation", () => {
  test("selects Luna through the registry and omits reasoning options", async () => {
    const usage = makeUsage(7, 5);
    const harness = createHarness({
      response: makeAssistantMessage(
        [{ type: "text", text: "Title: Add persistent session titles" }],
        usage,
      ),
    });
    await startSession(harness);

    const eventMessage = makeAssistantMessage(
      [{ type: "text", text: "Implemented the title flow" }],
      makeUsage(2, 1),
    );
    const results = await emitAssistant(harness, eventMessage);

    expect(harness.findCalls).toEqual([{ provider: "github-copilot", model: "gpt-5.6-luna" }]);
    expect(harness.authCalls).toHaveLength(1);
    const authCall = harness.authCalls[0]!;
    expect(authCall.id).toBe("gpt-5.6-luna");
    expect(harness.completionCalls).toHaveLength(1);
    const completionCall = harness.completionCalls[0]!;
    expect(completionCall.model.id).toBe("gpt-5.6-luna");
    expect(completionCall.options.maxTokens).toBe(800);
    expect(completionCall.options.timeoutMs).toBe(20_000);
    expect(Object.hasOwn(completionCall.options, "reasoningEffort")).toBe(false);
    expect(harness.statuses.some(({ text }) => text?.includes("github-copilot/gpt-5.6-luna"))).toBe(
      true,
    );
    expect(harness.getSessionName()).toBe("Add persistent session titles");
    expect(results[0]).toMatchObject({
      message: { usage: { input: 9, output: 6, totalTokens: 15 } },
    });
  });

  test("persists the generated title and usage accounting data", async () => {
    const usage = makeUsage(5, 6);
    const harness = createHarness({
      response: makeAssistantMessage([{ type: "text", text: "Session title" }], usage),
    });
    await startSession(harness);
    await emitAssistant(
      harness,
      makeAssistantMessage([{ type: "text", text: "Completed the requested change" }]),
    );

    const summaryEntry = harness.entries.find(
      (entry) => entry.type === "custom" && entry.customType === "session-summary",
    ) as Extract<SessionEntry, { type: "custom" }> | undefined;
    expect(summaryEntry?.data).toEqual({
      name: "Session title",
      messageCount: 2,
      usage,
      usageAttached: true,
    });
    expect(harness.emittedEvents).toContain("pi-tools:session-summary-usage");
  });

  test("reports an unavailable Luna model through status and command diagnostics", async () => {
    const harness = createHarness({ modelUnavailable: true });
    await startSession(harness);
    await emitAssistant(
      harness,
      makeAssistantMessage([{ type: "text", text: "The turn is complete" }]),
    );

    const status = harness.statuses.at(-1)?.text;
    expect(status).toContain("summary unavailable");
    expect(status).toContain("github-copilot/gpt-5.6-luna is unavailable");
    expect(harness.completionCalls).toHaveLength(0);

    await harness.commands.get("session-summary")?.("", harness.context);
    expect(harness.notices.at(-1)).toEqual({
      message: "Could not generate a session summary: github-copilot/gpt-5.6-luna is unavailable",
      type: "warning",
    });
  });

  test("reports empty final text and reasoning-only responses without persisting a title", async () => {
    const contentCases: AssistantMessage["content"][] = [
      [{ type: "text", text: "   " }],
      [{ type: "thinking", thinking: "internal reasoning only" }],
    ];
    for (const content of contentCases) {
      const harness = createHarness({ response: makeAssistantMessage(content) });
      await startSession(harness);
      await emitAssistant(
        harness,
        makeAssistantMessage([{ type: "text", text: "The turn is complete" }]),
      );

      const status = harness.statuses.at(-1)?.text;
      expect(status).toContain("summary unavailable");
      expect(status).toContain("returned no final text");
      expect(status).toContain(content[0]?.type ?? "unknown");
      expect(harness.getSessionName()).toBeUndefined();
      expect(
        harness.entries.some(
          (entry) => entry.type === "custom" && entry.customType === "session-summary",
        ),
      ).toBe(false);
    }
  });

  test("reports a truncated reasoning-only response without persisting a title", async () => {
    const response = makeAssistantMessage(
      [{ type: "thinking", thinking: "" }],
      makeUsage(),
      "length",
    );
    const harness = createHarness({ response });
    await startSession(harness);
    await emitAssistant(
      harness,
      makeAssistantMessage([{ type: "text", text: "The turn is complete" }]),
    );

    const status = harness.statuses.at(-1)?.text;
    expect(status).toContain("summary unavailable");
    expect(status).toContain("returned no final text");
    expect(status).toContain("stop: length");
    expect(status).toContain("content: thinking(0)");
    expect(harness.getSessionName()).toBeUndefined();
    expect(
      harness.entries.some(
        (entry) => entry.type === "custom" && entry.customType === "session-summary",
      ),
    ).toBe(false);
  });

  test("can retry after an empty response and preserves manual names", async () => {
    const harness = createHarness({
      response: makeAssistantMessage([{ type: "text", text: "   " }]),
    });
    await startSession(harness);
    await emitAssistant(
      harness,
      makeAssistantMessage([{ type: "text", text: "First completed turn" }]),
    );
    expect(harness.getSessionName()).toBeUndefined();

    harness.context.modelRegistry.complete = async (...args: any[]) => {
      harness.completionCalls.push({ model: args[0], context: args[1], options: args[2] });
      return makeAssistantMessage([{ type: "text", text: "Retry succeeds" }]);
    };
    await emitAssistant(
      harness,
      makeAssistantMessage([{ type: "text", text: "Second completed turn" }]),
    );
    expect(harness.getSessionName()).toBe("Retry succeeds");

    const manualHarness = createHarness({
      name: "Manual session name",
      branch: [
        makeUserEntry(),
        {
          type: "session_info",
          id: "manual-name",
          parentId: "user-1",
          timestamp: new Date().toISOString(),
          name: "Manual session name",
        } as SessionEntry,
      ],
    });
    await startSession(manualHarness);
    await emitAssistant(
      manualHarness,
      makeAssistantMessage([{ type: "text", text: "Do not replace this name" }]),
    );
    expect(manualHarness.completionCalls).toHaveLength(0);
    expect(manualHarness.getSessionName()).toBe("Manual session name");
  });

  test("respects PI_SESSION_SUMMARY=off", async () => {
    process.env.PI_SESSION_SUMMARY = "off";
    const harness = createHarness();
    await startSession(harness);
    await emitAssistant(
      harness,
      makeAssistantMessage([{ type: "text", text: "Do not summarize" }]),
    );

    expect(harness.completionCalls).toHaveLength(0);
    expect(harness.getSessionName()).toBeUndefined();
  });
});
