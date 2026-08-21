import { readFileSync } from "node:fs";
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

function makeAttemptEntry(id = "attempt-1"): SessionEntry {
  return {
    type: "custom",
    customType: "session-summary-auto-attempt",
    id,
    parentId: null,
    timestamp: new Date().toISOString(),
    data: { version: 1, messageCount: 2 },
  } as SessionEntry;
}

function createHarness(options?: {
  branch?: SessionEntry[];
  allEntries?: SessionEntry[];
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
  appendEntry?: (customType: string, data: unknown) => void;
  sessionManager?: SessionManager;
  name?: string;
  mode?: ExtensionContext["mode"];
  hasUI?: boolean;
  cwd?: string;
  trusted?: boolean;
  sessionId?: string;
  sessionFile?: string;
}) {
  const activeModel = options?.activeModel ?? makeModel();
  const models = options?.models ?? [activeModel];
  const realSessionManager = options?.sessionManager;
  const entries = [...(realSessionManager?.getBranch() ?? options?.branch ?? [makeUserEntry()])];
  const allEntries = options?.allEntries ? [...options.allEntries] : entries;
  const events = new Map<string, Handler[]>();
  const commands = new Map<string, Handler>();
  const statuses: Array<{ key: string; text: string | undefined }> = [];
  const notices: Array<{ message: string; type?: string }> = [];
  const completionCalls: CompletionCall[] = [];
  const findCalls: Array<{ provider: string; model: string }> = [];
  const authCalls: SummaryModel[] = [];
  const emittedEvents: string[] = [];
  let sessionName = options?.name ?? realSessionManager?.getSessionName();
  let currentSessionId = options?.sessionId ?? realSessionManager?.getSessionId() ?? "session-1";

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
    mode: options?.mode ?? "tui",
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
      getSessionId: () => realSessionManager?.getSessionId() ?? currentSessionId,
      getBranch: () => realSessionManager?.getBranch() ?? entries,
      getEntries: () => realSessionManager?.getEntries() ?? allEntries,
      getSessionFile: () =>
        realSessionManager?.getSessionFile() ??
        options?.sessionFile ??
        "/tmp/session-summary-test.jsonl",
      getSessionDir: () => realSessionManager?.getSessionDir() ?? "/tmp",
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
      if (realSessionManager) {
        realSessionManager.appendSessionInfo(name);
        return;
      }
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
      options?.appendEntry?.(customType, data);
      if (realSessionManager) {
        realSessionManager.appendCustomEntry(customType, data);
        return;
      }
      const entry = {
        type: "custom",
        customType,
        id: `custom-${entries.length}`,
        parentId: entries.at(-1)?.id ?? null,
        timestamp: new Date().toISOString(),
        data,
      } as SessionEntry;
      entries.push(entry);
      if (allEntries !== entries) allEntries.push(entry);
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
    allEntries,
    realSessionManager,
    events,
    commands,
    statuses,
    notices,
    completionCalls,
    findCalls,
    authCalls,
    emittedEvents,
    getSessionName: () => sessionName,
    setSessionId: (value: string) => {
      currentSessionId = value;
    },
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
  const messageResults = await emit(harness, "message_end", { message });
  const replacement = messageResults.find((result): result is { message: AssistantMessage } =>
    Boolean(result && typeof result === "object" && "message" in result),
  )?.message;
  const finalMessage = replacement ?? message;
  if (harness.realSessionManager) harness.realSessionManager.appendMessage(finalMessage);
  else {
    harness.entries.push(makeAssistantEntry(finalMessage, `assistant-${harness.entries.length}`));
  }
  const endResults = await emit(harness, "agent_end", {
    type: "agent_end",
    messages: [finalMessage],
  });
  return [...messageResults, ...endResults];
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
    await emitAssistant(harness, eventMessage);

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
    const summary = harness.entries.find(
      (entry) => entry.type === "custom" && entry.customType === "session-summary",
    ) as Extract<SessionEntry, { type: "custom" }>;
    expect(summary.data).toMatchObject({ usage, usageAttached: false });
    expect(summary.data).not.toHaveProperty("usageAttachment");
    expect(harness.notices).toEqual([]);
    expect(harness.statuses).toEqual([]);
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
      usageAttached: false,
      attempts: [
        { model: spark.id, outcome: "empty-output", usage: sparkUsage },
        { model: luna.id, outcome: "success", usage: lunaUsage },
      ],
    });
    expect(summary.data).not.toHaveProperty("usageAttachment");
    expect(harness.notices).toEqual([]);
    expect(harness.statuses).toEqual([]);

    await harness.commands.get("session-summary-cost")?.("", harness.context);
    const report = harness.notices.at(-1)?.message ?? "";
    expect(report).toContain("Session Summary total | 18 tokens | cost: $0.0300");
    expect(report).toContain(`openai-codex/${spark.id} | 12 tokens`);
    expect(report).toContain(`openai-codex/${luna.id} | 6 tokens`);
  });

  test("pins the first successful fallback for explicit refreshes in the same provider session", async () => {
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
    await harness.commands.get("session-summary")?.("", harness.context);

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
    expect(harness.notices.at(-1)).toMatchObject({
      message: expect.stringContaining("resolved to another provider"),
      type: "warning",
    });
    expect(harness.statuses).toEqual([]);
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
    expect(unauthenticated.notices.at(-1)).toMatchObject({
      message: expect.stringContaining("authentication is unavailable"),
      type: "warning",
    });
    expect(unauthenticated.statuses).toEqual([]);

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
    expect(disabled.notices.at(-1)).toMatchObject({
      message: expect.stringContaining("Session summaries are disabled for openai-codex"),
      type: "warning",
    });
    expect(disabled.statuses).toEqual([]);
  });
});

