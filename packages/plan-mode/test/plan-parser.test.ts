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
    expect(extractProposedPlan("<proposed_plan> </proposed_plan>")).toEqual({ error: "empty" });
    expect(
      extractProposedPlan("<proposed_plan>one</proposed_plan><proposed_plan>two</proposed_plan>"),
    ).toEqual({ error: "multiple" });
    expect(extractProposedPlan("<proposed_plan>unfinished")).toEqual({ error: "unterminated" });
  });
});
