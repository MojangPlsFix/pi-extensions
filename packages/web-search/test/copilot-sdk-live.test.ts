import { afterEach, describe, expect, it } from "vitest";
import { CopilotSearchRuntime, runCopilotSearch } from "../index.js";

const liveEnabled = process.env.PI_COPILOT_SEARCH_LIVE === "1";
const stressEnabled = process.env.PI_COPILOT_SEARCH_LIVE_STRESS === "1";
const compareCli = process.env.PI_COPILOT_SEARCH_LIVE_COMPARE_CLI === "1";
let runtime: CopilotSearchRuntime | undefined;

afterEach(async () => {
  await runtime?.shutdown();
  runtime = undefined;
});

describe.skipIf(!liveEnabled)("live bundled Copilot SDK capability", () => {
  it("authenticates, isolates canonical web_search, and gates web_fetch with content inspection", async () => {
    runtime = new CopilotSearchRuntime();
    const search = await runtime.search({
      query: "GitHub Copilot SDK official repository",
      domainFilter: ["github.com"],
    });
    expect(search.resultCount).toBeGreaterThan(0);
    expect(search.sources.length).toBeGreaterThan(0);
    expect(search.output).toContain("http");
    expect(search.model).toBe("gpt-5.6-luna");
    expect(typeof search.reasoningEffort).toBe("string");

    const inspected = await runtime.search({
      query: "GitHub Copilot SDK Node.js README authentication section",
      domainFilter: ["github.com"],
      includeContent: true,
    });
    expect(inspected.resultCount).toBeGreaterThan(0);
    expect(inspected.sources.length).toBeGreaterThan(0);
  }, 1_200_000);

  it.skipIf(!stressEnabled)(
    "reuses a warm runtime, supports four concurrent sessions, and remains usable after cancellation",
    async () => {
      runtime = new CopilotSearchRuntime();
      await runtime.search({
        query: "TypeScript official documentation",
        domainFilter: ["typescriptlang.org"],
      });
      await runtime.search({
        query: "Node.js official documentation",
        domainFilter: ["nodejs.org"],
      });
      const concurrent = await Promise.all(
        [
          "URL standard",
          "Fetch standard",
          "ECMAScript specification",
          "WebAssembly specification",
        ].map((query) => runtime?.search({ query })),
      );
      expect(concurrent.every((result) => (result?.sources.length ?? 0) > 0)).toBe(true);

      const controller = new AbortController();
      const cancelled = runtime.search({ query: "broad software news search" }, controller.signal);
      controller.abort();
      await expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
      await expect(
        runtime.search({ query: "IETF official website", domainFilter: ["ietf.org"] }),
      ).resolves.toMatchObject({
        resultCount: expect.any(Number),
      });
    },
    1_200_000,
  );

  it.skipIf(!compareCli)(
    "returns safe source coverage comparable to the legacy CLI backend",
    async () => {
      runtime = new CopilotSearchRuntime();
      const params = {
        query: "GitHub Copilot SDK official repository",
        domainFilter: ["github.com"],
      };
      const sdk = await runtime.search(params);
      const cliOutput = await runCopilotSearch("web", params);
      const sdkHosts = new Set(sdk.sources.map((source) => new URL(source.url).hostname));
      const cliHosts = new Set(
        [...cliOutput.matchAll(/https?:\/\/[^\s<>()]+/g)].map(
          (match) => new URL(match[0].replace(/[.,;:!?]+$/, "")).hostname,
        ),
      );
      expect(sdkHosts.size).toBeGreaterThan(0);
      expect(cliHosts.size).toBeGreaterThan(0);
      expect([...sdkHosts].some((host) => cliHosts.has(host))).toBe(true);
    },
    1_200_000,
  );
});
