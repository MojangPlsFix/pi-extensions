import { describe, expect, it, vi } from "vitest";
import {
  type DispatchTask,
  findOwnershipOverlap,
  normalizeOwnership,
  ORCHESTRATION_GUIDELINES,
  TaskClaimRegistry,
  taskFingerprint,
  validateDispatchBatch,
} from "../orchestration.js";

const kinds = new Map([
  ["scout", "read" as const],
  ["reviewer", "read" as const],
  ["worker", "write" as const],
]);

function task(overrides: Partial<DispatchTask> = {}): DispatchTask {
  return {
    key: "slice-a",
    agent: "scout",
    task: "Inspect the parser implementation.",
    owns: ["path:src/parser"],
    deliverable: "Evidence with exact paths.",
    acceptance: "Cites the parser entry point and its callers.",
    stopConditions: ["Stop after the evidence is complete or report a blocker."],
    ...overrides,
  };
}

describe("ownership normalization", () => {
  it("normalizes paths without permitting repository escapes", () => {
    expect(normalizeOwnership("path: ./src\\parser/")).toEqual({
      kind: "path",
      value: "src/parser",
    });
    expect(() => normalizeOwnership("path:../secret")).toThrow("Invalid owned path");
  });

  it("detects segment-aware path overlap", () => {
    expect(findOwnershipOverlap(["path:src/parser"], ["path:src/parser/token.ts"])).toBeDefined();
    expect(findOwnershipOverlap(["path:src/a"], ["path:src/ab"])).toBeUndefined();
    expect(findOwnershipOverlap(["symbol: parse Node"], ["symbol:parse-node"])).toBeDefined();
  });
});

describe("validateDispatchBatch", () => {
  it("accepts distinct read-only work in one batch", () => {
    expect(() =>
      validateDispatchBatch(
        [
          task(),
          task({
            key: "slice-b",
            agent: "reviewer",
            task: "Review error handling in the serializer.",
            owns: ["path:src/serializer"],
          }),
        ],
        { kinds },
      ),
    ).not.toThrow();
  });

  it("rejects invalid adaptive contracts before looking up a profile or creating claims", () => {
    const profileLookup = vi.spyOn(kinds, "get");
    expect(() =>
      validateDispatchBatch(
        [task(), task({ key: "invalid", task: "Inspect another parser.", acceptance: "  " })],
        { kinds },
      ),
    ).toThrow("non-empty acceptance criteria");
    expect(profileLookup).not.toHaveBeenCalled();

    expect(() => validateDispatchBatch([task({ stopConditions: [] })], { kinds })).toThrow(
      "at least one stop condition",
    );
    expect(() =>
      validateDispatchBatch([task({ stopConditions: ["done", " "] })], { kinds }),
    ).toThrow("stop conditions must not be empty");
    expect(profileLookup).not.toHaveBeenCalled();
    profileLookup.mockRestore();
  });

  it("rejects normalized duplicate work", () => {
    expect(() =>
      validateDispatchBatch(
        [task(), task({ key: "slice-b", task: " INSPECT—the parser implementation! " })],
        { kinds },
      ),
    ).toThrow("same normalized work");
    expect(taskFingerprint("Inspect—the parser implementation!")).toBe(
      taskFingerprint("inspect the parser implementation"),
    );
  });

  it("rejects overlapping writer scopes even in worktrees", () => {
    expect(() =>
      validateDispatchBatch(
        [
          task({ key: "write-a", agent: "worker", workspace: "worktree" }),
          task({
            key: "write-b",
            agent: "worker",
            task: "Implement parser tokens.",
            owns: ["path:src/parser/tokens.ts"],
            workspace: "worktree",
          }),
        ],
        { kinds },
      ),
    ).toThrow("Writer scope overlap");
  });

  it("limits shared-tree writers while allowing disjoint worktrees", () => {
    expect(() =>
      validateDispatchBatch(
        [
          task({ key: "write-a", agent: "worker", task: "Change parser.", workspace: "shared" }),
          task({
            key: "write-b",
            agent: "worker",
            task: "Change serializer.",
            owns: ["path:src/serializer"],
            workspace: "shared",
          }),
        ],
        { kinds },
      ),
    ).toThrow("shared-tree writer");

    expect(() =>
      validateDispatchBatch(
        [
          task({ key: "write-a", agent: "worker", task: "Change parser.", workspace: "worktree" }),
          task({
            key: "write-b",
            agent: "worker",
            task: "Change serializer.",
            owns: ["path:src/serializer"],
            workspace: "worktree",
          }),
        ],
        { kinds },
      ),
    ).not.toThrow();
  });

  it("rejects active duplicate work and unknown profiles", () => {
    const registry = new TaskClaimRegistry();
    registry.reserve("run-a", task(), "read");
    expect(() =>
      validateDispatchBatch([task({ key: "next" })], { kinds, existing: registry.all() }),
    ).toThrow("duplicates work already owned");
    expect(() => validateDispatchBatch([task({ agent: "missing" })], { kinds })).toThrow(
      "Unknown or disabled",
    );
  });

  it("explicitly avoids dispatching invented work to fill slots", () => {
    expect(ORCHESTRATION_GUIDELINES).toContain("smallest justified batch up to free capacity");
    expect(ORCHESTRATION_GUIDELINES).toContain("never invent, split, or duplicate work");
    expect(ORCHESTRATION_GUIDELINES).toContain("recompute the ready frontier after each wave");
    expect(ORCHESTRATION_GUIDELINES).toContain("Resolve pending blockers before another wait");
  });
});
