import { describe, expect, it } from "vitest";
import { executeQuestions, type QuestionUI } from "../index.js";

function scriptedUI(responses: Array<string | boolean | undefined>): QuestionUI {
  const next = (): string | boolean | undefined => responses.shift();
  return {
    select: async () => next() as string | undefined,
    editor: async () => next() as string | undefined,
    confirm: async () => next() as boolean,
  };
}

describe("ask_user_question", () => {
  it("returns a reviewed single selection", async () => {
    const details = await executeQuestions(
      { questions: [{ question: "Ship?", options: [{ label: "Yes", preview: "release" }] }] },
      scriptedUI(["Yes", true]),
    );
    expect(details).toMatchObject({
      cancelled: false,
      answers: [{ answer: "Yes", preview: "release" }],
    });
  });

  it("collects multi-select and a custom response", async () => {
    const details = await executeQuestions(
      {
        questions: [
          {
            question: "Targets?",
            multiSelect: true,
            options: [{ label: "Linux" }, { label: "macOS" }],
          },
        ],
      },
      scriptedUI(["☐ Linux", "Add custom answer…", "Windows", "Done", true]),
    );
    expect(details.answers[0]).toMatchObject({
      kind: "multi",
      selected: ["Linux"],
      custom: "Windows",
    });
  });

  it("returns cancellation without guessing", async () => {
    const details = await executeQuestions(
      { questions: [{ question: "Ship?", options: [{ label: "Yes" }] }] },
      scriptedUI([undefined]),
    );
    expect(details).toEqual({ answers: [], cancelled: true });
  });

  it("rejects malformed input and has a no-UI result", async () => {
    await expect(
      executeQuestions({ questions: [{ question: "bad", options: "nope" }] }, scriptedUI([])),
    ).resolves.toMatchObject({ error: "malformed_parameters" });
    await expect(executeQuestions({ questions: [] })).resolves.toMatchObject({ error: "no_ui" });
  });
});
