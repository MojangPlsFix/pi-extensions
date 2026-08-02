import { describe, expect, it } from "vitest";
import { formatContextSize, parseContextSize } from "../index.js";

describe("context-size", () => {
  it("parses aliases and bounded numeric values", () => {
    expect(parseContextSize("272k")).toBe(272_000);
    expect(parseContextSize("1.5m")).toBe(1_500_000);
    expect(parseContextSize("zero")).toBeUndefined();
  });
  it("formats user-facing sizes", () => {
    expect(formatContextSize(1_000_000)).toBe("1M");
    expect(formatContextSize(128_000)).toBe("128K");
  });
});
