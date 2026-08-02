import { describe, expect, it, vi } from "vitest";
import { activityViewLines, completionMessageRenderer, resourceDiagnostics } from "../renderers.js";
import { registerSubagentTools } from "../tools.js";
import { type AgentSnapshot, emptyUsage, type ManagedAgent } from "../types.js";

function snapshot(): AgentSnapshot {
  return {
    id: "worker-1",
    name: "worker",
    mode: "worker",
    status: "completed",
    backend: "rpc",
    task: "Implement the feature",
    taskHistory: ["Implement the feature"],
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: "2026-01-01T00:01:00.000Z",
    elapsedMs: 60_000,
    sessionDir: "/tmp/session",
    requestedResources: {
      contextMode: "auto",
      contextExecution: true,
      webSearch: true,
      todos: true,
      rtk: "auto",
      uv: "enabled",
      copilotCompactionFix: true,
    },
    detectedResources: {
      contextMode: true,
      contextExecution: true,
      webSearch: true,
      todos: true,
      rtk: true,
      uv: false,
      copilotCompactionFix: true,
    },
    effectiveResources: {
      contextMode: true,
      contextExecution: true,
      webSearch: true,
      todos: true,
      rtk: true,
      uv: false,
      copilotCompactionFix: true,
    },
    resourceWarnings: ["warning: UV unavailable; skipped."],
    activity: [],
    report: "done",
    stderr: "",
    usage: emptyUsage(),
  };
}

function managed(agent: AgentSnapshot): ManagedAgent {
  return {
    ...agent,
    definition: {
      name: agent.name,
      description: "worker",
      mode: agent.mode,
      prompt: "",
      source: "builtin",
    },
    output: agent.report,
    completionReported: true,
  };
}

function toolMap(pi: { registerTool: ReturnType<typeof vi.fn> }) {
  return new Map(pi.registerTool.mock.calls.map(([tool]) => [tool.name, tool]));
}

describe("subagent resource diagnostics", () => {
  it("formats availability and fallback warnings without changing activity rows", () => {
    const agent = snapshot();
    expect(resourceDiagnostics(agent)).toEqual(
      expect.arrayContaining([
        "Context Mode: auto → available",
        "UV: enabled → unavailable; native Bash active",
        "Warnings: warning: UV unavailable; skipped.",
      ]),
    );
    const inline = activityViewLines(
      {
        active: 0,
        ready: 1,
        open: 1,
        explorers: 0,
        workers: 0,
        failed: 0,
        interrupted: 0,
        closed: 0,
        agents: [agent],
      },
      { fg: (_color: string, text: string) => text } as never,
      200,
    ).join("\n");
    expect(inline).not.toContain("Context Mode:");
  });

  it("exposes current-agent diagnostics through spawn, list, and read results", async () => {
    const agent = snapshot();
    const started = managed(agent);
    const pi = { registerTool: vi.fn() };
    const manager = {
      snapshots: () => [agent],
      spawn: vi.fn(async () => started),
      send: vi.fn(),
      wait: vi.fn(),
      close: vi.fn(),
      interrupt: vi.fn(),
    };
    registerSubagentTools(pi as never, manager as never);
    const tools = toolMap(pi);
    const ctx = { model: undefined, thinkingLevel: undefined };

    const spawnResult = await tools
      .get("subagent_spawn")!
      .execute("call", { task: "Implement the feature" }, undefined, undefined, ctx);
    expect(spawnResult.content[0]?.text).toContain("UV: enabled → unavailable; native Bash active");

    const readResult = await tools.get("subagent_read")!.execute("call", { id: agent.id });
    expect(readResult.content[0]?.text).toContain("Context Mode: auto → available");

    const listResult = await tools
      .get("subagent_list")!
      .execute("call", {}, undefined, undefined, ctx);
    expect(listResult.content[0]?.text).toContain("Warnings: warning: UV unavailable; skipped.");
  });

  it("includes diagnostics in expanded completion cards only", () => {
    const theme = {
      fg: (_color: string, text: string) => text,
      bg: (_color: string, text: string) => text,
      bold: (text: string) => text,
    };
    const component = completionMessageRenderer({ agent: snapshot() }, true, theme as never);
    expect(component?.render(200).join("\n")).toContain(
      "UV: enabled → unavailable; native Bash active",
    );
  });
});
