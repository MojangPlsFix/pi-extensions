import { executeQuestionUI, type QuestionUI } from "./question-ui.js";

const reservedLabels = new Set(["other…", "done", "add custom answer…", "edit custom answer…"]);

export type Option = { label: string; description?: string; preview?: string };
export type Question = {
  question: string;
  header?: string;
  options: Option[];
  multiSelect?: boolean;
  allowCustom?: boolean;
};
export type Answer = {
  questionIndex: number;
  question: string;
  kind: "option" | "custom" | "multi";
  answer: string | null;
  selected?: string[];
  custom?: string;
  preview?: string;
};
export type AskError =
  | "no_ui"
  | "malformed_parameters"
  | "no_questions"
  | "empty_options"
  | "duplicate_option_label"
  | "reserved_option_label";
export type AskDetails = { answers: Answer[]; cancelled: boolean; error?: AskError };

function isOption(value: unknown): value is Option {
  if (!value || typeof value !== "object") return false;
  const option = value as Record<string, unknown>;
  return (
    typeof option.label === "string" &&
    (option.description === undefined || typeof option.description === "string") &&
    (option.preview === undefined || typeof option.preview === "string")
  );
}

function isQuestion(value: unknown): value is Question {
  if (!value || typeof value !== "object") return false;
  const question = value as Record<string, unknown>;
  return (
    typeof question.question === "string" &&
    (question.header === undefined || typeof question.header === "string") &&
    Array.isArray(question.options) &&
    question.options.every(isOption) &&
    (question.multiSelect === undefined || typeof question.multiSelect === "boolean") &&
    (question.allowCustom === undefined || typeof question.allowCustom === "boolean")
  );
}

export function parseQuestions(params: unknown): Question[] | undefined {
  if (!params || typeof params !== "object") return undefined;
  const questions = (params as Record<string, unknown>).questions;
  if (!Array.isArray(questions) || !questions.every(isQuestion)) return undefined;
  return questions;
}

export function validateQuestions(questions: Question[]): AskError | undefined {
  if (questions.length === 0 || questions.length > 10) return "no_questions";
  for (const question of questions) {
    if (!question.question.trim() || question.options.length === 0) return "empty_options";
    const labels = question.options.map((option) => option.label.trim().toLocaleLowerCase());
    if (labels.some((label) => !label)) return "empty_options";
    if (new Set(labels).size !== labels.length) return "duplicate_option_label";
    if (labels.some((label) => reservedLabels.has(label))) return "reserved_option_label";
  }
  return undefined;
}

export async function executeQuestions(
  params: unknown,
  ui?: QuestionUI,
  options: { tui?: boolean } = {},
): Promise<AskDetails> {
  if (!ui) return { answers: [], cancelled: false, error: "no_ui" };
  const questions = parseQuestions(params);
  if (!questions) return { answers: [], cancelled: false, error: "malformed_parameters" };
  const error = validateQuestions(questions);
  if (error) return { answers: [], cancelled: false, error };

  return executeQuestionUI(questions, ui, options.tui === true);
}
