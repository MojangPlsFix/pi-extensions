import { describe, expect, it } from "vitest";
import { isWsl, notificationMode } from "../index.js";

describe("notify", () => {
  it("selects a platform-safe notification transport", () => {
    expect(isWsl({ WSL_INTEROP: "1" } as NodeJS.ProcessEnv)).toBe(true);
    expect(notificationMode("linux", { KITTY_WINDOW_ID: "1" } as NodeJS.ProcessEnv)).toBe("osc99");
    expect(notificationMode("linux", {})).toBe("osc777");
    expect(notificationMode("win32", {})).toBe("winrt");
  });
});
