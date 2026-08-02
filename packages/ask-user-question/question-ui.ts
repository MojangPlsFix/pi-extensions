type Option = { label: string; description?: string; preview?: string };
type Question = {
  question: string;
  header?: string;
  options: Option[];
  multiSelect?: boolean;
  allowCustom?: boolean;
};
type Answer = {
  questionIndex: number;
  question: string;
  kind: "option" | "custom" | "multi";
  answer: string | null;
  selected?: string[];
  custom?: string;
  preview?: string;
};

export type QuestionUI = {
  select(title: string, options: string[]): Promise<string | undefined>;
  editor(title: string, initialValue: string): Promise<string | undefined>;
  confirm(title: string, message: string): Promise<boolean>;
};

const customLabel = "Other…";
const doneLabel = "Done";

function optionText(option: Option): string {
  return option.description?.trim()
    ? `${option.label} — ${option.description.trim()}`
    : option.label;
}

function titleFor(question: Question): string {
  return question.header?.trim()
    ? `${question.header.trim()}: ${question.question}`
    : question.question;
}

function answerSummary(answer: Answer): string {
  const selected = answer.selected?.length
    ? answer.selected.join(", ")
    : (answer.answer ?? "(no selection)");
  return answer.custom?.trim() ? `${selected}\n  Custom answer: ${answer.custom.trim()}` : selected;
}

export async function askOne(
  question: Question,
  questionIndex: number,
  ui: QuestionUI,
): Promise<Answer | undefined> {
  while (true) {
    const options = question.options.map(optionText);
    if (question.allowCustom !== false) options.push(customLabel);
    const selection = await ui.select(titleFor(question), options);
    if (selection === undefined) return undefined;

    const option = question.options.find((candidate) => optionText(candidate) === selection);
    const custom =
      selection === customLabel
        ? await ui.editor("Custom answer (include constraints or exceptions)", "")
        : undefined;
    if (selection === customLabel && custom === undefined) return undefined;

    const answer: Answer = {
      questionIndex,
      question: question.question,
      kind: custom === undefined ? "option" : "custom",
      answer: custom ?? option?.label ?? selection,
      ...(custom === undefined ? {} : { custom }),
      ...(option?.preview === undefined ? {} : { preview: option.preview }),
    };
    if (await ui.confirm("Review answer", answerSummary(answer))) return answer;
  }
}

export async function askMany(
  question: Question,
  questionIndex: number,
  ui: QuestionUI,
): Promise<Answer | undefined> {
  while (true) {
    const selected = new Set<string>();
    let custom: string | undefined;
    while (true) {
      const choiceMap = new Map<string, Option>();
      const options = question.options.map((option) => {
        const choice = `${selected.has(option.label) ? "☑" : "☐"} ${optionText(option)}`;
        choiceMap.set(choice, option);
        return choice;
      });
      if (question.allowCustom !== false)
        options.push(custom?.trim() ? "Edit custom answer…" : "Add custom answer…");
      options.push(doneLabel);

      const choice = await ui.select(
        `${titleFor(question)}\nSelect answers; choose Done when finished`,
        options,
      );
      if (choice === undefined) return undefined;
      if (choice === doneLabel) break;
      if (choice === "Add custom answer…" || choice === "Edit custom answer…") {
        const edited = await ui.editor(
          "Custom answer (include constraints or exceptions)",
          custom ?? "",
        );
        if (edited === undefined) return undefined;
        custom = edited;
        continue;
      }
      const option = choiceMap.get(choice);
      if (option) {
        if (selected.has(option.label)) selected.delete(option.label);
        else selected.add(option.label);
      }
    }

    const selectedLabels = [...selected];
    const preview = question.options.find((option) => selected.has(option.label))?.preview;
    const answer: Answer = {
      questionIndex,
      question: question.question,
      kind: "multi",
      answer: selectedLabels.join(", ") || null,
      selected: selectedLabels,
      ...(custom === undefined ? {} : { custom }),
      ...(preview === undefined ? {} : { preview }),
    };
    if (await ui.confirm("Review answers", answerSummary(answer))) return answer;
  }
}
