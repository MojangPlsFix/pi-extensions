import { readFile } from "node:fs/promises";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import type { SubagentsStatusEvent } from "../../../shared/events.js";
import { SubagentActivityComponent } from "../../working-indicator/index.js";
import { AgentsViewer, activityViewLines } from "../renderers.js";
import { type AgentSnapshot, emptyUsage } from "../types.js";

function snapshot(overrides: Partial<AgentSnapshot> = {}): AgentSnapshot {
  return {
    id: "explorer-1",
    name: "explorer",
    mode: "explorer",
    status: "running",
    backend: "rpc",
    task: "Trace the authentication request flow",
    taskHistory: ["Trace the authentication request flow"],
    startedAt: "2026-01-01T00:00:00.000Z",
    elapsedMs: 12_000,
    sessionDir: "/tmp/session",
    requestedModel: "github-copilot/gpt-5.6-luna",
    requestedThinking: "off",
    latestActivity: "reading manager.ts",
    activity: [],
    report: "",
    stderr: "",
    usage: emptyUsage(),
    ...overrides,
  };
}

function event(agents: AgentSnapshot[]): SubagentsStatusEvent {
  const running = agents.filter((agent) => agent.status === "running");
  return {
    active: running.length,
    ready: agents.filter((agent) => agent.status === "completed").length,
    open: agents.filter((agent) => ["running", "completed"].includes(agent.status)).length,
    explorers: running.filter((agent) => agent.mode === "explorer").length,
    workers: running.filter((agent) => agent.mode === "worker").length,
    failed: agents.filter((agent) => agent.status === "failed").length,
    interrupted: agents.filter((agent) => agent.status === "interrupted").length,
    closed: agents.filter((agent) => agent.status === "closed").length,
    agents,
  };
}

function fakeTheme(calls: string[], palette: { prefix: string }): Theme {
  return {
    fg(color: string, text: string) {
      calls.push(color);
      return `\x1b[${palette.prefix}m${text}\x1b[0m`;
    },
    bg(color: string, text: string) {
      calls.push(color);
      return `\x1b[${palette.prefix}m${text}\x1b[0m`;
    },
    bold: (text: string) => text,
  } as Theme;
}

function plain(lines: string[]): string {
  return lines.join("\n").replace(/\x1b\[[0-9;]*m/gu, "");
}

describe("task-first Subagent rendering", () => {
  it("renders wide metadata, semantic theme tokens, consistent counts, and no over-width rows", () => {
    const calls: string[] = [];
    const theme = fakeTheme(calls, { prefix: "31" });
    const agents = [
      snapshot(),
      snapshot({
        id: "ready",
        status: "completed",
        task: "Compare Codex subagent model routing",
        elapsedMs: 34_000,
        report: "ready",
      }),
      snapshot({ id: "failed", status: "failed", task: "Failed task", error: "boom" }),
      snapshot({ id: "closed", status: "closed", task: "Closed task" }),
    ];
    const lines = activityViewLines(event(agents), theme, 120, "△");
    const text = plain(lines);
    expect(text).toContain("1 running (1E, 0W) · 1 ready");
    expect(text).toContain("Trace the authentication request flow");
    expect(text).toContain("explorer · running · luna · off · 00:12 · reading manager.ts");
    expect(text.indexOf("Trace the authentication")).toBeLessThan(text.indexOf("Compare Codex"));
    expect(calls).toEqual(
      expect.arrayContaining(["accent", "muted", "dim", "text", "success", "error"]),
    );
    expect(lines.every((line) => visibleWidth(line) <= 120)).toBe(true);
  });

  it("preserves tasks and core role/status/duration on narrow terminals", () => {
    const lines = activityViewLines(event([snapshot()]), fakeTheme([], { prefix: "32" }), 42, "△");
    const text = plain(lines);
    expect(text).toContain("Trace the authentication request flow");
    expect(text).toContain("explorer · running · 00:12");
    expect(text).not.toContain("reading manager.ts");
    expect(lines.every((line) => visibleWidth(line) <= 42)).toBe(true);
  });

  it("bounds inline rows to four while /agents keeps complete history", () => {
    const agents = Array.from({ length: 5 }, (_value, index) =>
      snapshot({ id: `agent-${index}`, task: `Delegated task ${index}` }),
    );
    const theme = fakeTheme([], { prefix: "33" });
    const inline = plain(activityViewLines(event(agents), theme, 100));
    expect(inline).toContain("Delegated task 3");
    expect(inline).not.toContain("Delegated task 4");

    const viewer = new AgentsViewer(
      { terminal: { rows: 80 }, requestRender: vi.fn() },
      theme,
      { matches: () => false } as never,
      () => agents,
      vi.fn(),
    );
    expect((viewer as unknown as { agents: AgentSnapshot[] }).agents).toHaveLength(5);
    expect((viewer as unknown as { agents: AgentSnapshot[] }).agents[4]?.task).toBe(
      "Delegated task 4",
    );
    viewer.dispose();
  });

  it("uses a static ready summary and rebuilds theme output on invalidate", () => {
    vi.useFakeTimers();
    try {
      const palette = { prefix: "31" };
      const tui = { requestRender: vi.fn() };
      const component = new SubagentActivityComponent(tui as never, fakeTheme([], palette));
      component.update(event([snapshot({ status: "completed" })]));
      const first = component.render(100).join("\n");
      expect(plain([first])).toContain("Subagents · 1 ready for follow-up");
      palette.prefix = "34";
      component.invalidate();
      expect(component.render(100).join("\n")).not.toBe(first);
      component.dispose();
      const renders = tui.requestRender.mock.calls.length;
      vi.advanceTimersByTime(500);
      expect(tui.requestRender).toHaveBeenCalledTimes(renders);
    } finally {
      vi.useRealTimers();
    }
  });

  it("disposes the /agents overlay refresh timer", () => {
    vi.useFakeTimers();
    try {
      const tui = { terminal: { rows: 40 }, requestRender: vi.fn() };
      const viewer = new AgentsViewer(
        tui,
        fakeTheme([], { prefix: "35" }),
        { matches: () => false } as never,
        () => [snapshot()],
        vi.fn(),
      );
      viewer.dispose();
      const renders = tui.requestRender.mock.calls.length;
      vi.advanceTimersByTime(1_000);
      expect(tui.requestRender).toHaveBeenCalledTimes(renders);
    } finally {
      vi.useRealTimers();
    }
  });

  it("contains no hardcoded ANSI or color literals in production renderers", async () => {
    const sources = await Promise.all([
      readFile(new URL("../renderers.ts", import.meta.url), "utf8"),
      readFile(new URL("../../working-indicator/index.ts", import.meta.url), "utf8"),
    ]);
    expect(sources.join("\n")).not.toMatch(/\\x1b\\\[[0-9;]*m|#[0-9a-f]{3,8}|\b(?:gray|grey)\b/iu);
  });
});
