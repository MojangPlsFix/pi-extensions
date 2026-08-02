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

  it("ignores malformed state", () => {
    expect(
      restorePlanModeState([
        { type: "custom", customType: PLAN_MODE_STATE_ENTRY, data: { mode: "plan" } },
      ]),
    ).toEqual(createDefaultPlanModeState());
  });
});
