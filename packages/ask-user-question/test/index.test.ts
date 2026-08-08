import { describe, expect, it } from "vitest";
import { events } from "../../../shared/events.js";
import askUserQuestionExtension, { executeQuestions, type QuestionUI } from "../index.js";

function scriptedUI(responses: Array<string | boolean | undefined>): QuestionUI {
  const next = (): string | boolean | undefined => responses.shift();
  return {
    select: async () => next() as string | undefined,
    editor: async () => next() as string | undefined,
    confirm: async () => next() as boolean,
  };
}

function tuiHarness() {
  let component: { handleInput(data: string): void; render(width: number): string[] } | undefined;
  const custom = <T>(factory: any): Promise<T> =>
    new Promise<T>((resolve) => {
      component = factory(
        { requestRender() {} },
        {
          fg: (_color: string, text: string) => text,
          bg: (_color: string, text: string) => text,
          bold: (text: string) => text,
        },
        {},
        (value: unknown) => resolve(value as T),
      );
    });
  return {
    ui: { ...scriptedUI([]), custom },
    get component() {
      return component;
    },
  };
}

describe("ask_user_question", () => {
  it("reports the whole question wizard to both interaction event streams", async () => {
    const emitted: Array<{ name: string; value: unknown }> = [];
    let tool: any;
    const api = {
      events: {
        emit(name: string, value: unknown) {
          emitted.push({ name, value });
        },
      },
      on() {},
      registerTool(candidate: any) {
        tool = candidate;
      },
    };
    askUserQuestionExtension(api as any);

    await tool.execute("call-1", { questions: [] }, undefined, undefined, {
      hasUI: false,
      mode: "print",
    });

    expect(emitted).toEqual([
      {
        name: events.userInteraction,
        value: { active: true, reason: "Ask User question wizard" },
      },
      {
        name: events.herdrBlocked,
        value: { active: true, label: "Ask User question wizard" },
      },
      {
        name: events.userInteraction,
        value: { active: false, reason: "Ask User question wizard" },
      },
      {
        name: events.herdrBlocked,
        value: { active: false },
      },
    ]);
  });

  it("keeps predefined answer and TUI details separate", async () => {
    const harness = tuiHarness();
    const result = executeQuestions(
      {
        questions: [{ question: "Color?", options: [{ label: "a" }] }],
      },
      harness.ui,
      { tui: true },
    );
    await Promise.resolve();
    expect(harness.component).toBeDefined();

    harness.component!.handleInput("\t");
    for (const character of "and I want it pink") harness.component!.handleInput(character);
    harness.component!.handleInput("\r");
    await expect(result).resolves.toMatchObject({
      cancelled: false,
      answers: [{ kind: "option", answer: "a", custom: "and I want it pink" }],
    });
  });

  it("reviews an empty multi-select as unanswered and preserves a null answer on Proceed", async () => {
    const harness = tuiHarness();
    const result = executeQuestions(
      {
        questions: [{ question: "Targets?", multiSelect: true, options: [{ label: "Linux" }] }],
      },
      harness.ui,
      { tui: true },
    );
    await Promise.resolve();
    expect(harness.component).toBeDefined();

    harness.component!.handleInput("\u001b[B");
    harness.component!.handleInput("\u001b[B");
    harness.component!.handleInput("\r");
    expect(harness.component!.render(80).join("\\n")).toContain("Unanswered: Q1");
    harness.component!.handleInput("\u001b[C");
    harness.component!.handleInput("\r");

    await expect(result).resolves.toMatchObject({
      cancelled: false,
      answers: [{ kind: "multi", answer: null, selected: [] }],
    });
  });

  it("does not submit a committed option after changing its highlight without recommitting", async () => {
    const harness = tuiHarness();
    const result = executeQuestions(
      {
        questions: [
          { question: "First?", options: [{ label: "a" }, { label: "b" }] },
          { question: "Second?", options: [{ label: "x" }] },
        ],
      },
      harness.ui,
      { tui: true },
    );
    await Promise.resolve();
    expect(harness.component).toBeDefined();

    harness.component!.handleInput("\r");
    harness.component!.handleInput("\u001b[D");
    harness.component!.handleInput("\u001b[B");
    harness.component!.handleInput("\u001b[C");
    harness.component!.handleInput("\r");
    harness.component!.handleInput("\u001b[C");
    harness.component!.handleInput("\r");

    await expect(result).resolves.toMatchObject({
      cancelled: false,
      answers: [
        { kind: "option", answer: null },
        { kind: "option", answer: "x" },
      ],
    });
  });
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
