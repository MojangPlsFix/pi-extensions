import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import type { SubagentManager } from "../manager.js";
import { registerSubagentTools } from "../tools.js";

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
    const tools = new Map<string, { execute: (...args: any[]) => Promise<any> }>();
    const pi = {
      registerTool(definition: { name: string; execute: (...args: any[]) => Promise<any> }) {
        tools.set(definition.name, definition);
      },
    } as unknown as ExtensionAPI;
    const manager = {
      collect: vi.fn(async () => [
        {
          id: "scout-1",
          name: "scout",
          status: "parked",
          ownership: { owns: [] },
          report: "done",
        },
      ]),
      takeUnreportedUsage: vi.fn(() => usage()),
      pendingRequests: vi.fn(() => []),
      respondRequest: vi.fn(async (id: string, answer: string) => ({
        id,
        answer,
        status: "answered",
      })),
    } as unknown as SubagentManager;

    registerSubagentTools(pi, manager);
    const result = await tools
      .get("subagent_collect")!
      .execute("tool-call", { ids: ["scout-1"], wait: "all" }, undefined);

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

    const response = await tools
      .get("subagent_respond")!
      .execute("tool-call", { id: "request-1", answer: "continue" }, undefined);
    expect(response.content[0].text).toContain("request-1 answered: continue");
    expect(manager.respondRequest).toHaveBeenCalledWith("request-1", "continue");
  });
});
