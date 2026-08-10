import { afterEach, describe, expect, it, vi } from "vitest";
import {
  codexUsageUrl,
  copilotDailyBudget,
  copilotDailyPacePercent,
  daysInMonth,
  fetchCodexUsage,
  fetchProviderUsage,
  formatCodexUsage,
  formatCodexUsageDetailed,
  formatCopilotQuotaFooter,
  monthToDateWorkdays,
  parseCodexUsage,
  parseCodexUsageHeaders,
  parseCopilotQuota,
  registerUsageMeter,
  workdaysInMonth,
} from "../index.js";

type Handler = (...args: any[]) => any;

function token(accountId = "account-123"): string {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode({
    "https://api.openai.com/auth": { chatgpt_account_id: accountId },
  })}.signature`;
}

function harness(fetchQuota: () => Promise<any>, fetchCodex?: () => Promise<any>) {
  const handlers = new Map<string, Handler[]>();
  const statuses: Array<[string, string | undefined]> = [];
  const footers: Array<((width: number) => string[]) | undefined> = [];
  const notifications: unknown[][] = [];
  const api = {
    on(name: string, handler: Handler) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
    registerCommand: vi.fn(),
  } as any;
  const context = (provider: string) =>
    ({
      model: { provider },
      sessionManager: {
        getEntries: () => [],
        getCwd: () => "/home/test/project",
      },
      getContextUsage: () => ({ contextWindow: 128_000, percent: 12.5 }),
      modelRegistry: {
        getProviderAuth: vi.fn(async () => undefined),
        isUsingOAuth: () => false,
      },
      ui: {
        setStatus(key: string, value: string | undefined) {
          statuses.push([key, value]);
        },
        setFooter(footer: any) {
          if (!footer) {
            footers.push(undefined);
            return;
          }
          const widget = footer(
            { requestRender: vi.fn() },
            { fg: (_color: string, value: string) => value },
            {
              getGitBranch: () => "main",
              getExtensionStatuses: () => new Map<string, string>(),
              getAvailableProviderCount: () => 1,
            },
          );
          footers.push(widget.render);
        },
        theme: { fg: (_color: string, value: string) => value },
        notify: (...args: unknown[]) => notifications.push(args),
      },
    }) as never;
  registerUsageMeter(api, {
    fetchCopilotQuota: fetchQuota,
    fetchCodexUsage: fetchCodex,
    copilotRefreshIntervalMs: 30_000,
    codexRefreshIntervalMs: 60_000,
  });
  const emit = async (name: string, eventOrContext?: unknown, maybeContext?: unknown) => {
    const event = maybeContext === undefined ? {} : eventOrContext;
    const next = maybeContext === undefined ? eventOrContext : maybeContext;
    for (const handler of handlers.get(name) ?? []) await handler(event, next);
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
  };
  return { api, context, emit, statuses, footers, notifications };
}

afterEach(() => vi.useRealTimers());

describe("Copilot quota parsing", () => {
  it("parses quota metadata without credentials", () => {
    expect(
      parseCopilotQuota({
        token_based_billing: true,
        quota_snapshots: {
          premium_models: { entitlement: 100, remaining: 25, percent_remaining: 25 },
        },
      }),
    ).toMatchObject({ remaining: 25, total: 100, percentRemaining: 25, unit: "ai_credits" });
  });
  it("fails open for missing provider payloads", () =>
    expect(parseCopilotQuota({})).toBeUndefined());
});

describe("Copilot daily pace", () => {
  const baseline = {
    date: "2026-03-02",
    capturedAt: "2026-03-02T08:00:00.000Z",
    used: 0,
    remaining: 150_000,
    total: 150_000,
    unit: "ai_credits" as const,
  };

  it("uses deterministic workday pace and rejects weekends or incompatible baselines", () => {
    expect(daysInMonth(new Date("2026-02-10T12:00:00"))).toBe(28);
    expect(workdaysInMonth(new Date("2026-03-10T12:00:00"))).toBe(22);
    expect(monthToDateWorkdays(new Date("2026-03-08T12:00:00"))).toBe(5);
    expect(
      copilotDailyPacePercent(
        { remaining: 142_500, total: 150_000, unlimited: false, unit: "ai_credits" },
        [baseline],
        new Date("2026-03-03T12:00:00"),
      ),
    ).toBe(110);
    expect(
      copilotDailyPacePercent(
        { remaining: 142_500, total: 150_000, unlimited: false, unit: "ai_credits" },
        [baseline],
        new Date("2026-03-07T12:00:00"),
      ),
    ).toBeUndefined();
    expect(
      copilotDailyPacePercent(
        { remaining: 142_500, total: 150_000, unlimited: false, unit: "ai_credits" },
        [{ ...baseline, unit: "premium_requests" }],
        new Date("2026-03-03T12:00:00"),
      ),
    ).toBeUndefined();
  });

  it("calculates today's remaining allowance, including negative overage", () => {
    const today = { ...baseline, date: "2026-03-03" };
    const daily = copilotDailyBudget(
      { remaining: 146_591, total: 150_000, unlimited: false, unit: "ai_credits" },
      [today],
      new Date("2026-03-03T12:00:00"),
    );
    expect(Math.round(daily?.remaining ?? Number.NaN)).toBe(3_409);
    expect(Math.round(daily?.percentRemaining ?? Number.NaN)).toBe(50);

    const overBudget = copilotDailyBudget(
      { remaining: 143_000, total: 150_000, unlimited: false, unit: "ai_credits" },
      [today],
      new Date("2026-03-03T12:00:00"),
    );
    expect(overBudget?.remaining).toBeLessThan(0);
    expect(overBudget?.percentRemaining).toBeLessThan(0);
  });

  it("formats daily remaining credits before the monthly quota", () => {
    expect(
      formatCopilotQuotaFooter(
        { remaining: 142_500, total: 150_000, unlimited: false, unit: "ai_credits" },
        { remaining: 3_409, percentRemaining: 50 },
      ),
    ).toBe("daily: 3,409 (50%) left - month: 142,500/150,000 (95% left)");
    expect(
      formatCopilotQuotaFooter(
        { remaining: 25, total: 100, unlimited: false, unit: "premium_requests" },
        undefined,
      ),
    ).toBe("25/100");
    expect(
      formatCopilotQuotaFooter({ remaining: 0, unlimited: true, unit: "ai_credits" }, undefined),
    ).toBe("unlimited AI credits");
  });
});

describe("Codex usage", () => {
  it("fails open for malformed or unavailable provider responses", async () => {
    expect(parseCodexUsage(null)).toBeUndefined();
    expect(parseCodexUsage({ rate_limit: { primary_window: {} } })).toBeUndefined();
    await expect(fetchCodexUsage(async () => undefined)).resolves.toBeUndefined();
    await expect(
      fetchCodexUsage(
        async () => ({ auth: { apiKey: token() } }),
        async () => new Response("unavailable", { status: 503 }),
      ),
    ).resolves.toBeUndefined();
  });

  it("fetches authenticated usage from the native endpoint with required headers", async () => {
    let url = "";
    let init: RequestInit | undefined;
    const accessToken = token();
    const result = await fetchCodexUsage(
      async () => ({ auth: { apiKey: accessToken, headers: { "x-provider-header": "safe" } } }),
      async (input, requestInit) => {
        url = String(input);
        init = requestInit;
        return new Response(
          JSON.stringify({ rate_limit: { primary_window: { used_percent: 10 } } }),
        );
      },
    );
    expect(url).toBe("https://chatgpt.com/backend-api/wham/usage");
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${accessToken}`);
    expect(headers.get("chatgpt-account-id")).toBe("account-123");
    expect(headers.get("originator")).toBe("pi");
    expect(headers.get("x-provider-header")).toBe("safe");
    expect(JSON.stringify(result)).not.toContain(accessToken);
    expect(result?.primaryWindow?.usedPercent).toBe(10);
  });

  it("normalizes native rate-limit windows and formats remaining usage", () => {
    const usage = parseCodexUsage({
      plan_type: "pro",
      rate_limit: {
        allowed: true,
        limit_reached: false,
        primary_window: {
          used_percent: 25,
          limit_window_seconds: 10_800,
          reset_after_seconds: 900,
        },
        secondary_window: { used_percent: "50" },
      },
    });
    expect(usage).toEqual({
      planType: "pro",
      allowed: true,
      limitReached: false,
      primaryWindow: { usedPercent: 25, limitWindowSeconds: 10_800, resetAfterSeconds: 900 },
      secondaryWindow: { usedPercent: 50 },
    });
    expect(formatCodexUsage(usage!)).toBe("Codex: 3h 75% left · secondary 50% left");
  });

  it("formats exact compact labels, clamps percentages, and provides details", () => {
    const usage = parseCodexUsage({
      plan_type: "pro",
      credits: { has_credits: true, unlimited: false, balance: "88.5" },
      spend_control: {
        reached: false,
        individual_limit: {
          limit: "100",
          used: "12",
          remaining: "88",
          remaining_percent: 88,
          reset_at: 1_700_000_000,
        },
      },
      additional_rate_limits: [
        {
          limit_name: "code review",
          metered_feature: "reviews",
          rate_limit: { primary_window: { used_percent: 22, limit_window_seconds: 3600 } },
        },
      ],
      rate_limit: {
        primary_window: {
          used_percent: 142,
          limit_window_seconds: 18_000,
          reset_at: 1_700_000_000,
        },
        secondary_window: { used_percent: -19, limit_window_seconds: 604_800 },
      },
    });
    expect(formatCodexUsage(usage!)).toBe("Codex: 5h 0% left · weekly 100% left");
    expect(formatCodexUsageDetailed(usage!)).toContain("Codex · Pro");
    expect(formatCodexUsageDetailed(usage!)).toContain("resets ");
    expect(formatCodexUsageDetailed(usage!)).toContain("Credits: balance 88.5");
    expect(formatCodexUsageDetailed(usage!)).toContain("Spend control: limit 100");
    expect(formatCodexUsageDetailed(usage!)).toContain("Code Review: 1h: 78% left");
  });

  it("parses exact response headers and normalizes only trusted Codex URLs", () => {
    const headers = parseCodexUsageHeaders({
      "x-codex-plan": "plus",
      "x-codex-primary-used-percent": "42",
      "x-codex-primary-window-minutes": "300",
      "x-codex-primary-reset-at": "2030-01-01T00:00:00Z",
      "x-codex-credits-has-credits": "true",
      "x-codex-credits-unlimited": "false",
      "x-codex-credits-balance": "80.5",
      "x-codex-spend-control-individual-limit": "100",
      "x-codex-limit-reached": "false",
      "x-codex-additional-rate-limits": JSON.stringify([{ name: "review", used_percent: 9 }]),
    });
    expect(headers).toMatchObject({
      planType: "plus",
      primaryWindow: { usedPercent: 42, limitWindowSeconds: 18_000 },
      credits: { hasCredits: true, unlimited: false, balance: "80.5" },
      spendControl: { individualLimit: { limit: "100" } },
      limitReached: false,
    });
    expect(codexUsageUrl("https://chatgpt.com/backend-api/codex/")).toBe(
      "https://chatgpt.com/backend-api/wham/usage",
    );
    expect(() => codexUsageUrl("https://chatgpt.com/backend-api/other")).toThrow();
    expect(() => codexUsageUrl("http://chatgpt.com/backend-api")).toThrow();
    expect(() => codexUsageUrl("https://proxy.example.com/backend-api")).toThrow();
  });

  it("routes unsupported and supported-but-unavailable providers distinctly", async () => {
    const registry = { getProviderAuth: vi.fn(async () => undefined) };
    await expect(fetchProviderUsage({ provider: "anthropic" }, registry)).resolves.toBeUndefined();
    await expect(fetchProviderUsage({ provider: "openai-codex" }, registry)).resolves.toEqual({
      provider: "openai-codex",
    });
  });
});

