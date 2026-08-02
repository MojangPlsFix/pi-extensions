import { describe, expect, it } from "vitest";
import {
  bashBlockReason,
  isDirectlyDisabledInPlanMode,
  planModeToolBlockReason,
} from "../policy.js";

describe("Plan Mode policy", () => {
  it("disables direct mutations and permits reviewed reads", () => {
    expect(isDirectlyDisabledInPlanMode("edit")).toBe(true);
    expect(isDirectlyDisabledInPlanMode("functions.ctx_purge")).toBe(true);
    expect(planModeToolBlockReason("read", { path: "README.md" })).toBeUndefined();
    expect(planModeToolBlockReason("functions.ctx_execute", {})).toBeUndefined();
    for (const tool of [
      "search",
      "subagent_spawn",
      "subagent_list",
      "subagent_read",
      "subagent_wait",
    ])
      expect(planModeToolBlockReason(tool, {}), tool).toBeUndefined();
    expect(planModeToolBlockReason("unreviewed_tool", {})).toContain("Unreviewed");
  });

  it("retains the full native inspection allowlist as an RTK fallback", () => {
    for (const command of [
      "cat README.md",
      "head README.md",
      "tail README.md",
      "grep Plan README.md",
      "rg Plan README.md",
      "ls packages",
      "pwd",
      "wc README.md",
      "sort README.md",
      "uniq README.md",
      "diff README.md README.md",
      "file README.md",
      "stat README.md",
      "du .",
      "df .",
      "tree packages",
      "which node",
      "whereis node",
      "type node",
      "printenv HOME",
      "uname -a",
      "whoami",
      "id",
      "date",
      "uptime",
      "ps",
      "free",
      "jq . package.json",
      "fd policy packages",
      "bat README.md",
      "eza packages",
      "find . -name '*.ts'",
      "git status",
      "git config --get user.name",
      "npm ls",
      "yarn list",
      "pnpm outdated",
      "node --version",
      "python --version",
      "python3 --version",
      "bun --version",
    ]) {
      expect(bashBlockReason(command), command).toBeUndefined();
    }
  });

  it("also allows conservative RTK inspection commands", () => {
    for (const command of [
      "rtk git status",
      "rtk git config --get user.name",
      "rtk rg Plan README.md",
      "rtk find . -name '*.ts'",
      "rtk npm ls",
      "rtk --ultra-compact read README.md",
      "rtk npm audit",
      "rtk pnpm outdated",
      "rtk gain --history",
      "rtk ls packages/plan-mode",
    ]) {
      expect(bashBlockReason(command), command).toBeUndefined();
    }
  });

  it("blocks shell composition and state changes for native and RTK commands", () => {
    for (const command of [
      "git commit -m test",
      "npm install x",
      "sed -i s/a/b/ file",
      "find . -delete",
      "cat a > b",
      "git status && git log",
      "python script.py",
      "rtk run touch generated.txt",
      "rtk run echo --help",
      "rtk proxy rm generated.txt",
      "rtk git commit -m test",
      "rtk npm install x",
      "rtk find . -delete",
      "rtk smart --force-download README.md",
      "rtk trust",
    ]) {
      expect(bashBlockReason(command), command).toBeTruthy();
    }
    expect(planModeToolBlockReason("todo", { action: "create" })).toContain("blocked");
    expect(planModeToolBlockReason("scratchpad", { action: "write" })).toContain("blocked");
  });
});
