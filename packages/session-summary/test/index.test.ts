import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import {
  CONFIG_DIR_NAME,
  type ExtensionAPI,
  type ExtensionContext,
  type SessionEntry,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import sessionSummaryExtension, {
  buildSessionSummaryRequest,
  loadSessionSummaryProfiles,
} from "../index.js";

type SummaryModel = Parameters<typeof buildSessionSummaryRequest>[0];
type SummaryAuth = Parameters<typeof buildSessionSummaryRequest>[1];
type Handler = (...args: any[]) => any;
type Harness = ReturnType<typeof createHarness>;

type CompletionCall = {
  model: SummaryModel;
  context: { systemPrompt?: string; messages: Array<{ content: Array<{ text?: string }> }> };
  options: Record<string, unknown>;
};

const originalSummarySetting = process.env.PI_SESSION_SUMMARY;
const originalAgentDirectory = process.env.PI_CODING_AGENT_DIR;
const temporaryDirectories: string[] = [];

function makeUsage(input = 3, output = 4, cost = 0.03): Usage {
  return {
    input,
    output,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: input + output,
    cost: {
      input: cost / 3,
      output: (cost * 2) / 3,
      cacheRead: 0,
      cacheWrite: 0,
      total: cost,
    },
  };
}

function makeModel(
  provider = "github-copilot",
  id = "gpt-5.6-luna",
  overrides: Partial<SummaryModel> = {},
): SummaryModel {
  return {
    provider,
    id,
    name: id,
    api: provider === "openai-codex" ? "openai-codex-responses" : "openai-responses",
    baseUrl: `https://${provider}.example.test`,
    reasoning: true,
    input: ["text"],
    cost: { input: 0.2, output: 1.2, cacheRead: 0.02, cacheWrite: 0 },
    contextWindow: 1_050_000,
    maxTokens: 128_000,
    ...overrides,
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
  provider = "github-copilot",
  model = "gpt-5.6-luna",
  timestamp = Date.now(),
): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: provider === "openai-codex" ? "openai-codex-responses" : "openai-responses",
    provider,
    model,
    usage,
    stopReason,
    timestamp,
  };
}

function makeAssistantEntry(message: AssistantMessage, id = "assistant-1"): SessionEntry {
  return {
    type: "message",
    id,
    parentId: "user-1",
    timestamp: new Date(message.timestamp).toISOString(),
    message,
  } as SessionEntry;
}

function makeSummaryEntry(data: Record<string, unknown>, id = "summary-1"): SessionEntry {
  return {
    type: "custom",
    customType: "session-summary",
    id,
    parentId: null,
    timestamp: new Date().toISOString(),
    data,
  } as SessionEntry;
}

