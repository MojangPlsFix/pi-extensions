import { describe, expect, it } from "vitest";
import { parseFrontmatter, safeName } from "../agents.js";

describe("agent definitions", () => {
  it("accepts a trusted user-global override shape", () => {
    expect(
      parseFrontmatter(
        "---\nname: careful worker\ndescription: reviewed\nmode: worker\nmodel: provider/model\nthinking: high\n---\nDo work.",
        "worker.md",
      ),
    ).toMatchObject({
      name: "careful-worker",
      mode: "worker",
      model: "provider/model",
      thinking: "high",
      source: "user",
    });
  });
  it("normalizes names and rejects invalid modes", () => {
    expect(safeName(" Explorer / A ")).toBe("explorer-a");
    expect(
      parseFrontmatter("---\nname: no\ndescription: no\nmode: unsafe\n---\nx", "bad.md"),
    ).toBeUndefined();
  });
});
