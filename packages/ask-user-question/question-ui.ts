import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import {
  Editor,
  type EditorTheme,
  Key,
  matchesKey,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

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
  /** Present the unified wizard. Only used when executeQuestions is in TUI mode. */
  custom?: ExtensionUIContext["custom"];
};

type WizardResult = { answers: Answer[]; cancelled: boolean };
type WizardState = "options" | "details" | "review";
type QuestionDraft = {
  optionIndex: number;
  selected: Set<string>;
  custom?: string;
  selectedOption?: number;
  committed: boolean;
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

/**
 * The old select/editor flow is deliberately kept as a separate fallback. It is
 * used by RPC and other non-TUI modes, while the custom component below is only
 * selected explicitly for interactive TUI runs.
 */
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

function customText(draft: QuestionDraft): string | undefined {
  return draft.custom?.trim() ? draft.custom : undefined;
}

function hasAnswer(question: Question, draft: QuestionDraft): boolean {
  if (!draft.committed) return false;
  if (question.multiSelect) {
    return draft.selected.size > 0 || customText(draft) !== undefined;
  }
  if (draft.selectedOption === undefined) return false;
  if (draft.selectedOption < question.options.length) return true;
  return question.allowCustom !== false && customText(draft) !== undefined;
}

function unansweredAnswer(question: Question, questionIndex: number): Answer {
  return question.multiSelect
    ? { questionIndex, question: question.question, kind: "multi", answer: null, selected: [] }
    : { questionIndex, question: question.question, kind: "option", answer: null };
}

function makeAnswer(question: Question, questionIndex: number, draft: QuestionDraft): Answer {
  const custom = customText(draft);
  if (question.multiSelect) {
    const selected = [...draft.selected];
    const preview = question.options.find((option) => draft.selected.has(option.label))?.preview;
    return {
      questionIndex,
      question: question.question,
      kind: "multi",
      answer: selected.join(", ") || null,
      selected,
      ...(custom === undefined ? {} : { custom }),
      ...(preview === undefined ? {} : { preview }),
    };
  }

  const selectedOption = draft.selectedOption;
  const customIndex = question.options.length;
  if (selectedOption === customIndex) {
    // A custom-only answer keeps the historical shape: the answer is the text
    // itself and custom carries the same user-authored value for consumers that
    // use the optional detail field.
    const value = custom ?? "";
    return {
      questionIndex,
      question: question.question,
      kind: "custom",
      answer: value,
      ...(custom === undefined ? {} : { custom }),
    };
  }

  const option = question.options[selectedOption ?? -1];
  return {
    questionIndex,
    question: question.question,
    kind: "option",
    answer: option?.label ?? null,
    ...(custom === undefined ? {} : { custom }),
    ...(option?.preview === undefined ? {} : { preview: option.preview }),
  };
}

function editorTheme(theme: Theme): EditorTheme {
  return {
    borderColor: (text) => theme.fg("accent", text),
    selectList: {
      selectedPrefix: (text) => theme.fg("accent", text),
      selectedText: (text) => theme.fg("accent", text),
      description: (text) => theme.fg("muted", text),
      scrollInfo: (text) => theme.fg("dim", text),
      noMatch: (text) => theme.fg("warning", text),
    },
  };
}

/** Run the interactive, stateful question wizard through ctx.ui.custom. */
async function askWithWizard(
  questions: Question[],
  customUI: NonNullable<QuestionUI["custom"]>,
): Promise<WizardResult> {
  const result = await customUI<WizardResult>((tui, theme, _keybindings, done) => {
    let state: WizardState = "options";
    let questionIndex = 0;
    let detailsOptionIndex = 0;
    let reviewIndex = 0;
    let editorDraft = "";
    let cachedLines: string[] | undefined;
    const drafts: QuestionDraft[] = questions.map(() => ({
      optionIndex: 0,
      selected: new Set<string>(),
      committed: false,
    }));
    const editor = new Editor(tui, editorTheme(theme));

    const requestRender = () => {
      cachedLines = undefined;
      tui.requestRender();
    };

    const currentQuestion = () => questions[questionIndex]!;
    const currentDraft = () => drafts[questionIndex]!;
    const optionCount = (question: Question) =>
      question.options.length +
      (question.allowCustom === false ? 0 : 1) +
      (question.multiSelect ? 1 : 0);
    const customIndex = (question: Question) => question.options.length;
    const doneIndex = (question: Question) =>
      question.options.length + (question.allowCustom === false ? 0 : 1);

    const allAnswered = () =>
      questions.every((question, index) => hasAnswer(question, drafts[index]!));

    const finish = (includeUnanswered: boolean) => {
      const answers = questions.flatMap((question, index) => {
        const draft = drafts[index]!;
        if (hasAnswer(question, draft)) return [makeAnswer(question, index, draft)];
        return includeUnanswered ? [unansweredAnswer(question, index)] : [];
      });
      done({ answers, cancelled: false });
    };

    const advanceAfterCommit = () => {
      if (allAnswered()) {
        finish(true);
        return;
      }
      if (questionIndex < questions.length - 1) {
        questionIndex++;
        state = "options";
        requestRender();
        return;
      }
      state = "review";
      reviewIndex = 0;
      requestRender();
    };

    const saveEditorDraft = () => {
      const draft = currentDraft();
      const nextCustom = editor.getExpandedText();
      if (nextCustom !== (draft.custom ?? "")) draft.committed = false;
      draft.custom = nextCustom;
      editorDraft = nextCustom;
    };

    const openDetails = () => {
      detailsOptionIndex = currentDraft().optionIndex;
      editorDraft = currentDraft().custom ?? "";
      editor.setText(editorDraft);
      state = "details";
      requestRender();
    };

    const leaveDetails = () => {
      saveEditorDraft();
      state = "options";
      requestRender();
    };

    const commitDetails = () => {
      saveEditorDraft();
      const question = currentQuestion();
      const draft = currentDraft();
      if (!question.multiSelect) {
        draft.selectedOption = detailsOptionIndex;
        draft.optionIndex = detailsOptionIndex;
        if (detailsOptionIndex === customIndex(question) && customText(draft) === undefined) {
          requestRender();
          return;
        }
        draft.committed = true;
        advanceAfterCommit();
        return;
      }
      state = "options";
      requestRender();
    };

    const cancel = () => done({ answers: [], cancelled: true });

    const handleOptionsInput = (data: string) => {
      const question = currentQuestion();
      const draft = currentDraft();
      const lastOption = optionCount(question) - 1;

      if (questions.length > 1 && matchesKey(data, Key.right)) {
        if (questionIndex < questions.length - 1) {
          questionIndex++;
          requestRender();
        } else {
          state = "review";
          reviewIndex = 0;
          requestRender();
        }
        return;
      }
      if (questions.length > 1 && matchesKey(data, Key.left)) {
        if (questionIndex > 0) {
          questionIndex--;
          requestRender();
        }
        return;
      }
      if (matchesKey(data, Key.up)) {
        const nextIndex = Math.max(0, draft.optionIndex - 1);
        if (nextIndex !== draft.optionIndex) draft.committed = false;
        draft.optionIndex = nextIndex;
        requestRender();
        return;
      }
      if (matchesKey(data, Key.down)) {
        const nextIndex = Math.min(lastOption, draft.optionIndex + 1);
        if (nextIndex !== draft.optionIndex) draft.committed = false;
        draft.optionIndex = nextIndex;
        requestRender();
        return;
      }
      if (matchesKey(data, Key.tab)) {
        openDetails();
        return;
      }
      if (matchesKey(data, Key.escape)) {
        cancel();
        return;
      }
      if (!matchesKey(data, Key.enter)) return;

      if (question.multiSelect) {
        if (draft.optionIndex === doneIndex(question)) {
          draft.committed = true;
          advanceAfterCommit();
        } else if (draft.optionIndex === customIndex(question) && question.allowCustom !== false) {
          openDetails();
        } else {
          const option = question.options[draft.optionIndex];
          if (option) {
            if (draft.selected.has(option.label)) draft.selected.delete(option.label);
            else draft.selected.add(option.label);
            draft.committed = false;
            requestRender();
          }
        }
        return;
      }

      draft.selectedOption = draft.optionIndex;
      if (draft.optionIndex === customIndex(question)) {
        if (customText(draft) === undefined) {
          openDetails();
          return;
        }
      }
      draft.committed = true;
      advanceAfterCommit();
    };

    const handleReviewInput = (data: string) => {
      if (matchesKey(data, Key.left) || matchesKey(data, Key.up)) {
        reviewIndex = Math.max(0, reviewIndex - 1);
        requestRender();
        return;
      }
      if (matchesKey(data, Key.right) || matchesKey(data, Key.down)) {
        reviewIndex = Math.min(1, reviewIndex + 1);
        requestRender();
        return;
      }
      if (matchesKey(data, Key.escape)) {
        cancel();
        return;
      }
      if (matchesKey(data, Key.enter)) {
        if (reviewIndex === 0) {
          const unanswered = questions.findIndex(
            (question, index) => !hasAnswer(question, drafts[index]!),
          );
          questionIndex = unanswered === -1 ? 0 : unanswered;
          state = "options";
          requestRender();
        } else {
          finish(true);
        }
      }
    };

    const handleInput = (data: string) => {
      if (state === "details") {
        if (matchesKey(data, Key.tab) || matchesKey(data, Key.escape)) {
          leaveDetails();
          return;
        }
        if (matchesKey(data, Key.enter)) {
          commitDetails();
          return;
        }
        const previousDraft = editorDraft;
        editor.handleInput(data);
        editorDraft = editor.getExpandedText();
        if (editorDraft !== previousDraft) currentDraft().committed = false;
        cachedLines = undefined;
        tui.requestRender();
        return;
      }
      if (state === "review") {
        handleReviewInput(data);
        return;
      }
      handleOptionsInput(data);
    };

    const render = (width: number): string[] => {
      if (cachedLines) return cachedLines;
      const renderWidth = Math.max(1, width);
      const lines: string[] = [];
      const add = (text: string) => lines.push(...wrapTextWithAnsi(text, renderWidth));
      const question = currentQuestion();
      const draft = currentDraft();

      lines.push(theme.fg("borderAccent", "─".repeat(renderWidth)));
      add(theme.fg("accent", `Question ${questionIndex + 1} of ${questions.length}`));
      if (questions.length > 1) {
        add(
          questions
            .map((item, index) => {
              const marker = hasAnswer(item, drafts[index]!) ? "●" : "○";
              const label = item.header?.trim() || `Q${index + 1}`;
              return index === questionIndex
                ? theme.bg("selectedBg", ` ${marker} ${label} `)
                : theme.fg("muted", ` ${marker} ${label} `);
            })
            .join(" "),
        );
      }
      lines.push("");

      if (state === "review") {
        add(theme.fg("accent", theme.bold("Review answers")));
        lines.push("");
        for (const [index, item] of questions.entries()) {
          const draftForQuestion = drafts[index]!;
          if (hasAnswer(item, draftForQuestion)) {
            add(
              theme.fg(
                "text",
                `${item.header?.trim() || `Q${index + 1}`}: ${answerSummary(makeAnswer(item, index, draftForQuestion))}`,
              ),
            );
          }
        }
        const unanswered = questions
          .map((item, index) =>
            !hasAnswer(item, drafts[index]!) ? item.header?.trim() || `Q${index + 1}` : undefined,
          )
          .filter((label): label is string => label !== undefined);
        if (unanswered.length > 0) {
          lines.push("");
          add(theme.fg("warning", `Unanswered: ${unanswered.join(", ")}`));
        }
        lines.push("");
        const actions = ["Go back", "Proceed"]
          .map((action, index) =>
            index === reviewIndex
              ? theme.bg("selectedBg", ` ${action} `)
              : theme.fg("muted", ` ${action} `),
          )
          .join(" ");
        add(actions);
        add(theme.fg("dim", "←→ choose • Enter confirm • Esc cancel"));
      } else if (state === "details") {
        add(theme.fg("text", titleFor(question)));
        lines.push("");
        const option = question.options[detailsOptionIndex];
        const selectedLabel = option?.label ?? customLabel;
        add(theme.fg("accent", `Details for: ${selectedLabel}`));
        lines.push("");
        add(theme.fg("muted", "Add constraints, preferences, or exceptions (optional):"));
        lines.push(...editor.render(Math.max(1, renderWidth - 2)).map((line) => ` ${line}`));
        lines.push("");
        add(theme.fg("dim", "Enter commits • Tab/Esc returns to options"));
      } else {
        add(theme.fg("text", titleFor(question)));
        lines.push("");
        for (let index = 0; index < optionCount(question); index++) {
          const isCustom = index === customIndex(question) && question.allowCustom !== false;
          const isDone = question.multiSelect && index === doneIndex(question);
          const option = question.options[index];
          const selected = draft.optionIndex === index;
          const checked = option ? draft.selected.has(option.label) : false;
          const prefix = selected ? theme.fg("accent", "> ") : "  ";
          const marker =
            question.multiSelect && !isCustom && !isDone ? (checked ? "☑ " : "☐ ") : "";
          const label = isDone
            ? doneLabel
            : isCustom
              ? customText(draft)
                ? "Edit custom answer…"
                : customLabel
              : optionText(option!);
          add(`${prefix}${marker}${theme.fg(selected ? "accent" : "text", label)}`);
          if (option?.description?.trim())
            add(`     ${theme.fg("muted", option.description.trim())}`);
        }
        if (customText(draft)) add(theme.fg("muted", `Custom details: ${customText(draft)}`));
        lines.push("");
        add(
          theme.fg(
            "dim",
            questions.length > 1
              ? "↑↓ navigate • Tab details • ←→ questions • Enter commit • Esc cancel"
              : "↑↓ navigate • Tab details • Enter commit • Esc cancel",
          ),
        );
      }
      lines.push(theme.fg("borderAccent", "─".repeat(renderWidth)));
      cachedLines = lines;
      return lines;
    };

    return {
      render,
      invalidate: () => {
        cachedLines = undefined;
        editor.invalidate();
      },
      handleInput,
    };
  });

  return result ?? { answers: [], cancelled: true };
}

export async function executeQuestionUI(
  questions: Question[],
  ui: QuestionUI,
  tui: boolean,
): Promise<{ answers: Answer[]; cancelled: boolean }> {
  if (tui && ui.custom) return askWithWizard(questions, ui.custom);

  const answers: Answer[] = [];
  for (const [questionIndex, question] of questions.entries()) {
    const answer = question.multiSelect
      ? await askMany(question, questionIndex, ui)
      : await askOne(question, questionIndex, ui);
    if (!answer) return { answers, cancelled: true };
    answers.push(answer);
  }
  return { answers, cancelled: false };
}