describe("one-shot automatic cadence", () => {
  test("persists the attempt marker before model lookup", async () => {
    const directory = await temporaryDirectory("pi-session-summary-persist-");
    const manager = SessionManager.create("/project", directory);
    const user = makeUserEntry();
    if (user.type !== "message" || user.message.role !== "user") {
      throw new Error("Expected a user message entry");
    }
    const assistant = makeAssistantMessage([{ type: "text", text: "First completed turn" }]);
    manager.appendMessage(user.message);
    manager.appendMessage(assistant);
    const sessionFile = manager.getSessionFile();
    if (!sessionFile) throw new Error("Expected a persisted session file");

    let markerFoundOnDisk = false;
    const harness = createHarness({
      cwd: "/project",
      sessionManager: manager,
      findModel: () => {
        markerFoundOnDisk = readFileSync(sessionFile, "utf8").includes(
          '"customType":"session-summary-auto-attempt"',
        );
        return undefined;
      },
    });
    await startSession(harness);
    await emit(harness, "agent_end", { type: "agent_end", messages: [assistant] });

    expect(markerFoundOnDisk).toBe(true);
    expect(harness.completionCalls).toHaveLength(1);
  });

  test("writes the attempt marker before the request and runs only once", async () => {
    let markerSeenByLookup = false;
    let markerSeenByProvider = false;
    let harness!: Harness;
    harness = createHarness({
      findModel: () => {
        markerSeenByLookup = harness.entries.some(
          (entry) => entry.type === "custom" && entry.customType === "session-summary-auto-attempt",
        );
        return undefined;
      },
      complete: (model) => {
        markerSeenByProvider = harness.entries.some(
          (entry) => entry.type === "custom" && entry.customType === "session-summary-auto-attempt",
        );
        return makeAssistantMessage(
          [{ type: "text", text: "One-shot session title" }],
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
      makeAssistantMessage([{ type: "text", text: "First completed turn" }]),
    );
    harness.entries.push(makeUserEntry("Add another change", "user-2"));
    await emitAssistant(
      harness,
      makeAssistantMessage([{ type: "text", text: "Second completed turn" }]),
    );

    expect(markerSeenByLookup).toBe(true);
    expect(markerSeenByProvider).toBe(true);
    expect(harness.completionCalls).toHaveLength(1);
    expect(
      harness.entries.filter(
        (entry) => entry.type === "custom" && entry.customType === "session-summary-auto-attempt",
      ),
    ).toHaveLength(1);
    expect(harness.notices).toEqual([]);
    expect(harness.statuses).toEqual([]);
  });

  test("does not retry a failed automatic attempt later or after reload", async () => {
    const complete = (model: SummaryModel) =>
      makeAssistantMessage(
        [{ type: "thinking", thinking: "No final title" }],
        makeUsage(),
        "length",
        model.provider,
        model.id,
      );
    const harness = createHarness({ complete });
    await startSession(harness);
    await emitAssistant(harness, makeAssistantMessage([{ type: "text", text: "Done" }]));

    harness.entries.push(makeUserEntry("Try another turn", "user-2"));
    await emitAssistant(harness, makeAssistantMessage([{ type: "text", text: "Done again" }]));

    expect(harness.completionCalls).toHaveLength(1);
    expect(harness.notices).toHaveLength(1);

    const reloaded = createHarness({ branch: harness.entries, complete });
    await startSession(reloaded);
    reloaded.entries.push(makeUserEntry("Try after reload", "user-3"));
    await emitAssistant(reloaded, makeAssistantMessage([{ type: "text", text: "Still done" }]));

    expect(reloaded.completionCalls).toHaveLength(0);
    expect(reloaded.notices).toEqual([]);
    expect(reloaded.statuses).toEqual([]);
  });

  test("uses all session entries so tree navigation cannot re-enable automation", async () => {
    const branchUser = makeUserEntry();
    const harness = createHarness({
      branch: [branchUser],
      allEntries: [branchUser, makeAttemptEntry()],
    });
    await startSession(harness);
    await emitAssistant(harness, makeAssistantMessage([{ type: "text", text: "Complete" }]));

    expect(harness.completionCalls).toHaveLength(0);
    expect(harness.notices).toEqual([]);
    expect(harness.statuses).toEqual([]);
  });

  test.each([
    { label: "successful", data: { name: "Old title", messageCount: 2 } },
    {
      label: "failed",
      data: {
        messageCount: 2,
        attempts: [{ provider: "github-copilot", model: "old", outcome: "request-failed" }],
      },
    },
    { label: "minimal", data: {} },
  ])("treats $label legacy summary entries as prior attempts", async ({ data }) => {
    const harness = createHarness({ branch: [makeUserEntry(), makeSummaryEntry(data)] });
    await startSession(harness);
    await emitAssistant(harness, makeAssistantMessage([{ type: "text", text: "Complete" }]));

    expect(harness.completionCalls).toHaveLength(0);
    expect(harness.notices).toEqual([]);
  });

  test("does not call a provider when the write-ahead marker cannot be saved", async () => {
    const harness = createHarness({
      appendEntry(customType) {
        if (customType === "session-summary-auto-attempt") throw new Error("disk full");
      },
    });
    await startSession(harness);
    await emitAssistant(harness, makeAssistantMessage([{ type: "text", text: "Complete" }]));
    harness.entries.push(makeUserEntry("Try again", "user-2"));
    await emitAssistant(harness, makeAssistantMessage([{ type: "text", text: "Complete" }]));

    expect(harness.completionCalls).toHaveLength(0);
    expect(harness.notices).toEqual([
      {
        message: "Session title unavailable: The automatic title attempt could not be recorded",
        type: "warning",
      },
    ]);
    expect(harness.statuses).toEqual([]);
  });

  test("defers a greeting and summarizes the later meaningful turn", async () => {
    const harness = createHarness({ branch: [makeUserEntry("hello")] });
    await startSession(harness);
    await emitAssistant(
      harness,
      makeAssistantMessage([{ type: "text", text: "EARLY_GREETING_REPLY" }]),
    );

    expect(harness.completionCalls).toHaveLength(0);
    expect(
      harness.entries.some(
        (entry) => entry.type === "custom" && entry.customType === "session-summary-auto-attempt",
      ),
    ).toBe(false);

    harness.entries.push(makeUserEntry("Fix the parser", "user-2"));
    await emitAssistant(harness, makeAssistantMessage([{ type: "text", text: "Parser fixed" }]));

    expect(harness.completionCalls).toHaveLength(1);
    const prompt = harness.completionCalls[0]?.context.messages[0]?.content[0]?.text ?? "";
    expect(prompt).toContain("Fix the parser");
    expect(prompt).not.toContain("EARLY_GREETING_REPLY");
  });

  test.each(["hello, fix the parser", "go"])("treats %j as meaningful input", async (input) => {
    const harness = createHarness({ branch: [makeUserEntry(input)] });
    await startSession(harness);
    await emitAssistant(harness, makeAssistantMessage([{ type: "text", text: "Complete" }]));

    expect(harness.completionCalls).toHaveLength(1);
  });

  test("treats an image-only request as meaningful input", async () => {
    const imageUser = {
      type: "message",
      id: "user-image",
      parentId: null,
      timestamp: new Date(0).toISOString(),
      message: {
        role: "user",
        content: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }],
        timestamp: 0,
      },
    } as SessionEntry;
    const harness = createHarness({ branch: [imageUser] });
    await startSession(harness);
    await emitAssistant(harness, makeAssistantMessage([{ type: "text", text: "Image reviewed" }]));

    expect(harness.completionCalls).toHaveLength(1);
  });

  test("does not consume the attempt on incomplete or tool-call assistant messages", async () => {
    const harness = createHarness();
    await startSession(harness);
    await emitAssistant(
      harness,
      makeAssistantMessage([{ type: "text", text: "Cut short" }], makeUsage(), "length"),
    );
    await emitAssistant(
      harness,
      makeAssistantMessage([
        {
          type: "toolCall",
          id: "tool-1",
          name: "read",
          arguments: { path: "README.md" },
        },
      ]),
    );

    expect(harness.completionCalls).toHaveLength(0);
    expect(
      harness.entries.some(
        (entry) => entry.type === "custom" && entry.customType === "session-summary-auto-attempt",
      ),
    ).toBe(false);

    harness.entries.push(makeUserEntry("Finish without tools", "user-2"));
    await emitAssistant(harness, makeAssistantMessage([{ type: "text", text: "Finished" }]));
    expect(harness.completionCalls).toHaveLength(1);
  });

  test("does not run automatically outside the interactive TUI", async () => {
    const harness = createHarness({ mode: "rpc" });
    await startSession(harness);
    await emitAssistant(harness, makeAssistantMessage([{ type: "text", text: "Complete" }]));

    expect(harness.completionCalls).toHaveLength(0);
    expect(harness.entries.some((entry) => entry.type === "custom")).toBe(false);
  });

  test("ignores a completion from a replaced session without pinning its fallback", async () => {
    const spark = makeModel("openai-codex", "gpt-5.3-codex-spark");
    const luna = makeModel("openai-codex", "gpt-5.6-luna");
    let phase: "old" | "new" = "old";
    let resolveOld!: (message: AssistantMessage) => void;
    const oldCompletion = new Promise<AssistantMessage>((resolve) => {
      resolveOld = resolve;
    });
    const harness = createHarness({
      activeModel: luna,
      models: [spark, luna],
      complete: (model) => {
        if (phase === "old") {
          if (model.id === spark.id) throw new Error("Spark unavailable");
          return oldCompletion;
        }
        return makeAssistantMessage(
          [{ type: "text", text: "New session title" }],
          makeUsage(),
          "stop",
          model.provider,
          model.id,
        );
      },
    });
    await startSession(harness);
    const oldMessage = makeAssistantMessage([{ type: "text", text: "Old completion" }]);
    harness.entries.push(makeAssistantEntry(oldMessage, "assistant-old"));
    const pending = emit(harness, "agent_end", {
      type: "agent_end",
      messages: [oldMessage],
    });
    await vi.waitFor(() => expect(harness.completionCalls).toHaveLength(2));

    const oldRequestSignal = harness.completionCalls[1]?.options.signal as AbortSignal | undefined;
    await emit(harness, "session_shutdown", { type: "session_shutdown" });
    expect(oldRequestSignal?.aborted).toBe(true);
    harness.setSessionId("session-2");
    await startSession(harness);
    phase = "new";
    resolveOld(
      makeAssistantMessage(
        [{ type: "text", text: "Stale title" }],
        makeUsage(),
        "stop",
        luna.provider,
        luna.id,
      ),
    );
    await pending;

    expect(harness.getSessionName()).toBeUndefined();
    expect(
      harness.entries.filter(
        (entry) => entry.type === "custom" && entry.customType === "session-summary",
      ),
    ).toHaveLength(0);

    await harness.commands.get("session-summary")?.("", harness.context);
    expect(harness.completionCalls.map((call) => call.model.id)).toEqual([
      spark.id,
      luna.id,
      spark.id,
    ]);
    expect(harness.getSessionName()).toBe("New session title");
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
    expect(harness.notices.at(-1)).toMatchObject({
      message: expect.stringContaining("shared deadline"),
      type: "warning",
    });
    expect(harness.statuses).toEqual([]);
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
    await emitAssistant(
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
      usageAttached: false,
      attempts: [{ outcome: "empty-output", usage }],
    });
    expect(summary.data).not.toHaveProperty("usageAttachment");
    expect(harness.notices.at(-1)).toMatchObject({
      message: expect.stringContaining("returned no final text"),
      type: "warning",
    });
    expect(harness.statuses).toEqual([]);
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

  test("manual refreshes bypass automatic markers and stay silent on success", async () => {
    const harness = createHarness({
      branch: [
        makeUserEntry(),
        makeAssistantEntry(makeAssistantMessage([{ type: "text", text: "Existing reply" }])),
        makeAttemptEntry(),
      ],
    });
    await startSession(harness);

    await harness.commands.get("session-summary")?.("", harness.context);
    await harness.commands.get("session-summary")?.("", harness.context);

    expect(harness.completionCalls).toHaveLength(2);
    expect(harness.getSessionName()).toBe("Implement session titles");
    expect(harness.notices).toEqual([]);
    expect(harness.statuses).toEqual([]);
  });

  test("warns for each genuine manual failure", async () => {
    const harness = createHarness({
      branch: [
        makeUserEntry(),
        makeAssistantEntry(makeAssistantMessage([{ type: "text", text: "Existing reply" }])),
        makeAttemptEntry(),
      ],
      complete: (model) =>
        makeAssistantMessage(
          [{ type: "thinking", thinking: "No title" }],
          makeUsage(),
          "length",
          model.provider,
          model.id,
        ),
    });
    await startSession(harness);

    await harness.commands.get("session-summary")?.("", harness.context);
    await harness.commands.get("session-summary")?.("", harness.context);

    expect(harness.completionCalls).toHaveLength(2);
    expect(harness.notices).toHaveLength(2);
    expect(harness.notices.every((notice) => notice.type === "warning")).toBe(true);
    expect(harness.statuses).toEqual([]);
  });

  test("does not overwrite a manual name set while automatic generation is pending", async () => {
    let harness!: Harness;
    harness = createHarness({
      complete: (model) => {
        harness.api.setSessionName("Manual title wins");
        return makeAssistantMessage(
          [{ type: "text", text: "Generated title loses" }],
          makeUsage(),
          "stop",
          model.provider,
          model.id,
        );
      },
    });
    await startSession(harness);
    await emitAssistant(harness, makeAssistantMessage([{ type: "text", text: "Complete" }]));

    expect(harness.getSessionName()).toBe("Manual title wins");
    const summary = harness.entries.find(
      (entry) => entry.type === "custom" && entry.customType === "session-summary",
    ) as Extract<SessionEntry, { type: "custom" }>;
    expect(summary.data).toMatchObject({ source: "automatic", usageAttached: false });
    expect(summary.data).not.toHaveProperty("name");
    expect(harness.notices).toEqual([]);
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
        source: "backfill",
        usageAttached: false,
      }),
    );
    expect(harness.notices).toEqual([]);
    expect(harness.statuses).toEqual([]);
  });

  test("keeps an empty backfill silent", async () => {
    vi.spyOn(SessionManager, "list").mockResolvedValue([]);
    const harness = createHarness();
    await startSession(harness);
    await harness.commands.get("session-summaries")?.("", harness.context);

    expect(harness.completionCalls).toHaveLength(0);
    expect(harness.notices).toEqual([]);
    expect(harness.statuses).toEqual([]);
  });

  test("reports mixed backfill failures once with a bounded warning", async () => {
    const branches = new Map<string, SessionEntry[]>([
      [
        "/tmp/good-session.jsonl",
        [
          makeUserEntry("Good task"),
          makeAssistantEntry(makeAssistantMessage([{ type: "text", text: "Good reply" }])),
        ],
      ],
      [
        "/tmp/no-title-session.jsonl",
        [
          makeUserEntry("Hard task"),
          makeAssistantEntry(makeAssistantMessage([{ type: "text", text: "Hard reply" }])),
        ],
      ],
    ]);
    vi.spyOn(SessionManager, "list").mockResolvedValue([
      { path: "/tmp/good-session.jsonl", name: undefined } as never,
      { path: "/tmp/no-title-session.jsonl", name: undefined } as never,
      { path: "/tmp/broken-session.jsonl", name: undefined } as never,
    ]);
    vi.spyOn(SessionManager, "open").mockImplementation((path) => {
      if (path === "/tmp/broken-session.jsonl") throw new Error("Unreadable session");
      return {
        getBranch: () => branches.get(path) ?? [],
        appendSessionInfo: vi.fn(),
        appendCustomEntry: vi.fn(),
      } as never;
    });
    const harness = createHarness({
      complete: (model, callIndex) =>
        callIndex === 0
          ? makeAssistantMessage(
              [{ type: "text", text: "Good title" }],
              makeUsage(),
              "stop",
              model.provider,
              model.id,
            )
          : makeAssistantMessage(
              [{ type: "thinking", thinking: "No title" }],
              makeUsage(),
              "length",
              model.provider,
              model.id,
            ),
    });
    await startSession(harness);
    await harness.commands.get("session-summaries")?.("", harness.context);

    expect(harness.completionCalls).toHaveLength(2);
    expect(harness.notices).toHaveLength(1);
    expect(harness.notices[0]).toMatchObject({
      message: expect.stringContaining("Could not complete title backfill for 2 of 3 sessions"),
      type: "warning",
    });
    expect(harness.notices[0]?.message.length).toBeLessThanOrEqual(600);
    expect(harness.statuses).toEqual([]);
  });

  test("counts a backfill persistence failure once and retains its in-memory usage", async () => {
    const usage = makeUsage(12, 3, 0.07);
    const branch = [
      makeUserEntry("Old task"),
      makeAssistantEntry(makeAssistantMessage([{ type: "text", text: "Old reply" }])),
    ];
    const appendSessionInfo = vi.fn();
    vi.spyOn(SessionManager, "list").mockResolvedValue([
      { path: "/tmp/write-failure.jsonl", name: undefined } as never,
    ]);
    vi.spyOn(SessionManager, "open").mockReturnValue({
      getBranch: () => branch,
      appendSessionInfo,
      appendCustomEntry: () => {
        throw new Error("Disk full");
      },
    } as never);
    const harness = createHarness({
      complete: (model) =>
        makeAssistantMessage(
          [{ type: "text", text: "Saved title" }],
          usage,
          "stop",
          model.provider,
          model.id,
        ),
    });
    await startSession(harness);
    await harness.commands.get("session-summaries")?.("", harness.context);

    expect(appendSessionInfo).toHaveBeenCalledWith("Saved title");
    expect(harness.notices).toHaveLength(1);
    expect(harness.notices[0]).toMatchObject({
      message: expect.stringContaining("title backfill for 1 of 1 sessions"),
      type: "warning",
    });
    expect(harness.notices[0]?.message).not.toContain("2 of 1");

    await harness.commands.get("session-summary-cost")?.("", harness.context);
    expect(harness.notices.at(-1)?.message).toContain(
      "Session Summary total | 15 tokens | cost: $0.0700",
    );
  });

  test("warns once when sessions cannot be listed for backfill", async () => {
    vi.spyOn(SessionManager, "list").mockRejectedValue(new Error("Index unavailable"));
    const harness = createHarness();
    await startSession(harness);
    await harness.commands.get("session-summaries")?.("", harness.context);

    expect(harness.notices).toEqual([
      { message: "Could not list sessions for title backfill", type: "warning" },
    ]);
    expect(harness.statuses).toEqual([]);
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
