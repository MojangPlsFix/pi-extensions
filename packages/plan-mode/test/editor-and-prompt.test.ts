import { describe, expect, it } from "vitest";
import { appendStructuredQuestionInstructions } from "../../ask-user-question/index.js";
import { renderPlanModeBorder } from "../editor.js";
import { appendPlanModePrompt } from "../prompt.js";

describe("Plan Mode editor and prompt", () => {
  it("adds a border label without changing the source render array", () => {
    const original = ["─".repeat(24), "editor", "─".repeat(24)];
    const rendered = renderPlanModeBorder(original, 24, true, (text) => `[${text}]`);
    expect(rendered[0]).toContain("Plan Mode");
    expect(rendered[2]).toBe(original[2]);
    expect(original[0]).toBe("─".repeat(24));
  });

  it("only injects Plan Mode after generic question guidance", () => {
    const prompt = appendPlanModePrompt(appendStructuredQuestionInstructions("base"));
    expect(prompt.indexOf("Structured user questions")).toBeLessThan(
      prompt.indexOf("## Plan Mode"),
    );
    expect(prompt).toContain("When ask_user_question is available");
    expect(prompt).toContain("<proposed_plan>");
  });
});
