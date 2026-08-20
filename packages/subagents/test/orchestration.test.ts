import { describe, expect, it } from "vitest";
import {
  type DispatchTask,
  findOwnershipOverlap,
  normalizeOwnership,
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
});
