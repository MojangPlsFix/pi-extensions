import { describe, expect, it } from "vitest";
import { cacheDirectory, pasteFileName } from "../index.js";

describe("large-paste", () => {
  it("uses a namespaced cache override and owned filenames", () => {
    expect(
      cacheDirectory({ PI_EXTENSIONS_LARGE_PASTE_CACHE_DIR: "/tmp/custom" } as NodeJS.ProcessEnv),
    ).toBe("/tmp/custom");
    expect(pasteFileName(new Date("2026-01-02T03:04:05.006Z"), "id")).toBe(
      "pi-extensions-paste-2026-01-02T03-04-05-006Z-id.txt",
    );
  });
});
