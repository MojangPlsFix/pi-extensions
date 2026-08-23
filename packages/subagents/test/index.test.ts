import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import subagentsExtension from "../index.js";

describe("subagents extension registration", () => {
  it("registers a durable redacted wrap entry renderer", () => {
    let wrapRenderer:
      | ((entry: { data?: unknown }, options: unknown, theme: Theme) => Component)
      | undefined;
    const pi = {
      events: {
        on: vi.fn(() => () => {}),
        emit: vi.fn(),
      },
      on: vi.fn(),
      registerTool: vi.fn(),
      registerCommand: vi.fn(),
      registerMessageRenderer: vi.fn(),
      registerEntryRenderer(
        type: string,
        renderer: (entry: { data?: unknown }, options: unknown, theme: Theme) => Component,
      ) {
        if (type === "subagent-wrap-v1") wrapRenderer = renderer;
      },
    } as unknown as ExtensionAPI;

    subagentsExtension(pi);

    expect(wrapRenderer).toBeTypeOf("function");
    const theme = {
      fg: (_color: string, text: string) => text,
      bg: (_color: string, text: string) => text,
      bold: (text: string) => text,
    } as Theme;
    const component = wrapRenderer!(
      {
        data: {
          schemaVersion: 1,
          runId: "scout-one",
          cause: "wall",
          at: "2026-01-01T00:08:00.000Z",
          deadlineAt: "2026-01-01T00:10:00.000Z",
          task: "FORBIDDEN_WRAP_TASK",
          report: "FORBIDDEN_WRAP_REPORT",
        },
      },
      {},
      theme,
    );
    const output = component.render(160).join("\n");

    expect(output).toContain("Hackler scout-one is wrapping up at its wall threshold");
    expect(output).toContain("deadline 2026-01-01T00:10:00.000Z");
    expect(output).not.toMatch(/FORBIDDEN_WRAP_(?:TASK|REPORT)/);
  });
});
