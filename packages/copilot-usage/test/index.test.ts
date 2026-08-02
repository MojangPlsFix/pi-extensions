import { afterEach, describe, expect, it, vi } from "vitest";
import { parseCopilotQuota, registerCopilotUsage } from "../index.js";

type Handler = (...args: any[]) => any;

function harness(fetchQuota: () => Promise<any>) {
  const handlers = new Map<string, Handler[]>();
  const statuses: Array<[string, string | undefined]> = [];
  const api = {
    on(name: string, handler: Handler) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
    registerCommand: vi.fn(),
  } as never;
  const context = (provider: string) =>
    ({
      model: { provider },
      ui: {
        setStatus(key: string, value: string | undefined) {
          statuses.push([key, value]);
        },
        theme: { fg: (_color: string, value: string) => value },
        notify: vi.fn(),
      },
    }) as never;
  registerCopilotUsage(api, { fetchQuota, refreshIntervalMs: 30_000 });
  const emit = async (name: string, ctx?: unknown) => {
    for (const handler of handlers.get(name) ?? []) await handler({}, ctx);
    await Promise.resolve();
    await Promise.resolve();
  };
  return { context, emit, statuses };
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

describe("Copilot Usage lifecycle", () => {
  it("activates, clears on provider exit, and refreshes immediately on re-entry", async () => {
    vi.useFakeTimers();
    const fetchQuota = vi.fn(async () => ({ remaining: 4, unlimited: false, unit: "ai_credits" }));
    const subject = harness(fetchQuota);
    const copilot = subject.context("github-copilot");
    const codex = subject.context("openai-codex");

    await subject.emit("session_start", copilot);
    expect(fetchQuota).toHaveBeenCalledTimes(1);
    expect(subject.statuses.at(-1)?.[1]).toContain("Copilot: 4");

    await subject.emit("model_select", codex);
    expect(subject.statuses.at(-1)).toEqual(["pi-extensions:copilot-usage", undefined]);

    await subject.emit("model_select", copilot);
    expect(fetchQuota).toHaveBeenCalledTimes(2);
    expect(subject.statuses.at(-1)?.[1]).toContain("Copilot: 4");

    await subject.emit("session_shutdown");
    expect(subject.statuses.at(-1)).toEqual(["pi-extensions:copilot-usage", undefined]);
    expect(vi.getTimerCount()).toBe(0);
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
    expect(subject.statuses.at(-1)).toEqual(["pi-extensions:copilot-usage", undefined]);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetchQuota).toHaveBeenCalledTimes(2);
  });
});
