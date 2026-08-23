import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import {
  activityContextLine,
  deriveActivityContext,
  humanizeTaskKey,
  type PresentableRun,
  presentRun,
  rowWithReservedSuffix,
  runDisplayLabel,
  safeDisplayText,
  styleHerdrStatus,
} from "../presentation.js";

function run(overrides: Partial<PresentableRun> = {}): PresentableRun {
  return {
    id: "worker-1234",
    name: "worker",
    profileClass: "write",
    status: "running",
    taskKey: "api-contract-review",
    activeLeaseGeneration: 1,
    ...overrides,
  };
}

function theme() {
  return {
    fg: vi.fn((token: string, text: string) => `<${token}>${text}</${token}>`),
  } as unknown as Pick<Theme, "fg"> & { fg: ReturnType<typeof vi.fn> };
}

describe("shared Hackler presentation", () => {
  it.each([
    [run({ status: "blocked" }), "Attention", "×", "error", "blocked"],
    [run({ status: "failed" }), "Attention", "×", "error", "failed"],
    [run({ status: "stopped" }), "Attention", "×", "error", "stopped"],
    [
      run({ cleanupFailure: { message: "cleanup uncertain" } }),
      "Attention",
      "×",
      "error",
      "cleanup failed",
    ],
    [run({ status: "queued" }), "Active", "◐", "warning", "queued"],
    [run({ status: "starting" }), "Active", "◐", "warning", "starting"],
    [run({ wrappingUp: true }), "Active", "◐", "warning", "wrapping up"],
    [
      run({ currentOperation: { kind: "worktree", name: "integration candidate" } }),
      "Active",
      "◐",
      "warning",
      "integrating",
    ],
    [
      run({ currentOperation: { kind: "cleanup", name: "cleanup" } }),
      "Active",
      "◐",
      "warning",
      "cleaning up",
    ],
    [run({ status: "parked" }), "Attention", "✓", "success", "ready"],
    [
      run({ status: "parked", completionAcknowledgedGeneration: 1 }),
      "History",
      "○",
      "success",
      "done",
    ],
    [
      run({
        status: "parked",
        activeLeaseGeneration: undefined,
        completionAcknowledgedGeneration: 0,
      }),
      "History",
      "○",
      "success",
      "done",
    ],
    [
      run({ status: "failed", completionAcknowledgedGeneration: 1 }),
      "History",
      "×",
      "error",
      "failed",
    ],
  ] as const)("maps lifecycle facts to Herdr status", (value, group, icon, token, state) => {
    expect(presentRun(value)).toMatchObject({ group, icon, token, state });
  });

  it("verifies every Herdr status glyph occupies one terminal cell", () => {
    for (const glyph of ["×", "◐", "✓", "○"]) expect(visibleWidth(glyph)).toBe(1);
  });

  it("maps every Herdr glyph through its exact semantic theme token", () => {
    const th = theme();
    const cases = [
      run({ status: "failed" }),
      run(),
      run({ status: "parked" }),
      run({ status: "parked", completionAcknowledgedGeneration: 1 }),
    ];
    for (const value of cases) {
      const presentation = presentRun(value);
      styleHerdrStatus(th as unknown as Theme, presentation, presentation.icon);
    }
    expect(th.fg.mock.calls).toEqual([
      ["error", "×"],
      ["warning", "◐"],
      ["success", "✓"],
      ["success", "○"],
    ]);
    expect(cases.map((value) => presentRun(value).icon).join("")).not.toMatch(/[!●✗△▵▴▲]/u);
  });

  it("humanizes stable keys while preserving common initialisms and Pi", () => {
    expect(humanizeTaskKey("api-ui-tui-rpc-sdk-pi-integration")).toBe(
      "API UI TUI RPC SDK Pi integration",
    );
    expect(humanizeTaskKey("planModeIntegration")).toBe("Plan mode integration");
    expect(humanizeTaskKey("APIContractReview")).toBe("API contract review");
    expect(humanizeTaskKey("  api_contract/review  ")).toBe("API contract review");
  });

  it("never falls back to the child prompt on compact surfaces", () => {
    expect(
      runDisplayLabel({
        ...run({ taskKey: undefined }),
        ownership: { key: "" },
        task: "FORBIDDEN full child prompt",
      } as PresentableRun & { task: string }),
    ).toBe("Worker · worker-1234");
  });

  it("sanitizes ANSI, OSC, controls, and multiline child text", () => {
    expect(safeDisplayText("safe\u001b[31m red\u001b[0m\nnext\u001b]0;spoof\u0007 line")).toBe(
      "safe red\nnext line",
    );
  });
});

describe("activity context", () => {
  it("uses the current tool name and the distinct previous meaningful action", () => {
    expect(
      deriveActivityContext(
        run({
          currentTool: "read",
          currentOperation: { kind: "tool", name: "read" },
          activity: [{ text: "grep finished" }, { text: "started read" }],
        }),
      ),
    ).toEqual({ currentTool: "read", now: "read", lastAction: "grep finished" });
  });

  it("deduplicates the matching tool-start record", () => {
    expect(
      deriveActivityContext(
        run({
          currentTool: "read",
          activity: [{ text: "started read" }],
          latestActivity: "started read",
        }),
      ),
    ).toEqual({ currentTool: "read", now: "read", lastAction: undefined });
  });

  it("replaces steering prompt text with a safe activity label", () => {
    const context = deriveActivityContext(
      run({
        activity: [{ kind: "steer", text: "FORBIDDEN follow-up instruction" }],
        latestActivity: "FORBIDDEN follow-up instruction",
      }),
    );
    expect(context.lastAction).toBe("steering guidance sent");
    expect(JSON.stringify(context)).not.toContain("FORBIDDEN");
  });

  it.each([
    ["startup", "startup"],
    ["model", "model turn"],
    ["finalization", "finalization"],
    ["cleanup", "cleanup"],
  ] as const)("uses %s as an operation fallback", (kind, expected) => {
    expect(
      deriveActivityContext(run({ currentOperation: { kind, name: "sensitive operation input" } })),
    ).toMatchObject({ now: expected });
  });

  it("uses a sanitized Attention reason when no activity was recorded", () => {
    expect(
      deriveActivityContext(
        run({
          attentionReason: "requested \u001b[31mAPI\u001b[0m decision",
          group: "Attention",
        }),
      ),
    ).toMatchObject({ lastAction: "requested API decision" });
  });

  it("returns no context when no current or previous activity exists", () => {
    expect(deriveActivityContext(run())).toEqual({
      currentTool: undefined,
      now: undefined,
      lastAction: undefined,
    });
    expect(activityContextLine({}, theme() as unknown as Theme, 80)).toBeUndefined();
  });

  it("keeps now before last and truncates last first", () => {
    const plainTheme = { fg: (_token: string, text: string) => text } as Theme;
    const line = activityContextLine(
      { now: "read", lastAction: "a very long previous grep operation finished" },
      plainTheme,
      28,
    );
    expect(line).toMatch(/^ {2}now: read · last: /u);
    expect(line).toContain("…");
    expect(visibleWidth(line ?? "")).toBeLessThanOrEqual(28);
  });
});

describe("width-safe compact rows", () => {
  it.each([1, 8, 20, 40, 60, 120])("never exceeds width %i with CJK and emoji", (width) => {
    const line = rowWithReservedSuffix(
      "◐ ",
      "API 界面 review 🧪 with a long label",
      " · working · 00:38",
      width,
    );
    expect(visibleWidth(line)).toBeLessThanOrEqual(width);
  });
});
