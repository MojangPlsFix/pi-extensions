import { describe, expect, it } from "vitest";
import {
  advanceImplementationWave,
  createImplementationWaveState,
  evaluateImplementationFinalization,
  isLikelyMutatingBash,
  parseImplementationSummary,
  shouldArmForToolResult,
} from "../finalization.js";

const valid = `Preamble is allowed.
## Outcome
Implemented.
## Changes
Changed the coordinator.
## Validation
Tests passed.
## Review status
Reviewed locally.
## Risks and blockers
None known.`;

describe("implementation summary parser", () => {
  it("accepts ordered, unique, non-empty unfenced required headings", () => {
    expect(parseImplementationSummary(valid)).toMatchObject({ ok: true });
  });

  it.each([
    ["fenced headings", `\`\`\`md\n${valid}\n\`\`\``],
    ["duplicate", `${valid}\n## Outcome\nAgain`],
    [
      "out of order",
      valid
        .replace("## Outcome", "## TEMP")
        .replace("## Changes", "## Outcome")
        .replace("## TEMP", "## Changes"),
    ],
    ["empty", valid.replace("## Validation\nTests passed.", "## Validation")],
    ["prefix impostor", valid.replace("## Outcome", "## Outcome details")],
    ["wrong heading level", valid.replace("## Outcome", "# Outcome")],
    ["unspaced trailing hashes", valid.replace("## Outcome", "## Outcome###")],
    [
      "invalid fence close with info text",
      `\`\`\`md\nexample\n\`\`\`not-a-close\n${valid}\n\`\`\``,
    ],
    [
      "fenced-only content",
      valid.replace("## Validation\nTests passed.", "## Validation\n```text\nTests passed.\n```"),
    ],
  ])("rejects %s", (_name, markdown) => {
    expect(parseImplementationSummary(markdown).ok).toBe(false);
  });

  it("does not mistake a heading inside a tilde fence for a required heading", () => {
    expect(parseImplementationSummary(`~~~\n${valid}\n~~~`).ok).toBe(false);
  });
});

describe("implementation wave state machine", () => {
  it("queues one correction, warns once, and remains quiet thereafter", () => {
    let state = advanceImplementationWave(createImplementationWaveState(), "anchor", "edit");
    let transition = evaluateImplementationFinalization(state, [{ entryId: "a1", text: "done" }]);
    expect(transition.action).toBe("queue-correction");
    state = transition.state;

    transition = evaluateImplementationFinalization(state, [
      { entryId: "a1", text: "done" },
      { entryId: "a2", text: "still invalid" },
    ]);
    expect(transition.action).toBe("warn");
    state = transition.state;

    transition = evaluateImplementationFinalization(state, [
      { entryId: "a1", text: "done" },
      { entryId: "a2", text: "still invalid" },
      { entryId: "a3", text: "invalid again" },
    ]);
    expect(transition.action).toBe("none");
    expect(transition.state.warned).toBe(true);
  });

  it("searches all responses and completes on a valid earlier response", () => {
    const state = advanceImplementationWave(createImplementationWaveState(), "anchor", "write");
    const transition = evaluateImplementationFinalization(state, [
      { entryId: "valid", text: valid },
      { entryId: "later", text: "unrelated follow-up" },
    ]);
    expect(transition).toMatchObject({ action: "complete", entryId: "valid" });
    expect(transition.state.armed).toBe(false);
  });

  it("later mutation advances the wave and resets retry and warning", () => {
    const previous = {
      ...advanceImplementationWave(createImplementationWaveState(), "a", "edit"),
      retryQueued: true,
      warned: true,
      processedAssistantEntryIds: ["x"],
    };
    expect(advanceImplementationWave(previous, "b", "write")).toMatchObject({
      wave: 2,
      armed: true,
      anchorEntryId: "b",
      retryQueued: false,
      warned: false,
      processedAssistantEntryIds: [],
    });
  });
});

describe("mutation classification", () => {
  it("does not arm for read-only tools, failed writes, or known read-only Bash", () => {
    expect(shouldArmForToolResult({ toolName: "read", input: {}, isError: false })).toBe(false);
    expect(shouldArmForToolResult({ toolName: "write", input: {}, isError: true })).toBe(false);
    expect(shouldArmForToolResult({ toolName: "memory.write", input: {}, isError: false })).toBe(
      false,
    );
    expect(
      shouldArmForToolResult({
        toolName: "bash",
        input: { command: "git status && rg workflow packages" },
        isError: false,
      }),
    ).toBe(false);
  });

  it("arms successful mutators and conservative likely-mutating Bash", () => {
    for (const toolName of [
      "edit",
      "write",
      "apply_patch",
      "repo.move_file",
      "functions.edit",
      "ctx_execute",
      "functions.ctx_execute_file",
      "ctx_batch_execute",
    ])
      expect(shouldArmForToolResult({ toolName, input: {}, isError: false })).toBe(true);
    for (const command of [
      "rm file",
      "sed -i s/a/b/ file",
      "npm install",
      "git apply fix.patch",
      "printf x>file",
      'printf x > "file.txt"',
      "git -C repo add file",
    ])
      expect(isLikelyMutatingBash(command), command).toBe(true);
    expect(
      shouldArmForToolResult({
        toolName: "functions.bash",
        input: { command: "touch generated.txt" },
        isError: false,
      }),
    ).toBe(true);
    for (const command of [
      "unknown-command",
      "npm test",
      "npm run typecheck",
      "printf 'rm file'",
      "rg 'git apply' packages",
      "git log --grep='npm install'",
    ])
      expect(isLikelyMutatingBash(command), command).toBe(false);
  });
});