describe("Usage meter lifecycle", () => {
  it("registers only /usage-meter and updates Codex from response headers", async () => {
    vi.useFakeTimers();
    const fetchCodex = vi.fn(async () => ({
      primaryWindow: { usedPercent: 42, limitWindowSeconds: 18_000 },
      secondaryWindow: { usedPercent: 19, limitWindowSeconds: 604_800 },
    }));
    const subject = harness(async () => undefined, fetchCodex);
    expect(subject.api.registerCommand).toHaveBeenCalledWith("usage-meter", expect.any(Object));
    const codex = subject.context("openai-codex");
    await subject.emit("session_start", codex);
    expect(fetchCodex).toHaveBeenCalledTimes(1);
    await subject.emit(
      "after_provider_response",
      {
        headers: { "x-codex-primary-used-percent": "58" },
      },
      codex,
    );
    expect(subject.footers.at(-1)?.(100).at(-1)).toContain("5h 42% left");
    await subject.emit("agent_end", codex);
    await subject.emit("tool_result", codex);
    expect(fetchCodex).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetchCodex).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetchCodex).toHaveBeenCalledTimes(2);
    const command = subject.api.registerCommand.mock.calls[0]?.[1];
    await command.handler("", codex);
    expect(subject.notifications.at(-1)?.[0]).toContain("Codex");
    await subject.emit("session_shutdown");
  });

  it("does not let a late request from the previous provider repaint", async () => {
    vi.useFakeTimers();
    let resolveCopilot: ((value: any) => void) | undefined;
    const fetchQuota = vi.fn(
      () =>
        new Promise<any>((resolve) => {
          resolveCopilot = resolve;
        }),
    );
    const subject = harness(fetchQuota);
    const copilot = subject.context("github-copilot");
    const codex = subject.context("openai-codex");
    await subject.emit("session_start", copilot);
    await subject.emit("model_select", codex);
    resolveCopilot?.({ remaining: 99, unlimited: false, unit: "ai_credits" });
    await Promise.resolve();
    await Promise.resolve();
    expect(subject.statuses.at(-1)).toEqual(["pi-extensions:usage-meter", undefined]);
    await subject.emit("session_shutdown");
  });

  it("deduplicates an in-flight request when re-entering the same provider", async () => {
    vi.useFakeTimers();
    let resolveCopilot: ((value: any) => void) | undefined;
    const fetchQuota = vi.fn(
      () =>
        new Promise<any>((resolve) => {
          resolveCopilot = resolve;
        }),
    );
    const subject = harness(fetchQuota, async () => undefined);
    const copilot = subject.context("github-copilot");
    const codex = subject.context("openai-codex");
    await subject.emit("session_start", copilot);
    await subject.emit("model_select", codex);
    await subject.emit("model_select", copilot);
    expect(fetchQuota).toHaveBeenCalledTimes(1);
    resolveCopilot?.({ remaining: 7, unlimited: false, unit: "ai_credits" });
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
    expect(subject.footers.at(-1)?.(100).at(-1)).toContain("7");
    await subject.emit("session_shutdown");
  });

  it("activates, clears on provider exit, and refreshes immediately on re-entry", async () => {
    vi.useFakeTimers();
    const fetchQuota = vi.fn(async () => ({ remaining: 4, unlimited: false, unit: "ai_credits" }));
    const subject = harness(fetchQuota);
    const copilot = subject.context("github-copilot");
    const codex = subject.context("openai-codex");

    await subject.emit("session_start", copilot);
    expect(fetchQuota).toHaveBeenCalledTimes(1);
    expect(subject.footers.at(-1)?.(100).at(-1)).toContain("4");

    await subject.emit("model_select", codex);
    expect(subject.statuses.at(-1)).toEqual(["pi-extensions:usage-meter", undefined]);

    await subject.emit("model_select", copilot);
    expect(fetchQuota).toHaveBeenCalledTimes(2);
    expect(subject.footers.at(-1)?.(100).at(-1)).toContain("4");

    await subject.emit("session_shutdown");
    expect(subject.statuses.at(-1)).toEqual(["pi-extensions:usage-meter", undefined]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("renders Copilot and Codex usage as right-aligned footer rows", async () => {
    const copilotSubject = harness(async () => ({
      remaining: 81_055,
      total: 150_000,
      percentRemaining: 54,
      unlimited: false,
      unit: "ai_credits",
    }));
    const copilot = copilotSubject.context("github-copilot");
    await copilotSubject.emit("session_start", copilot);
    const copilotLine = copilotSubject.footers.at(-1)?.(60).at(-1) ?? "";
    expect(copilotLine).toContain("81,055/150,000 (54% left)");
    expect(copilotLine).toHaveLength(60);
    expect(copilotLine.startsWith(" ")).toBe(true);

    const codexSubject = harness(
      async () => undefined,
      async () => ({
        primaryWindow: { usedPercent: 42, limitWindowSeconds: 18_000 },
        secondaryWindow: { usedPercent: 19, limitWindowSeconds: 604_800 },
      }),
    );
    const codex = codexSubject.context("openai-codex");
    await codexSubject.emit("session_start", codex);
    const codexLine = codexSubject.footers.at(-1)?.(60).at(-1) ?? "";
    expect(codexLine).toContain("5h 58% left · weekly 81% left");
    expect(codexLine).toHaveLength(60);
    expect(codexLine.startsWith(" ")).toBe(true);
  });

  it("throttles repeated lifecycle events and treats missing authentication as a quiet no-op", async () => {
    vi.useFakeTimers();
    const fetchQuota = vi.fn(async () => undefined);
    const subject = harness(fetchQuota);
    const copilot = subject.context("github-copilot");

    await subject.emit("session_start", copilot);
    await subject.emit("agent_end", copilot);
    await subject.emit("tool_result", copilot);
    expect(fetchQuota).toHaveBeenCalledTimes(1);
    expect(subject.statuses.at(-1)).toEqual(["pi-extensions:usage-meter", undefined]);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetchQuota).toHaveBeenCalledTimes(2);
  });
});
