import { describe, expect, it } from "vitest";
import { isCopilotModel } from "../../../shared/provider.js";

describe("Copilot compaction provider scope", () => {
  it("recognizes only the active Copilot provider", () => {
    expect(isCopilotModel({ provider: "github-copilot" })).toBe(true);
    expect(isCopilotModel({ provider: "openai-codex" })).toBe(false);
    expect(isCopilotModel(undefined)).toBe(false);
  });
});
