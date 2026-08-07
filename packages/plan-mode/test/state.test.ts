import { describe, expect, it } from "vitest";
import {
  createDefaultPlanModeState,
  PLAN_MODE_STATE_ENTRY,
  restorePlanModeState,
} from "../state.js";

describe("Plan Mode state", () => {
  it("defaults to inactive", () => {
    expect(createDefaultPlanModeState()).toEqual({
      version: 1,
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
      mode: "plan",
      disabledTools: ["edit", "write"],
      latestPlan: { sourceEntryId: "a1" },
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

  it("ignores malformed state", () => {
    expect(
      restorePlanModeState([
        { type: "custom", customType: PLAN_MODE_STATE_ENTRY, data: { mode: "plan" } },
      ]),
    ).toEqual(createDefaultPlanModeState());
  });
});
