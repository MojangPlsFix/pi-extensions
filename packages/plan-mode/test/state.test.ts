import { describe, expect, it } from "vitest";
import {
  createDefaultPlanModeState,
  PLAN_MODE_STATE_ENTRY,
  restorePlanModeState,
} from "../state.js";

describe("Plan Mode state", () => {
  it("defaults to inactive", () => {
    expect(createDefaultPlanModeState()).toEqual({
      version: 2,
      mode: "default",
      disabledTools: [],
    });
  });

  it("restores the newest valid public or legacy branch entry", () => {
    const state = {
      version: 1 as const,
      mode: "plan" as const,
      disabledTools: ["edit"],
      latestPlan: { markdown: "# Plan", sourceEntryId: "a1" },
    };
    expect(
      restorePlanModeState([
        { type: "custom", customType: "plan-mode-state", data: state },
        {
          type: "custom",
          customType: PLAN_MODE_STATE_ENTRY,
          data: { ...state, disabledTools: ["edit", "write"] },
        },
      ]),
    ).toMatchObject({
      version: 2,
      mode: "plan",
      disabledTools: ["edit", "write"],
      latestPlan: { sourceEntryId: "a1" },
      lastOfferedEntryId: "a1",
    });
  });

  it("restores review metadata and consumed-plan protection fields", () => {
    const state = {
      version: 1 as const,
      mode: "default" as const,
      disabledTools: [],
      latestPlan: { markdown: "# Plan", sourceEntryId: "source-1" },
      implementedPlanSourceEntryId: "source-1",
      lastReview: {
        planSourceEntryId: "source-1",
        reviewerId: "reviewer-1",
        model: "provider/model",
        reviewedAt: "2026-01-01T00:00:00.000Z",
        report: "Revise the test coverage.",
      },
    };
    expect(
      restorePlanModeState([{ type: "custom", customType: PLAN_MODE_STATE_ENTRY, data: state }]),
    ).toMatchObject({
      implementedPlanSourceEntryId: "source-1",
      lastReview: { planSourceEntryId: "source-1", reviewerId: "reviewer-1" },
    });
  });

  it("restores strict v2 revision expectations without sharing nested data", () => {
    const data = {
      version: 2 as const,
      mode: "plan" as const,
      disabledTools: ["edit"],
      latestPlan: { markdown: "# Old", sourceEntryId: "old" },
      revisionExpectation: {
        reviewedPlan: { markdown: "# Old", sourceEntryId: "old" },
        phase: "correction-requested" as const,
        retryCount: 1 as const,
        reviewContinuationId: "review",
        correctionContinuationId: "correction",
        responseBoundary: {
          requestId: "correction",
          originEntryId: "assistant-1",
          deliveryEntryId: "delivery",
          settledEntryId: "assistant-2",
        },
        lastCheckedAssistantEntryId: "assistant-2",
        parseFailure: "unterminated" as const,
      },
    };
    const restored = restorePlanModeState([
      { type: "custom", customType: PLAN_MODE_STATE_ENTRY, data },
    ]);
    expect(restored).toEqual(data);
    expect(restored.revisionExpectation).not.toBe(data.revisionExpectation);
    expect(restored.revisionExpectation?.responseBoundary).not.toBe(
      data.revisionExpectation.responseBoundary,
    );
  });

  it.each([
    [
      "empty proposal",
      {
        version: 2,
        mode: "plan",
        disabledTools: [],
        latestPlan: { markdown: "   ", sourceEntryId: "source" },
      },
    ],
    [
      "mismatched implemented source",
      {
        version: 2,
        mode: "default",
        disabledTools: [],
        latestPlan: { markdown: "# Plan", sourceEntryId: "source" },
        implementedPlanSourceEntryId: "other",
      },
    ],
    [
      "mismatched review source",
      {
        version: 2,
        mode: "plan",
        disabledTools: [],
        latestPlan: { markdown: "# Plan", sourceEntryId: "source" },
        lastReview: {
          planSourceEntryId: "other",
          reviewerId: "reviewer",
          model: "provider/model",
          reviewedAt: "2026-01-01T00:00:00Z",
          report: "Looks good.",
        },
      },
    ],
  ])("rejects strict v2 state with %s", (_case, data) => {
    expect(
      restorePlanModeState([{ type: "custom", customType: PLAN_MODE_STATE_ENTRY, data }]),
    ).toEqual(createDefaultPlanModeState());
  });

  it("ignores malformed state", () => {
    expect(
      restorePlanModeState([
        { type: "custom", customType: PLAN_MODE_STATE_ENTRY, data: { mode: "plan" } },
        {
          type: "custom",
          customType: PLAN_MODE_STATE_ENTRY,
          data: {
            version: 2,
            mode: "plan",
            disabledTools: [],
            revisionExpectation: {
              reviewedPlan: { markdown: "# Plan", sourceEntryId: "source" },
              phase: "awaiting",
              retryCount: 2,
              reviewContinuationId: "review",
              responseBoundary: { requestId: "review", originEntryId: null },
            },
          },
        },
      ]),
    ).toEqual(createDefaultPlanModeState());
  });
});
