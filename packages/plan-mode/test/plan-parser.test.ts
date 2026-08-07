import { describe, expect, it } from "vitest";
import { extractProposedPlan } from "../plan-parser.js";

describe("proposed plan parser", () => {
  it("extracts exactly one complete plan", () => {
    expect(
      extractProposedPlan(
        "before\n<proposed_plan>\n# Title\n\n## Tests\n- test\n</proposed_plan>\nafter",
      ),
    ).toEqual({ plan: "# Title\n\n## Tests\n- test" });
  });

  it("ignores ordinary prose and rejects malformed tags", () => {
    expect(extractProposedPlan("Plan:\n1. first")).toEqual({});
    expect(extractProposedPlan("<proposed_plan> </proposed_plan>")).toEqual({});
    expect(
      extractProposedPlan("<proposed_plan>one</proposed_plan><proposed_plan>two</proposed_plan>"),
    ).toEqual({});
    expect(extractProposedPlan("<proposed_plan>unfinished")).toEqual({});
  });

  it("counts only standalone structural markers", () => {
    expect(
      extractProposedPlan(
        "Inline `<proposed_plan>` and `</proposed_plan>` are examples.\n\n<proposed_plan>\n# Actual\n</proposed_plan>",
      ),
    ).toEqual({ plan: "# Actual" });
    expect(
      extractProposedPlan(
        "```xml\n<proposed_plan>\nexample\n</proposed_plan>\n```\n\n<proposed_plan>\nreal\n</proposed_plan>",
      ),
    ).toEqual({ plan: "real" });
    expect(
      extractProposedPlan(
        "<proposed_plan>\nfirst\n</proposed_plan>\n<proposed_plan>\nsecond\n</proposed_plan>",
      ),
    ).toEqual({ error: "multiple" });
    expect(extractProposedPlan("<proposed_plan>\nunfinished")).toEqual({ error: "unterminated" });
    expect(extractProposedPlan("</proposed_plan>")).toEqual({ error: "unterminated" });
    expect(extractProposedPlan("<proposed_plan>\n\n</proposed_plan>")).toEqual({ error: "empty" });
  });
});