function createHarness(options?: {
  branch?: SessionEntry[];
  activeModel?: SummaryModel;
  models?: SummaryModel[];
  findModel?: (provider: string, modelId: string) => SummaryModel | undefined;
  auth?: (model: SummaryModel) => unknown | Promise<unknown>;
  complete?: (
    model: SummaryModel,
    callIndex: number,
    context: CompletionCall["context"],
    requestOptions: Record<string, unknown>,
  ) => AssistantMessage | Promise<AssistantMessage>;
  name?: string;
  hasUI?: boolean;
  cwd?: string;
  trusted?: boolean;
  sessionId?: string;
  sessionFile?: string;
}) {
  const activeModel = options?.activeModel ?? makeModel();
  const models = options?.models ?? [activeModel];
  const entries = [...(options?.branch ?? [makeUserEntry()])];
  const events = new Map<string, Handler[]>();
  const commands = new Map<string, Handler>();
  const statuses: Array<{ key: string; text: string | undefined }> = [];
  const notices: Array<{ message: string; type?: string }> = [];
  const completionCalls: CompletionCall[] = [];
  const findCalls: Array<{ provider: string; model: string }> = [];
  const authCalls: SummaryModel[] = [];
  const emittedEvents: string[] = [];
  let sessionName = options?.name;

  const registry = {
    find(provider: string, modelId: string) {
      findCalls.push({ provider, model: modelId });
      return (
        options?.findModel?.(provider, modelId) ??
        models.find((model) => model.provider === provider && model.id === modelId)
      );
    },
    async getApiKeyAndHeaders(foundModel: SummaryModel) {
      authCalls.push(foundModel);
      return (
        (await options?.auth?.(foundModel)) ?? {
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
      context: CompletionCall["context"],
      requestOptions: Record<string, unknown>,
    ) {
      const callIndex = completionCalls.length;
      completionCalls.push({ model: foundModel, context, options: requestOptions });
      return (
        (await options?.complete?.(foundModel, callIndex, context, requestOptions)) ??
        makeAssistantMessage(
          [{ type: "text", text: "Implement session titles" }],
          makeUsage(),
          "stop",
          foundModel.provider,
          foundModel.id,
        )
      );
    },
  };

  const context = {
    mode: "tui",
    hasUI: options?.hasUI ?? true,
    cwd: options?.cwd ?? "/tmp/session-summary-test",
    model: activeModel,
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
      getSessionId: () => options?.sessionId ?? "session-1",
      getBranch: () => entries,
      getEntries: () => entries,
      getSessionFile: () => options?.sessionFile ?? "/tmp/session-summary-test.jsonl",
      getSessionDir: () => "/tmp",
    },
    isIdle: () => true,
    isProjectTrusted: () => options?.trusted ?? true,
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
    registerCommand(name: string, value: { handler: Handler }) {
      commands.set(name, value.handler);
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
  const replacement = results.find((result): result is { message: AssistantMessage } =>
    Boolean(result && typeof result === "object" && "message" in result),
  )?.message;
  harness.entries.push(
    makeAssistantEntry(replacement ?? message, `assistant-${harness.entries.length}`),
  );
  return results;
}

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

beforeEach(() => {
  delete process.env.PI_SESSION_SUMMARY;
  process.env.PI_CODING_AGENT_DIR = join(tmpdir(), "pi-session-summary-tests-missing");
});

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  if (originalSummarySetting === undefined) delete process.env.PI_SESSION_SUMMARY;
  else process.env.PI_SESSION_SUMMARY = originalSummarySetting;
  if (originalAgentDirectory === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDirectory;
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("session summary configuration", () => {
  test("loads built-in defaults and applies global then trusted-project replacements", async () => {
    const root = await temporaryDirectory("pi-session-summary-config-");
    const project = join(root, "project");
    await mkdir(join(project, CONFIG_DIR_NAME), { recursive: true });
    await writeFile(
      join(root, "pi-session-summary.json"),
      JSON.stringify({
        profiles: {
          "openai-codex": ["global-codex"],
          anthropic: ["global-anthropic"],
        },
      }),
    );
    await writeFile(
      join(project, CONFIG_DIR_NAME, "pi-session-summary.json"),
      JSON.stringify({ profiles: { "openai-codex": [], anthropic: ["project-anthropic"] } }),
    );

    const untrusted = await loadSessionSummaryProfiles({
      cwd: project,
      trusted: false,
      env: { PI_CODING_AGENT_DIR: root },
    });
    expect(untrusted.get("github-copilot")).toEqual(["gpt-5.6-luna"]);
    expect(untrusted.get("openai-codex")).toEqual(["global-codex"]);
    expect(untrusted.get("anthropic")).toEqual(["global-anthropic"]);

    const trusted = await loadSessionSummaryProfiles({
      cwd: project,
      trusted: true,
      env: { PI_CODING_AGENT_DIR: root },
    });
    expect(trusted.get("openai-codex")).toEqual([]);
    expect(trusted.get("anthropic")).toEqual(["project-anthropic"]);
  });

  test("ignores missing, invalid, and malformed optional configuration", async () => {
    const root = await temporaryDirectory("pi-session-summary-invalid-");
    const project = join(root, "project");
    await mkdir(join(project, CONFIG_DIR_NAME), { recursive: true });
    await writeFile(join(root, "pi-session-summary.json"), "not json");
    await writeFile(
      join(project, CONFIG_DIR_NAME, "pi-session-summary.json"),
      JSON.stringify({ profiles: { "github-copilot": ["", 42], anthropic: "wrong" } }),
    );

    const profiles = await loadSessionSummaryProfiles({
      cwd: project,
      trusted: true,
      env: { PI_CODING_AGENT_DIR: root },
    });
    expect(profiles.get("github-copilot")).toEqual(["gpt-5.6-luna"]);
    expect(profiles.get("openai-codex")).toEqual(["gpt-5.3-codex-spark", "gpt-5.6-luna"]);
    expect(profiles.has("anthropic")).toBe(false);
  });
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

describe("provider-aware model selection and fallback", () => {
  test("uses the zero-configuration Copilot profile with compatible request options", async () => {
    const usage = makeUsage(7, 5);
    const harness = createHarness({
      complete: (model) =>
        makeAssistantMessage(
          [{ type: "text", text: "Title: Add persistent session titles" }],
          usage,
          "stop",
          model.provider,
          model.id,
        ),
    });
    await startSession(harness);

    const eventMessage = makeAssistantMessage(
      [{ type: "text", text: "Implemented the title flow" }],
      makeUsage(2, 1),
      "stop",
      "github-copilot",
      "gpt-5.6-luna",
      1234,
    );
    const results = await emitAssistant(harness, eventMessage);

    expect(harness.findCalls).toEqual([{ provider: "github-copilot", model: "gpt-5.6-luna" }]);
    expect(harness.completionCalls).toHaveLength(1);
    const call = harness.completionCalls[0]!;
    expect(call.options.maxTokens).toBe(800);
    expect(call.options.timeoutMs).toBeGreaterThan(0);
    expect(call.options.timeoutMs).toBeLessThanOrEqual(20_000);
    expect(call.options.cacheRetention).toBe("none");
    expect(call.options.sessionId).toEqual(expect.any(String));
    expect(Object.hasOwn(call.options, "reasoning")).toBe(false);
    expect(Object.hasOwn(call.options, "reasoningEffort")).toBe(false);
    expect(harness.getSessionName()).toBe("Add persistent session titles");
    expect(results[0]).toMatchObject({
      message: { usage: { input: 9, output: 6, totalTokens: 15 } },
    });
  });

  test("uses Spark first for Codex and does not call Luna after Spark succeeds", async () => {
    const spark = makeModel("openai-codex", "gpt-5.3-codex-spark");
    const luna = makeModel("openai-codex", "gpt-5.6-luna");
    const harness = createHarness({ activeModel: luna, models: [spark, luna] });
    await startSession(harness);
    await emitAssistant(
      harness,
      makeAssistantMessage(
        [{ type: "text", text: "Complete" }],
        makeUsage(),
        "stop",
        "openai-codex",
        luna.id,
      ),
    );

    expect(harness.findCalls).toEqual([{ provider: "openai-codex", model: "gpt-5.3-codex-spark" }]);
    expect(harness.completionCalls.map((call) => call.model.id)).toEqual(["gpt-5.3-codex-spark"]);
  });

  test.each(["missing model", "missing authentication"] as const)(
    "continues after %s failures",
    async (failure) => {
      const spark = makeModel("openai-codex", "gpt-5.3-codex-spark");
      const luna = makeModel("openai-codex", "gpt-5.6-luna");
      const harness = createHarness({
        activeModel: luna,
        models: failure === "missing model" ? [luna] : [spark, luna],
        auth: (model) =>
          failure === "missing authentication" && model.id === spark.id
            ? { ok: false, error: "unavailable" }
            : undefined,
      });
      await startSession(harness);
      await emitAssistant(
        harness,
        makeAssistantMessage(
          [{ type: "text", text: "Complete" }],
          makeUsage(),
          "stop",
          "openai-codex",
          luna.id,
        ),
      );

      expect(harness.getSessionName()).toBe("Implement session titles");
      expect(harness.completionCalls.map((call) => call.model.id)).toEqual([luna.id]);
      expect(harness.findCalls.map((call) => call.model)).toEqual([spark.id, luna.id]);
    },
  );

  test("falls back from Spark to Luna, persists all returned usage, and reports each model", async () => {
    const spark = makeModel("openai-codex", "gpt-5.3-codex-spark");
    const luna = makeModel("openai-codex", "gpt-5.6-luna");
    const sparkUsage = makeUsage(10, 2, 0.01);
    const lunaUsage = makeUsage(5, 1, 0.02);
    const harness = createHarness({
      activeModel: luna,
      models: [spark, luna],
      complete: (model) =>
        model.id === spark.id
          ? makeAssistantMessage(
              [{ type: "thinking", thinking: "no final text" }],
              sparkUsage,
              "length",
              model.provider,
              model.id,
            )
          : makeAssistantMessage(
              [{ type: "text", text: "Codex fallback title" }],
              lunaUsage,
              "stop",
              model.provider,
              model.id,
            ),
    });
    await startSession(harness);
    await emitAssistant(
      harness,
      makeAssistantMessage(
        [{ type: "text", text: "Complete" }],
        makeUsage(),
        "stop",
        "openai-codex",
        luna.id,
        2345,
      ),
    );

    expect(harness.completionCalls.map((call) => call.model.id)).toEqual([spark.id, luna.id]);
    expect(harness.completionCalls[0]?.options.sessionId).not.toBe(
      harness.completionCalls[1]?.options.sessionId,
    );
    const summary = harness.entries.find(
      (entry) => entry.type === "custom" && entry.customType === "session-summary",
    ) as Extract<SessionEntry, { type: "custom" }>;
    expect(summary.data).toMatchObject({
      name: "Codex fallback title",
      provider: "openai-codex",
      model: "gpt-5.6-luna",
      usage: { input: 15, output: 3, totalTokens: 18, cost: { total: 0.03 } },
      usageAttached: true,
      usageAttachment: {
        messageTimestamp: 2345,
        provider: "openai-codex",
        model: "gpt-5.6-luna",
      },
      attempts: [
        { model: spark.id, outcome: "empty-output", usage: sparkUsage },
        { model: luna.id, outcome: "success", usage: lunaUsage },
      ],
    });

    await harness.commands.get("session-summary-cost")?.("", harness.context);
    const report = harness.notices.at(-1)?.message ?? "";
    expect(report).toContain("Session Summary total | 18 tokens | cost: $0.0300");
    expect(report).toContain(`openai-codex/${spark.id} | 12 tokens`);
    expect(report).toContain(`openai-codex/${luna.id} | 6 tokens`);
  });

  test("pins the first successful fallback for later requests in the same provider session", async () => {
    const spark = makeModel("openai-codex", "gpt-5.3-codex-spark");
    const luna = makeModel("openai-codex", "gpt-5.6-luna");
    let sparkCalls = 0;
    const harness = createHarness({
      activeModel: luna,
      models: [spark, luna],
      complete: (model) => {
        if (model.id === spark.id) {
          sparkCalls += 1;
          throw new Error("Spark unavailable");
        }
        return makeAssistantMessage(
          [{ type: "text", text: `Luna title ${Date.now()}` }],
          makeUsage(),
          "stop",
          model.provider,
          model.id,
        );
      },
    });
    await startSession(harness);
    await emitAssistant(
      harness,
      makeAssistantMessage(
        [{ type: "text", text: "First turn" }],
        makeUsage(),
        "stop",
        "openai-codex",
        luna.id,
      ),
    );
    harness.entries.push(makeUserEntry("Continue", "user-2"));
    await emitAssistant(
      harness,
      makeAssistantMessage(
        [{ type: "text", text: "Second turn" }],
        makeUsage(),
        "stop",
        "openai-codex",
        luna.id,
      ),
    );

    expect(sparkCalls).toBe(1);
    expect(harness.completionCalls.map((call) => call.model.id)).toEqual([
      spark.id,
      luna.id,
      luna.id,
    ]);
  });

  test("uses an arbitrary provider's active model without cross-provider routing", async () => {
    const active = makeModel("anthropic", "claude-haiku-test", {
      api: "anthropic-messages",
    } as Partial<SummaryModel>);
    const copilot = makeModel();
    const harness = createHarness({ activeModel: active, models: [active, copilot] });
    await startSession(harness);
    await emitAssistant(
      harness,
      makeAssistantMessage(
        [{ type: "text", text: "Complete" }],
        makeUsage(),
        "stop",
        active.provider,
        active.id,
      ),
    );

    expect(harness.findCalls).toEqual([{ provider: "anthropic", model: active.id }]);
    expect(harness.completionCalls[0]?.model).toMatchObject({
      provider: "anthropic",
      id: active.id,
    });
  });

  test("rejects a registry result from another provider", async () => {
    const active = makeModel("anthropic", "cheap-title-model", {
      api: "anthropic-messages",
    } as Partial<SummaryModel>);
    const copilot = makeModel("github-copilot", "cheap-title-model");
    const harness = createHarness({
      activeModel: active,
      models: [active, copilot],
      findModel: () => copilot,
    });
    await startSession(harness);
    await emitAssistant(
      harness,
      makeAssistantMessage(
        [{ type: "text", text: "Complete" }],
        makeUsage(),
        "stop",
        active.provider,
        active.id,
      ),
    );

    expect(harness.completionCalls).toHaveLength(0);
    expect(harness.statuses.at(-1)?.text).toContain("resolved to another provider");
  });

  test("treats configured profiles and empty arrays as authoritative", async () => {
    const root = await temporaryDirectory("pi-session-summary-authoritative-");
    process.env.PI_CODING_AGENT_DIR = root;
    const configured = makeModel("openai-codex", "configured-cheap");
    const luna = makeModel("openai-codex", "gpt-5.6-luna");
    await writeFile(
      join(root, "pi-session-summary.json"),
      JSON.stringify({ profiles: { "openai-codex": [configured.id] } }),
    );
    const unauthenticated = createHarness({
      activeModel: luna,
      models: [configured, luna],
      auth: () => ({ ok: false, error: "no auth" }),
    });
    await startSession(unauthenticated);
    await emitAssistant(
      unauthenticated,
      makeAssistantMessage(
        [{ type: "text", text: "Complete" }],
        makeUsage(),
        "stop",
        luna.provider,
        luna.id,
      ),
    );
    expect(unauthenticated.findCalls).toEqual([{ provider: "openai-codex", model: configured.id }]);
    expect(unauthenticated.completionCalls).toHaveLength(0);
    expect(unauthenticated.statuses.at(-1)?.text).toContain("authentication is unavailable");

    await writeFile(
      join(root, "pi-session-summary.json"),
      JSON.stringify({ profiles: { "openai-codex": [] } }),
    );
    const disabled = createHarness({ activeModel: luna, models: [luna] });
    await startSession(disabled);
    await emitAssistant(
      disabled,
      makeAssistantMessage(
        [{ type: "text", text: "Complete" }],
        makeUsage(),
        "stop",
        luna.provider,
        luna.id,
      ),
    );
    expect(disabled.findCalls).toHaveLength(0);
    expect(disabled.statuses.at(-1)?.text).toContain(
      "Session summaries are disabled for openai-codex",
    );
  });
});

describe("request deadline and transcript bounds", () => {
  test("shares one 20-second deadline across fallback candidates", async () => {
    vi.useFakeTimers();
    const spark = makeModel("openai-codex", "gpt-5.3-codex-spark");
    const luna = makeModel("openai-codex", "gpt-5.6-luna");
    const harness = createHarness({
      activeModel: luna,
      models: [spark, luna],
      complete: (model) =>
        model.id === spark.id
          ? new Promise<AssistantMessage>((_resolve, reject) =>
              setTimeout(() => reject(new Error("Spark failed")), 12_000),
            )
          : new Promise<AssistantMessage>(() => {}),
    });
    await startSession(harness);
    const pending = emitAssistant(
      harness,
      makeAssistantMessage(
        [{ type: "text", text: "Complete" }],
        makeUsage(),
        "stop",
        "openai-codex",
        luna.id,
      ),
    );

    await vi.advanceTimersByTimeAsync(12_000);
    expect(harness.completionCalls).toHaveLength(2);
    expect(harness.completionCalls[1]?.options.timeoutMs).toBeLessThanOrEqual(8_000);
    await vi.advanceTimersByTimeAsync(8_000);
    await pending;
    expect(harness.statuses.at(-1)?.text).toContain("shared deadline");
  });

  test("caps output and trims the transcript for the selected model context", async () => {
    const active = makeModel("local-provider", "small-context", {
      contextWindow: 1_000,
      maxTokens: 100,
    });
    const harness = createHarness({
      activeModel: active,
      branch: [makeUserEntry("x".repeat(20_000))],
    });
    await startSession(harness);
    await emitAssistant(
      harness,
      makeAssistantMessage(
        [{ type: "text", text: "Complete" }],
        makeUsage(),
        "stop",
        active.provider,
        active.id,
      ),
    );

    const call = harness.completionCalls[0]!;
    const prompt = call.context.messages[0]?.content[0]?.text ?? "";
    expect(call.options.maxTokens).toBe(100);
    expect((call.context.systemPrompt?.length ?? 0) + prompt.length + 256).toBeLessThanOrEqual(
      (active.contextWindow - 100) * 4,
    );
    expect(prompt.length).toBeLessThan(20_000);
  });
});

describe("persistence and command flows", () => {
  test("persists failed returned usage even when no model produces a title", async () => {
    const usage = makeUsage(8, 2);
    const harness = createHarness({
      complete: (model) =>
        makeAssistantMessage(
          [{ type: "thinking", thinking: "reasoning only" }],
          usage,
          "length",
          model.provider,
          model.id,
        ),
    });
    await startSession(harness);
    const results = await emitAssistant(
      harness,
      makeAssistantMessage([{ type: "text", text: "The turn is complete" }]),
    );

    expect(harness.getSessionName()).toBeUndefined();
    const summary = harness.entries.find(
      (entry) => entry.type === "custom" && entry.customType === "session-summary",
    ) as Extract<SessionEntry, { type: "custom" }>;
    expect(summary.data).toMatchObject({
      messageCount: 2,
      usage,
      usageAttached: true,
      attempts: [{ outcome: "empty-output", usage }],
    });
    expect(results[0]).toMatchObject({ message: { usage: { input: 11, output: 6 } } });
    expect(harness.statuses.at(-1)?.text).toContain("returned no final text");
  });

  test("manual summaries keep usage unattached", async () => {
    const responseUsage = makeUsage(5, 6);
    const harness = createHarness({
      branch: [
        makeUserEntry(),
        makeAssistantEntry(makeAssistantMessage([{ type: "text", text: "Existing reply" }])),
      ],
      complete: (model) =>
        makeAssistantMessage(
          [{ type: "text", text: "Manual title" }],
          responseUsage,
          "stop",
          model.provider,
          model.id,
        ),
    });
    await startSession(harness);
    await harness.commands.get("session-summary")?.("", harness.context);

    const summary = harness.entries.find(
      (entry) => entry.type === "custom" && entry.customType === "session-summary",
    ) as Extract<SessionEntry, { type: "custom" }>;
    expect(summary.data).toMatchObject({
      name: "Manual title",
      usage: responseUsage,
      usageAttached: false,
    });
    expect(summary.data).not.toHaveProperty("usageAttachment");
  });

  test("backfills titles with the active provider and stores unattached usage", async () => {
    const oldBranch = [
      makeUserEntry("Old task"),
      makeAssistantEntry(makeAssistantMessage([{ type: "text", text: "Old reply" }])),
    ];
    const appendSessionInfo = vi.fn();
    const appendCustomEntry = vi.fn();
    vi.spyOn(SessionManager, "list").mockResolvedValue([
      { path: "/tmp/old-session.jsonl", name: undefined } as never,
    ]);
    vi.spyOn(SessionManager, "open").mockReturnValue({
      getBranch: () => oldBranch,
      appendSessionInfo,
      appendCustomEntry,
    } as never);
    const harness = createHarness();
    await startSession(harness);
    await harness.commands.get("session-summaries")?.("", harness.context);

    expect(appendSessionInfo).toHaveBeenCalledWith("Implement session titles");
    expect(appendCustomEntry).toHaveBeenCalledWith(
      "session-summary",
      expect.objectContaining({
        name: "Implement session titles",
        provider: "github-copilot",
        model: "gpt-5.6-luna",
        usageAttached: false,
      }),
    );
  });

  test("respects manual names and PI_SESSION_SUMMARY=off", async () => {
    const manual = createHarness({
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
    await startSession(manual);
    await emitAssistant(
      manual,
      makeAssistantMessage([{ type: "text", text: "Do not replace this name" }]),
    );
    expect(manual.completionCalls).toHaveLength(0);
    expect(manual.getSessionName()).toBe("Manual session name");

    process.env.PI_SESSION_SUMMARY = "off";
    const disabled = createHarness();
    await startSession(disabled);
    await emitAssistant(
      disabled,
      makeAssistantMessage([{ type: "text", text: "Do not summarize" }]),
    );
    await disabled.commands.get("session-summary")?.("", disabled.context);
    await disabled.commands.get("session-summaries")?.("", disabled.context);
    expect(disabled.completionCalls).toHaveLength(0);
    expect(disabled.getSessionName()).toBeUndefined();
  });

  test("reads legacy summary entries for cost output", async () => {
    const legacyUsage = makeUsage(9, 1, 0.04);
    const harness = createHarness({
      branch: [
        makeUserEntry(),
        makeSummaryEntry({
          name: "Legacy title",
          messageCount: 1,
          usage: legacyUsage,
          usageAttached: false,
        }),
      ],
      name: "Legacy title",
    });
    await startSession(harness);
    await harness.commands.get("session-summary-cost")?.("", harness.context);

    const report = harness.notices.at(-1)?.message ?? "";
    expect(report).toContain("Session Summary total | 10 tokens | cost: $0.0400");
    expect(report).toContain("github-copilot/gpt-5.6-luna | 10 tokens");
  });
});
