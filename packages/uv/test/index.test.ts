import { describe, expect, it } from "vitest";
import { commandPrefix, getBlockedCommandMessage, toBashPath } from "../index.js";

describe("uv", () => {
  it("blocks package and bytecode mutation routes", () => {
    expect(getBlockedCommandMessage("python -m pip install x")).toContain("pip is disabled");
    expect(getBlockedCommandMessage(".venv/bin/python -m py_compile a.py")).toContain("bytecode");
    expect(getBlockedCommandMessage("uv run python test.py")).toBeUndefined();
  });
  it("converts Windows paths for the Bash prefix", () => {
    expect(toBashPath("C:\\Tools\\uv", "win32")).toBe("/c/Tools/uv");
    expect(commandPrefix("C:\\Tools\\uv", "win32")).toContain("/c/Tools/uv");
  });
});
