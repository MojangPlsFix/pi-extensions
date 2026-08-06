import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import searchExtension, {
  backendForProvider,
  boundedCopilotOutput,
  buildCodexHeaders,
  buildCodexSearchRequest,
  buildCopilotArguments,
  copilotSearchTimeoutMs,
  copilotSpawnOptions,
  DEFAULT_COPILOT_SEARCH_EFFORT,
  DEFAULT_COPILOT_SEARCH_MODEL,
  DEFAULT_COPILOT_SEARCH_TIMEOUT_MS,
  extractCodexAccountId,
  normalizeCodexResponse,
  normalizeSearchParams,
  promptFor,
  redactSensitiveText,
  renderSearchCall,
  renderSearchResult,
  runCodexSearch,
  runCopilotSearch,
  type SearchDetails,
  type SearchParams,
  sourcesFromText,
} from "../index.js";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

async function fakeCopilot(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "pi-web-search-"));
  temporaryDirectories.push(directory);
  const executable = join(directory, "copilot");
  await writeFile(
    executable,
    `#!${process.execPath}\nconst args = process.argv.slice(2);\nif (args.includes('--version')) process.exit(97);\nconst prompt = args[args.indexOf('-p') + 1] || '';\nconst request = prompt.split('Request:\\n').at(-1) || '';\nconst emitAnswer = () => console.log(JSON.stringify({type:'assistant.message',data:{content: request.includes('large') ? 'x'.repeat(13000) : 'done https://example.com/docs'}}));\nif (request.includes('web-fail')) {\n  console.log(JSON.stringify({type:'tool.execution_start',data:{toolCallId:'web-1',mcpToolName:'github-mcp-server/web_search'}}));\n  console.log(JSON.stringify({type:'tool.execution_complete',data:{toolCallId:'web-1',result:{isError:true}}}));\n  emitAnswer();\n} else if (request.includes('fail')) { console.error('Bearer should-not-leak'); process.exit(2); }\nelse if (request.includes('progress-wait')) {\n  let ticks = 0;\n  const interval = setInterval(() => {\n    console.log(JSON.stringify({type:'assistant.message',data:{content:'progress'}}));\n    if (++ticks === 4) { clearInterval(interval); emitAnswer(); }\n  }, 50);\n} else if (request.includes('wait')) setTimeout(() => emitAnswer(), 5000);\nelse {\n  const web = prompt.includes('github-mcp-server/web_search') && !request.includes('skip-web');\n  if (web) {\n    console.log(JSON.stringify({type:'assistant.turn_start',data:{}}));\n    console.log(JSON.stringify({type:'tool.execution_start',data:{toolCallId:'web-1',mcpToolName:'github-mcp-server/web_search'}}));\n    console.log(JSON.stringify({type:'tool.execution_complete',data:{toolCallId:'web-1',success:true}}));\n  }\n  emitAnswer();\n}\n`,
  );
  await chmod(executable, 0o755);
  return executable;
}

