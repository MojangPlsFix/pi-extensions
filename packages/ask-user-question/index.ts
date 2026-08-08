import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { withBlockingUserInteraction } from "../../shared/events.js";
import { type AskDetails, executeQuestions } from "./questions.js";

export type { QuestionUI } from "./question-ui.js";
export type { Answer, AskDetails, AskError, Option, Question } from "./questions.js";
export {
  executeQuestions,
  parseQuestions,
  validateQuestions,
} from "./questions.js";

const OptionSchema = Type.Object({
  label: Type.String({ minLength: 1, description: "Short selectable answer" }),
  description: Type.Optional(Type.String({ description: "Explanation shown with the answer" })),
  preview: Type.Optional(Type.String({ description: "Optional preview for the selected answer" })),
});

const QuestionSchema = Type.Object({
  question: Type.String({ minLength: 1, description: "Question shown to the user" }),
  header: Type.Optional(Type.String({ description: "Short label displayed before the question" })),
  options: Type.Array(OptionSchema, { minItems: 1, description: "Selectable answers" }),
  multiSelect: Type.Optional(Type.Boolean({ description: "Allow more than one selected answer" })),
  allowCustom: Type.Optional(
    Type.Boolean({ description: "Allow a free-form answer (default true)" }),
  ),
});

const AskUserQuestionParams = Type.Object({
  questions: Type.Array(QuestionSchema, {
    minItems: 1,
    maxItems: 10,
    description: "Questions to ask before continuing",
  }),
});

function result(details: AskDetails) {
  const text = details.cancelled
    ? "The user cancelled the question dialog. Do not guess unanswered values."
    : details.error
      ? `Could not ask the question: ${details.error}.`
      : JSON.stringify(details.answers, null, 2);
  return { content: [{ type: "text" as const, text }], details };
}

export function appendStructuredQuestionInstructions(systemPrompt: string): string {
  return `${systemPrompt}\n\n## Structured user questions\nWhen progress depends on a user decision, missing requirement, preference, or clarification, use the ask_user_question tool instead of asking in ordinary prose. Offer concise options, use multiSelect when several choices may apply, and permit custom details when the user may need to state constraints or exceptions. In the interactive TUI, the user can press Tab on a highlighted option to add details; keep predefined option labels distinct from those details. Do not use the tool for rhetorical questions.`;
}

export default function askUserQuestionExtension(pi: ExtensionAPI): void {
  pi.on("before_agent_start", (event) => ({
    systemPrompt: appendStructuredQuestionInstructions(event.systemPrompt),
  }));

  pi.registerTool({
    name: "ask_user_question",
    label: "Ask User",
    description:
      "Ask structured, reviewable user questions rather than guessing; supports choices, multi-select, and separate custom details.",
    parameters: AskUserQuestionParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      return withBlockingUserInteraction(pi.events, "Ask User question wizard", async () =>
        result(
          await executeQuestions(params, ctx.hasUI ? ctx.ui : undefined, {
            tui: ctx.mode === "tui",
          }),
        ),
      );
    },
    renderCall(args, theme: Theme) {
      const count = Array.isArray(args.questions) ? args.questions.length : 0;
      return new Text(
        theme.fg("toolTitle", theme.bold("ask_user_question ")) +
          theme.fg("muted", `${count} question${count === 1 ? "" : "s"}`),
        0,
      );
    },
    renderResult(value, { isPartial }, theme: Theme) {
      if (isPartial) return new Text(theme.fg("warning", "Waiting for your answer…"), 0, 0);
      const details = value.details as AskDetails | undefined;
      const label = details?.cancelled
        ? "Question dialog cancelled"
        : details?.error
          ? `Could not ask user: ${details.error}`
          : `Received ${details?.answers.length ?? 0} answer(s)`;
      return new Text(
        theme.fg(details?.cancelled || details?.error ? "warning" : "success", label),
        0,
        0,
      );
    },
  });
}
