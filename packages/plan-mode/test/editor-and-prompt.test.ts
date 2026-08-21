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
    expect(prompt).toContain("run a grilling interview first");
    expect(prompt).toContain("current decision frontier");
    expect(prompt).toContain("ordinary English");
    expect(prompt).toContain("Context execution is unavailable in Plan Mode");
    expect(prompt).toContain("built-in read tool for exact file contents");
    expect(prompt).toContain("Use grep, find, and ls for direct inspection");
    expect(prompt).toContain("ctx_search for material that is already indexed");
    expect(prompt).toContain("ctx_execute_file runs supplied code");
    expect(prompt).toContain("ctx_index writes to the external Context knowledge base");
    expect(prompt).toContain("ctx_fetch_and_index performs network access");
    expect(prompt).toContain("Do not emit the final plan during the grilling interview.");
    expect(prompt).toContain("<proposed_plan>");
  });
});