function token(accountId = "account-123", marker = "credential-marker"): string {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode({
    "https://api.openai.com/auth": { chatgpt_account_id: accountId },
    marker,
  })}.signature-value`;
}

function theme(): Theme {
  return {
    fg: (_color: string, value: string) => value,
    bg: (_color: string, value: string) => value,
    bold: (value: string) => value,
    italic: (value: string) => value,
    strikethrough: (value: string) => value,
  } as Theme;
}

function details(overrides: Partial<SearchDetails> = {}): SearchDetails {
  return {
    backend: "codex-native",
    kind: "web",
    model: "gpt-5.4",
    queryCount: 1,
    resultCount: 2,
    sourceCount: 2,
    truncated: false,
    outputTruncated: false,
    sourcesTruncated: false,
    providerAccounted: true,
    usageStatus: "provider-accounted",
    costIncludedInPi: false,
    sourceUrls: ["https://example.com/a", "https://example.com/b"],
    preview: "Retrieved evidence preview.",
    ...overrides,
  };
}

type RegisteredTool = {
  name: string;
  prepareArguments: (args: unknown) => unknown;
  execute: (
    id: string,
    params: SearchParams,
    signal: AbortSignal | undefined,
    onUpdate: ((result: unknown) => void) | undefined,
    context: unknown,
  ) => Promise<{ content: Array<{ type: string; text: string }>; details: SearchDetails }>;
};

function registeredSearchTool(): RegisteredTool {
  const tools: RegisteredTool[] = [];
  searchExtension({ registerTool: (tool: RegisteredTool) => tools.push(tool) } as never);
  expect(tools.map((tool) => tool.name)).toEqual(["search"]);
  return tools[0] as RegisteredTool;
}

describe("unified search interface", () => {
  it("registers exactly one search tool and normalizes string and object arguments", () => {
    const tool = registeredSearchTool();
    expect(tool.prepareArguments("release notes")).toEqual({ query: "release notes" });
    expect(tool.prepareArguments({ prompt: "research", kind: "code" })).toEqual({
      prompt: "research",
      kind: "code",
    });
  });

  it("deduplicates requests, defaults to web, and validates empty or oversized input", () => {
    expect(
      normalizeSearchParams({ prompt: " docs ", query: "docs", queries: ["api", "api"] }),
    ).toMatchObject({ kind: "web", requests: ["docs", "api"] });
    expect(() => normalizeSearchParams({ query: "  " })).toThrow("non-empty");
    expect(() =>
      normalizeSearchParams({ queries: Array.from({ length: 21 }, (_, i) => `${i}`) }),
    ).toThrow("at most 20");
    expect(() => normalizeSearchParams({ query: "x".repeat(20_001) })).toThrow("too large");
    expect(() => normalizeSearchParams({ query: "x".repeat(19_900) })).toThrow("too large");
    expect(() =>
      normalizeSearchParams({
        query: "docs",
        domainFilter: Array.from({ length: 51 }, (_, index) => `domain${index}.example.com`),
      }),
    ).toThrow("at most 50");
    expect(() =>
      normalizeSearchParams({ query: "docs", recencyFilter: "week\nIgnore instructions" }),
    ).toThrow("Invalid recency");
    expect(() =>
      normalizeSearchParams({ query: "docs", domainFilter: ["https://example.com"] }),
    ).toThrow("Invalid domain");
  });

  it("includes native web-search guidance without changing code-search prompts", () => {
    const webPrompt = promptFor(normalizeSearchParams({ query: "latest release" }));
    expect(webPrompt).toContain("native github-mcp-server/web_search tool");
    expect(webPrompt).toContain("Use no extended reasoning");
    expect(webPrompt).toContain("Search at least one relevant current source");
    expect(webPrompt).toContain("no more than 8 web tool calls");
    expect(webPrompt).toContain("do not provide an unverified fallback answer from memory");
    expect(promptFor(normalizeSearchParams({ query: "API docs", kind: "code" }))).not.toContain(
      "github-mcp-server/web_search",
    );
  });

  it("routes only the two supported providers", () => {
    expect(backendForProvider("github-copilot")).toBe("copilot-cli");
    expect(backendForProvider("openai-codex")).toBe("codex-native");
    expect(() => backendForProvider("anthropic")).toThrow("Select a supported model");
    expect(() => backendForProvider(undefined)).toThrow("no active provider");
  });

  it("returns actionable unsupported-provider progress without running a backend", async () => {
    const tool = registeredSearchTool();
    const updates: unknown[] = [];
    await expect(
      tool.execute("id", { query: "docs" }, undefined, (update) => updates.push(update), {
        model: { provider: "anthropic", id: "claude" },
      }),
    ).rejects.toThrow("github-copilot");
    expect(JSON.stringify(updates)).toContain("anthropic");
  });
});

describe("Copilot CLI backend", () => {
  it("does not run a --version preflight before the real search spawn", async () => {
    const executable = await fakeCopilot();
    await expect(
      runCopilotSearch("code", { query: "docs" }, undefined, executable),
    ).resolves.toContain("done");
  });

  it("reports a useful capability error for a missing CLI", async () => {
    await expect(
      runCopilotSearch("web", { query: "latest release" }, undefined, "definitely-not-copilot"),
    ).rejects.toThrow("Install and authenticate");
  });

  it("always uses no reasoning for Copilot retrieval", () => {
    expect(buildCopilotArguments("code", { query: "docs" })).toEqual(
      expect.arrayContaining([
        "--model",
        DEFAULT_COPILOT_SEARCH_MODEL,
        "--effort",
        DEFAULT_COPILOT_SEARCH_EFFORT,
      ]),
    );
    expect(buildCopilotArguments("web", { query: "docs" })).toEqual(
      expect.arrayContaining(["--available-tools=web_search"]),
    );
    expect(buildCopilotArguments("web", { query: "docs", includeContent: true })).toEqual(
      expect.arrayContaining(["--available-tools=web_search,web_fetch"]),
    );
    expect(buildCopilotArguments("code", { query: "docs" })).not.toContain(
      "--available-tools=web_search",
    );
    expect(
      buildCopilotArguments("code", {
        query: "docs",
        model: "gpt-5.4",
        reasoningEffort: "high",
      }),
    ).toEqual(expect.arrayContaining(["--model", "gpt-5.4", "--effort", "none"]));
    expect(
      buildCopilotArguments("code", {
        query: "docs",
        reasoningEffort: "high",
      }),
    ).not.toContain("high");
  });

  it("emits backend-specific progress, bounds output, and keeps CLI payloads out of errors", async () => {
    const executable = await fakeCopilot();
    const updates: string[] = [];
    await expect(
      runCopilotSearch("code", { query: "fail" }, undefined, executable, (value) =>
        updates.push(value),
      ),
    ).rejects.not.toThrow("should-not-leak");
    expect(updates).toEqual(["Searching with Copilot CLI…"]);
    await expect(
      runCopilotSearch("code", { query: "large" }, undefined, executable),
    ).resolves.toMatch(/\[truncated\]$/);
    expect(boundedCopilotOutput("x".repeat(13_000))).toMatch(/\[truncated\]$/);
  });

  it("forwards cancellation to the spawned child", async () => {
    const executable = await fakeCopilot();
    const controller = new AbortController();
    const pending = runCopilotSearch("code", { query: "wait" }, controller.signal, executable);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  it("uses the configured timeout and reports a safe timeout status", async () => {
    const executable = await fakeCopilot();
    vi.stubEnv("PI_COPILOT_SEARCH_TIMEOUT_MS", "20");
    const statuses: string[] = [];
    await expect(
      runCopilotSearch("code", { query: "wait" }, undefined, executable, (status) =>
        statuses.push(status),
      ),
    ).rejects.toThrow("timed out after 20ms without output");
    expect(statuses).toContain("Copilot search timed out after 20ms without output; stopping…");
    expect(copilotSearchTimeoutMs({})).toBe(DEFAULT_COPILOT_SEARCH_TIMEOUT_MS);
    expect(copilotSearchTimeoutMs({ PI_COPILOT_SEARCH_TIMEOUT_MS: "invalid" })).toBe(
      DEFAULT_COPILOT_SEARCH_TIMEOUT_MS,
    );
  });

  it("resets the inactivity timeout when Copilot continues to emit output", async () => {
    const executable = await fakeCopilot();
    vi.stubEnv("PI_COPILOT_SEARCH_TIMEOUT_MS", "250");
    await expect(
      runCopilotSearch("code", { query: "progress-wait" }, undefined, executable),
    ).resolves.toContain("done");
  });

  it("requires a successful native web_search invocation for web mode", async () => {
    const executable = await fakeCopilot();
    await expect(
      runCopilotSearch("web", { query: "skip-web" }, undefined, executable),
    ).rejects.toThrow("without invoking github-mcp-server/web_search");
    await expect(
      runCopilotSearch("web", { query: "web-fail" }, undefined, executable),
    ).rejects.toThrow("github-mcp-server/web_search failed");
  });

  it("marks Copilot source extraction as truncated after its bounded URL limit", () => {
    const extracted = sourcesFromText(
      Array.from({ length: 21 }, (_, index) => `https://example.com/${index}`).join(" "),
    );
    expect(extracted.sources).toHaveLength(20);
    expect(extracted.truncated).toBe(true);
  });

  it("routes registered GitHub provider execution through Copilot with complete details", async () => {
    const executable = await fakeCopilot();
    const originalPath = process.env.PATH;
    process.env.PATH = `${dirname(executable)}:${originalPath ?? ""}`;
    try {
      const updates: Array<{ content?: Array<{ text?: string }> }> = [];
      const result = await registeredSearchTool().execute(
        "id",
        { query: "docs" },
        undefined,
        (update) => updates.push(update as (typeof updates)[number]),
        {
          cwd: process.cwd(),
          model: { provider: "github-copilot", id: "parent-model" },
        },
      );
      expect(updates.map((update) => update.content?.[0]?.text)).toEqual([
        "Searching with Copilot CLI…",
        `Copilot started · ${DEFAULT_COPILOT_SEARCH_MODEL}`,
        "Copilot is using github-mcp-server/web_search…",
        "Copilot finished github-mcp-server/web_search",
      ]);
      expect(result.content[0]?.text).toContain("Untrusted external search results");
      expect(result.details).toMatchObject({
        backend: "copilot-cli",
        model: DEFAULT_COPILOT_SEARCH_MODEL,
        sourceCount: 1,
        providerAccounted: true,
        costIncludedInPi: false,
      });
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it("rejects unsafe overrides before process execution and never invokes a shell", async () => {
    expect(() => buildCopilotArguments("code", { query: "docs", model: "x;bad" })).toThrow(
      "Invalid model",
    );
    expect(() =>
      buildCopilotArguments("code", { query: "docs", reasoningEffort: "bad value" }),
    ).toThrow("Invalid reasoning effort");
    const prompt = "quoted; query $(never-a-shell-command)";
    const argumentsList = buildCopilotArguments("code", { query: prompt });
    expect(argumentsList[argumentsList.indexOf("-p") + 1]).toContain(prompt);
    expect(copilotSpawnOptions().shell).toBe(false);
    await expect(
      runCopilotSearch(
        "code",
        { query: "docs", reasoningEffort: "bad value" },
        undefined,
        "missing",
      ),
    ).rejects.toThrow("Invalid reasoning effort");
  });
});

describe("Codex native backend", () => {
  it("constructs a native filtered request with bounded output and model override", () => {
    expect(
      buildCodexSearchRequest(
        {
          prompt: "Research OpenAI",
          queries: ["Codex search"],
          kind: "code",
          model: "gpt-5.4",
          recencyFilter: "week",
          domainFilter: ["openai.com", "-example.com"],
          includeContent: true,
          maxTokens: 7_000,
        },
        "active-model",
        "request-id",
      ),
    ).toEqual({
      id: "request-id",
      model: "gpt-5.4",
      input: expect.stringContaining("Prefer official documentation"),
      commands: {
        search_query: [
          { q: "Research OpenAI", recency: 7, domains: ["openai.com"] },
          { q: "Codex search", recency: 7, domains: ["openai.com"] },
        ],
        response_length: "long",
      },
      settings: {
        search_context_size: "high",
        filters: { allowed_domains: ["openai.com"], blocked_domains: ["example.com"] },
        allowed_callers: ["direct"],
        external_web_access: "live",
      },
      max_output_tokens: 7_000,
    });
    expect(() =>
      buildCodexSearchRequest({ query: "docs", reasoningEffort: "high" }, "active"),
    ).toThrow("only by Copilot");
  });

  it("extracts OAuth account identity and builds required request headers", () => {
    const accessToken = token("account-xyz");
    expect(extractCodexAccountId(accessToken)).toBe("account-xyz");
    const headers = buildCodexHeaders(accessToken, "account-xyz", {
      "x-provider-header": "safe",
      authorization: "Bearer stale-value",
    });
    expect(headers.get("authorization")).toBe(`Bearer ${accessToken}`);
    expect(headers.get("chatgpt-account-id")).toBe("account-xyz");
    expect(headers.get("originator")).toBe("pi");
    expect(headers.get("content-type")).toBe("application/json");
    expect(() => extractCodexAccountId("not-a-jwt")).toThrow("/login openai-codex");
  });

  it("posts to /codex/alpha/search with refreshed auth and normalizes sources", async () => {
    const accessToken = token();
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    const statuses: string[] = [];
    const result = await runCodexSearch(
      { query: "current docs", domainFilter: ["example.com"] },
      { id: "gpt-5.4", baseUrl: "https://chatgpt.com/backend-api" },
      async () => ({ auth: { apiKey: accessToken } }),
      undefined,
      async (input, init) => {
        capturedUrl = String(input);
        capturedInit = init;
        return new Response(
          JSON.stringify({
            encrypted_output: "encrypted-secret-must-not-appear",
            output: "Evidence found.",
            results: [
              {
                type: "text_result",
                title: "Documentation",
                url: "https://example.com/docs",
                snippet: "Primary source",
                credential: "credential-must-not-appear",
              },
            ],
          }),
        );
      },
      (status) => statuses.push(status),
    );
    expect(capturedUrl).toBe("https://chatgpt.com/backend-api/codex/alpha/search");
    expect(capturedInit?.method).toBe("POST");
    expect(new Headers(capturedInit?.headers).get("authorization")).toBe(`Bearer ${accessToken}`);
    expect(JSON.parse(String(capturedInit?.body))).toMatchObject({
      model: "gpt-5.4",
      commands: { search_query: [{ q: "current docs", domains: ["example.com"] }] },
    });
    expect(statuses).toEqual(["Searching with Codex native search…"]);
    expect(result.output).toContain("https://example.com/docs");
    expect(JSON.stringify(result)).not.toContain("encrypted-secret");
    expect(JSON.stringify(result)).not.toContain("credential-must-not-appear");
  });

  it("deduplicates URLs, redacts unsafe URL fields, and ignores unknown oversized data", () => {
    const oversized = "oversized-secret".repeat(10_000);
    const normalized = normalizeCodexResponse({
      encrypted_output: "cipher-secret",
      output: "Bearer output-secret and evidence",
      results: [
        {
          title: "First",
          url: "https://example.com/page?token=url-secret",
          snippet: "Snippet",
          unknown_blob: oversized,
          api_key: "api-key-secret",
        },
        { title: "Duplicate", url: "https://example.com/page?token=url-secret" },
        { sources: [{ title: "Nested", link: "https://openai.com/research" }] },
        { url: "https://user:password@example.com/private" },
      ],
    });
    expect(normalized.sources).toHaveLength(2);
    expect(normalized.output).not.toContain("token=");
    expect(normalized.output).toContain("Bearer [redacted]");
    for (const secret of [
      "output-secret",
      "url-secret",
      "cipher-secret",
      "api-key-secret",
      oversized,
    ])
      expect(JSON.stringify(normalized)).not.toContain(secret);
  });

  it("removes common signed-URL capabilities and supports output-only source responses", () => {
    const result = normalizeCodexResponse({
      output:
        "Sources: https://bucket.s3.amazonaws.com/file?X-Amz-Credential=credential-secret&X-Amz-Signature=signature-secret and https://storage.example.com/blob?sv=1&sig=azure-secret",
    });
    expect(result.sources).toEqual([
      { url: "https://bucket.s3.amazonaws.com/file" },
      { url: "https://storage.example.com/blob" },
    ]);
    expect(result.resultCount).toBe(2);
    expect(JSON.stringify(result)).not.toContain("credential-secret");
    expect(JSON.stringify(result)).not.toContain("signature-secret");
    expect(JSON.stringify(result)).not.toContain("azure-secret");
  });

  it("marks output and source truncation explicitly", () => {
    const result = normalizeCodexResponse({
      output: "x".repeat(13_000),
      results: Array.from({ length: 25 }, (_, index) => ({
        title: `Source ${index}`,
        url: `https://example.com/${index}`,
      })),
    });
    expect(result.outputTruncated).toBe(true);
    expect(result.sourcesTruncated).toBe(true);
    expect(result.sources).toHaveLength(20);
    expect(result.output).toContain("[truncated]");
    expect(result.output).toContain("[Sources truncated.]");
  });

  it("rejects authentication, HTTP, malformed, and empty responses without payload leaks", async () => {
    const model = { id: "gpt-5.4" };
    await expect(runCodexSearch({ query: "docs" }, model, async () => undefined)).rejects.toThrow(
      "/login openai-codex",
    );
    await expect(
      runCodexSearch({ query: "docs" }, model, async () => {
        throw new Error("Bearer refreshed-secret");
      }),
    ).rejects.not.toThrow("refreshed-secret");
    await expect(
      runCodexSearch(
        { query: "docs" },
        model,
        async () => ({ auth: { apiKey: token() } }),
        undefined,
        async () => new Response("Bearer backend-secret", { status: 401 }),
      ),
    ).rejects.toThrow("HTTP 401");
    await expect(
      runCodexSearch(
        { query: "docs" },
        model,
        async () => ({ auth: { apiKey: token() } }),
        undefined,
        async () => new Response("not json"),
      ),
    ).rejects.toThrow("malformed");
    expect(() => normalizeCodexResponse({ output: "", results: [] })).toThrow("without results");
    expect(() => normalizeCodexResponse({ output: "ok", results: {} })).toThrow("structured");
  });

  it("refuses plaintext and untrusted Codex OAuth endpoints before sending credentials", async () => {
    const getAuth = async (baseUrl: string) => ({ auth: { apiKey: token(), baseUrl } });
    const fetchSpy = vi.fn();
    await expect(
      runCodexSearch(
        { query: "docs" },
        { id: "gpt-5.4" },
        () => getAuth("http://chatgpt.com/backend-api"),
        undefined,
        fetchSpy,
      ),
    ).rejects.toThrow("trusted HTTPS chatgpt.com");
    await expect(
      runCodexSearch(
        { query: "docs" },
        { id: "gpt-5.4" },
        () => getAuth("https://proxy.example.com/backend-api"),
        undefined,
        fetchSpy,
      ),
    ).rejects.toThrow("trusted HTTPS chatgpt.com");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("propagates cancellation before and during auth, fetch, and body decoding", async () => {
    const preAborted = new AbortController();
    preAborted.abort();
    await expect(
      runCodexSearch(
        { query: "docs" },
        { id: "gpt-5.4" },
        async () => ({ auth: { apiKey: token() } }),
        preAborted.signal,
      ),
    ).rejects.toMatchObject({ name: "AbortError" });

    const duringAuth = new AbortController();
    const authPending = runCodexSearch(
      { query: "docs" },
      { id: "gpt-5.4" },
      async () => new Promise(() => undefined),
      duringAuth.signal,
    );
    duringAuth.abort();
    await expect(authPending).rejects.toMatchObject({ name: "AbortError" });

    const controller = new AbortController();
    const pending = runCodexSearch(
      { query: "docs" },
      { id: "gpt-5.4" },
      async () => ({ auth: { apiKey: token() } }),
      controller.signal,
      async (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError")),
          );
        }),
    );
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });

    const duringBody = new AbortController();
    const bodyPending = runCodexSearch(
      { query: "docs" },
      { id: "gpt-5.4" },
      async () => ({ auth: { apiKey: token() } }),
      duringBody.signal,
      async () =>
        ({
          ok: true,
          json: async () => new Promise(() => undefined),
        }) as Response,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    duringBody.abort();
    await expect(bodyPending).rejects.toMatchObject({ name: "AbortError" });
  });

  it("routes registered execution through native search with complete safe details", async () => {
    const accessToken = token();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              output: "Native result",
              results: [{ title: "Source", url: "https://example.com/native" }],
            }),
          ),
      ),
    );
    const tool = registeredSearchTool();
    const updates: Array<{ content?: Array<{ text?: string }>; details?: SearchDetails }> = [];
    const result = await tool.execute(
      "id",
      { query: "native", kind: "code" },
      undefined,
      (update) => updates.push(update as (typeof updates)[number]),
      {
        cwd: process.cwd(),
        model: {
          provider: "openai-codex",
          id: "gpt-5.4",
          baseUrl: "https://chatgpt.com/backend-api",
        },
        modelRegistry: {
          getProviderAuth: async () => ({ auth: { apiKey: accessToken } }),
        },
      },
    );
    expect(updates[0]?.content?.[0]?.text).toBe("Searching with Codex native search…");
    expect(result.content[0]?.text).toContain("Untrusted external search results");
    expect(result.details).toMatchObject({
      backend: "codex-native",
      kind: "code",
      model: "gpt-5.4",
      queryCount: 1,
      resultCount: 1,
      sourceCount: 1,
      providerAccounted: true,
      usageStatus: "provider-accounted",
      costIncludedInPi: false,
    });
    expect(result).not.toHaveProperty("usage");
    expect(JSON.stringify(result.details)).not.toContain(accessToken);
  });
});

