import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import type { SubagentManager } from "../manager.js";
import {
  LEGACY_STOP_CONDITION,
  prepareDispatchArguments,
  registerSubagentTools,
} from "../tools.js";

function usage() {
  return {
    input: 100,
    output: 25,
    cacheRead: 10,
    cacheWrite: 5,
    total: 140,
    cost: 0.033,
  };
}

describe("Subagent parent usage accounting", () => {
  it("attaches collected child usage as nested Pi tool usage", async () => {
    const tools = new Map<
      string,
      {
        execute: (...args: any[]) => Promise<any>;
        label?: string;
        description?: string;
        parameters?: any;
        prepareArguments?: (input: unknown) => unknown;
        renderCall?: (...args: any[]) => any;
        renderResult?: (...args: any[]) => any;
      }
    >();
    const pi = {
      registerTool(definition: {
        name: string;
        label?: string;
        description?: string;
        parameters?: any;
        prepareArguments?: (input: unknown) => unknown;
        execute: (...args: any[]) => Promise<any>;
        renderCall?: (...args: any[]) => any;
        renderResult?: (...args: any[]) => any;
      }) {
        tools.set(definition.name, definition);
      },
    } as unknown as ExtensionAPI;
    const manager = {
      collect: vi.fn(async () => ({
        runs: Array.from({ length: 6 }, (_, index) => ({
          id: `scout-${index + 1}`,
          name: "scout",
          status: "parked",
          activeLeaseGeneration: 1,
          completionAcknowledgedGeneration: 1,
          elapsedMs: 1_000,
          ownership: {
            key: index === 0 ? "api-contract-review" : `review-slice-${index + 1}`,
            owns: [],
          },
          report: "done",
        })),
        waitReason: "timeout",
      })),
      takeUnreportedUsage: vi.fn(() => usage()),
      pendingRequests: vi.fn(() => []),
      respondRequest: vi.fn(async (id: string, answer: string) => ({
        id,
        answer,
        status: "answered",
      })),
    } as unknown as SubagentManager;

    registerSubagentTools(pi, manager);
    expect([...tools.keys()]).toEqual([
      "subagent_dispatch",
      "subagent_status",
      "subagent_respond",
      "subagent_collect",
      "subagent_steer",
      "subagent_stop",
    ]);
    expect([...tools.values()].map((tool) => tool.label)).toEqual([
      "Dispatch Hackler",
      "Hackler status",
      "Respond to Hackler",
      "Collect Hackler",
      "Steer Hackler",
      "Stop Hackler",
    ]);
    const oldArguments = {
      tasks: [
        {
          key: "legacy",
          agent: "scout",
          task: "Map the parser.",
          owns: ["path:src/parser"],
          deliverable: "Parser map.",
        },
      ],
    };
    const prepared = tools.get("subagent_dispatch")!.prepareArguments!(oldArguments) as any;
    expect(prepared.tasks[0]).toMatchObject({
      acceptance: "Parser map.",
      stopConditions: [LEGACY_STOP_CONDITION],
    });
    expect(oldArguments.tasks[0]).not.toHaveProperty("acceptance");
    expect(prepareDispatchArguments(null)).toBeNull();
    expect(tools.get("subagent_dispatch")!.description).toContain(
      "never invent work to fill capacity",
    );
    expect(
      tools.get("subagent_dispatch")!.parameters.properties.tasks.items.properties.key.description,
    ).toContain("display label");

    const timeoutSchema = tools.get("subagent_collect")!.parameters.properties.timeoutSeconds;
    expect(timeoutSchema).toMatchObject({ minimum: 10, maximum: 3600 });
    const result = await tools
      .get("subagent_collect")!
      .execute("tool-call", { ids: ["scout-1"], wait: "all", timeoutSeconds: 45 }, undefined);

    expect(manager.collect).toHaveBeenCalledWith(["scout-1"], "all", undefined, 45);
    expect(result.details.waitReason).toBe("timeout");
    expect(result.content[0].text).toContain("Wait ended: timeout");
    expect(result.usage).toEqual({
      input: 100,
      output: 25,
      cacheRead: 10,
      cacheWrite: 5,
      totalTokens: 140,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0.033,
      },
    });
    expect(result.details).toMatchObject({ subagentUsageAttached: true });
    expect(manager.takeUnreportedUsage).toHaveBeenCalledWith(["scout-1"]);

    const rendererTheme = {
      fg: (_color: string, text: string) => text,
      bold: (text: string) => text,
    };
    const callOutput = tools
      .get("subagent_collect")!
      .renderCall?.({}, rendererTheme, {})
      .render(120)
      .join("\n");
    expect(callOutput).toContain("Hackler collect");
    const collapsed = tools
      .get("subagent_collect")!
      .renderResult?.(result, { expanded: false, isPartial: false }, rendererTheme, {})
      .render(120)
      .join("\n");
    expect(collapsed).toContain("○ API contract review · done · 00:01");
    expect(collapsed).toContain("+2 omitted · ○ 6 History");
    expect((collapsed.match(/^○ /gmu) ?? []).length).toBe(4);
    expect(collapsed).not.toMatch(/[!●✗△▵▴▲]/u);

    const response = await tools
      .get("subagent_respond")!
      .execute("tool-call", { id: "request-1", answer: "continue" }, undefined);
    expect(response.content[0].text).toContain("request-1 answered: continue");
    expect(manager.respondRequest).toHaveBeenCalledWith("request-1", "continue");
  });
});
