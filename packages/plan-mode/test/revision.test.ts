import { describe, expect, it } from "vitest";
import { evaluatePlanRevision, type RevisionBranchEntry } from "../revision.js";
import type { PlanRevisionExpectation } from "../state.js";

function expectation(): PlanRevisionExpectation {
  return {
    reviewedPlan: { markdown: "# Old", sourceEntryId: "old" },
    phase: "awaiting",
    retryCount: 0,
    reviewContinuationId: "review-1",
    responseBoundary: {
      requestId: "review-1",
      originEntryId: "origin",
      deliveryEntryId: "delivery",
      settledEntryId: "settled",
    },
  };
}

function assistant(id: string, text: string): RevisionBranchEntry {
  return {
    type: "message",
    id,
    message: { role: "assistant", content: [{ type: "text", text }] },
  };
}

describe("review revision response evaluation", () => {
  it("uses only the bounded response interval", () => {
    expect(
      evaluatePlanRevision(expectation(), [
        assistant("outside-old", "<proposed_plan>\n# Outside\n</proposed_plan>"),
        { type: "custom_message", id: "delivery" },
        assistant("inside", "<proposed_plan>\n# Inside\n</proposed_plan>"),
        { type: "custom", id: "settled" },
        assistant("outside-new", "<proposed_plan>\n# Too new\n</proposed_plan>"),
      ]),
    ).toMatchObject({ kind: "valid", entryId: "inside", plan: "# Inside" });
  });

  it("skips marker-free acknowledgements newer than a valid proposal", () => {
    expect(
      evaluatePlanRevision(expectation(), [
        { type: "custom_message", id: "delivery" },
        assistant("valid", "<proposed_plan>\n# Valid\n</proposed_plan>"),
        assistant("ack", "The plan is unchanged."),
        { type: "custom", id: "settled" },
      ]),
    ).toEqual({
      kind: "valid",
      entryId: "valid",
      plan: "# Valid",
      lastCheckedAssistantEntryId: "ack",
    });
  });

  it("lets the newest malformed proposal supersede an older valid proposal", () => {
    expect(
      evaluatePlanRevision(expectation(), [
        { type: "custom_message", id: "delivery" },
        assistant("valid", "<proposed_plan>\n# Valid\n</proposed_plan>"),
        assistant("bad", "<proposed_plan>\n# Incomplete"),
        { type: "custom", id: "settled" },
      ]),
    ).toEqual({
      kind: "invalid",
      failure: "unterminated",
      lastCheckedAssistantEntryId: "bad",
    });
  });

  it("reports a bounded marker-free response as missing", () => {
    expect(
      evaluatePlanRevision(expectation(), [
        { type: "custom_message", id: "delivery" },
        assistant("ack", "The plan is unchanged."),
        { type: "custom", id: "settled" },
      ]),
    ).toEqual({
      kind: "invalid",
      failure: "missing",
      lastCheckedAssistantEntryId: "ack",
    });
  });

  it("waits for both coordinator receipt bounds", () => {
    const pending = expectation();
    delete pending.responseBoundary.settledEntryId;
    expect(evaluatePlanRevision(pending, [])).toEqual({ kind: "pending" });
  });
});