describe("search TUI feedback", () => {
  it("renders a compact kind and abbreviated query call", () => {
    const rendered = renderSearchCall({ kind: "code", query: `API ${"long ".repeat(40)}` }, theme())
      .render(200)
      .join("\n");
    expect(rendered).toContain("search code");
    expect(rendered).toContain("API long");
    expect(rendered.trimEnd().length).toBeLessThan(140);
  });

  it("renders backend-specific progress and compact completion", () => {
    expect(
      renderSearchResult(
        {
          content: [{ type: "text", text: "Searching with Copilot CLI…" }],
          details: undefined,
        },
        { isPartial: true, expanded: false },
        theme(),
      )
        .render(200)
        .join("\n"),
    ).toContain("Copilot CLI");
    const compact = renderSearchResult(
      { content: [{ type: "text", text: "result" }], details: details() },
      { isPartial: false, expanded: false },
      theme(),
    )
      .render(200)
      .join("\n");
    expect(compact).toContain("Codex native web search");
    expect(compact).toContain("2 sources");
    expect(compact).toContain("provider-accounted");
    expect(compact).not.toContain("Preview:");
  });

  it("shows bounded source URLs and a short preview only when expanded", () => {
    const rendered = renderSearchResult(
      {
        content: [{ type: "text", text: "full result is not rendered" }],
        details: details({ sourcesTruncated: true, truncated: true }),
      },
      { isPartial: false, expanded: true },
      theme(),
    )
      .render(300)
      .join("\n");
    expect(rendered).toContain("https://example.com/a");
    expect(rendered).toContain("Preview: Retrieved evidence preview");
    expect(rendered).toContain("omitted from Pi totals");
  });

  it("renders errors clearly while redacting credentials", () => {
    const rendered = renderSearchResult(
      {
        content: [{ type: "text", text: "HTTP failed: Bearer credential-secret" }],
        details: undefined,
      },
      { isPartial: false, expanded: false },
      theme(),
      { isError: true },
    )
      .render(300)
      .join("\n");
    expect(rendered).toContain("HTTP failed");
    expect(rendered).toContain("[redacted]");
    expect(rendered).not.toContain("credential-secret");
    expect(redactSensitiveText("Bearer credential-secret")).not.toContain("credential-secret");
  });
});
