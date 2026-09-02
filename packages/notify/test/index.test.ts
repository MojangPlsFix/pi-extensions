import { describe, expect, it } from "vitest";
import { isWsl, notificationMode, powershellInvocation } from "../index.js";

describe("notify", () => {
  it("selects a platform-safe notification transport", () => {
    expect(isWsl({ WSL_INTEROP: "1" } as NodeJS.ProcessEnv)).toBe(true);
    expect(notificationMode("linux", { KITTY_WINDOW_ID: "1" } as NodeJS.ProcessEnv)).toBe("osc99");
    expect(notificationMode("linux", {})).toBe("osc777");
    expect(notificationMode("win32", {})).toBe("winrt");
  });

  it("launches Windows PowerShell through WSL init", () => {
    const executable = "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe";
    const existing = new Set(["/init", executable]);

    expect(
      powershellInvocation(
        "linux",
        { PATH: "/mnt/c/Windows/System32/WindowsPowerShell/v1.0", WSL_DISTRO_NAME: "Ubuntu" },
        (path) => existing.has(path),
      ),
    ).toEqual({ command: "/init", args: [executable] });
  });

  it("uses direct PowerShell when the WSL init launcher is unavailable", () => {
    expect(powershellInvocation("linux", { WSL_DISTRO_NAME: "Ubuntu" }, () => false)).toEqual({
      command: "powershell.exe",
      args: [],
    });
    expect(powershellInvocation("win32", {}, () => true)).toEqual({
      command: "powershell.exe",
      args: [],
    });
  });
});
