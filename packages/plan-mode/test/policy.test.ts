import { describe, expect, it } from "vitest";
import { configureBashPolicy } from "../bash-policy.js";
import {
  bashBlockReason,
  configurePlanModePolicy,
  isDirectlyDisabledInPlanMode,
  planModeToolBlockReason,
} from "../policy.js";

describe("Plan Mode policy", () => {
  it("disables direct mutations and permits reviewed reads", () => {
    expect(isDirectlyDisabledInPlanMode("edit")).toBe(true);
    expect(isDirectlyDisabledInPlanMode("functions.ctx_purge")).toBe(true);
    expect(planModeToolBlockReason("read", { path: "README.md" })).toBeUndefined();
    expect(planModeToolBlockReason("memory_read", { target: "long_term" })).toBeUndefined();
    expect(planModeToolBlockReason("memory_search", { query: "plan" })).toBeUndefined();
    expect(
      planModeToolBlockReason("memory_write", { target: "daily", content: "note" }),
    ).toBeUndefined();
    expect(
      planModeToolBlockReason("memory_write", {
        target: "long_term",
        content: "fact",
        mode: "append",
      }),
    ).toBeUndefined();
    expect(
      planModeToolBlockReason("memory_write", {
        target: "long_term",
        content: "fact",
        mode: "overwrite",
      }),
    ).toContain("append-only");
    expect(
      planModeToolBlockReason("memory_write", { target: "scratchpad", content: "note" }),
    ).toContain("append-only");
    expect(planModeToolBlockReason("functions.ctx_execute", {})).toContain("disabled");
    for (const tool of [
      "search",
      "ctx_search",
      "ctx_stats",
      "ctx_doctor",
      "ctx_index",
      "ctx_fetch_and_index",
      "subagent_dispatch",
      "subagent_status",
      "subagent_collect",
      "subagent_steer",
      "subagent_stop",
      "repository_reference",
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
    for (const tool of [
      "ctx_execute",
      "ctx_execute_file",
      "ctx_batch_execute",
      "ctx_upgrade",
      "ctx_purge",
    ])
      expect(planModeToolBlockReason(tool, {}), tool).toContain("disabled");
    expect(planModeToolBlockReason("todo", { action: "create" })).toContain("blocked");
    expect(planModeToolBlockReason("scratchpad", { action: "write" })).toContain("blocked");
  });

  it("supports exact generic tool and CLI approvals without weakening guardrails", () => {
    configurePlanModePolicy({ readOnlyTools: ["functions.example_external_tool"] });
    configureBashPolicy({ readOnlyCommands: { "example-cli": ["help", "inspect", "list"] } });
    expect(planModeToolBlockReason("functions.example_external_tool", {})).toBeUndefined();
    expect(planModeToolBlockReason("example_external_tool_extra", {})).toContain("Unreviewed");
    expect(planModeToolBlockReason("write", {})).toContain("disabled");
    expect(bashBlockReason("example-cli help inspect")).toBeUndefined();
    expect(bashBlockReason("example-cli inspect item-123")).toBeUndefined();
    expect(bashBlockReason("example-cli delete item-123")).toBeTruthy();
    expect(
      bashBlockReason("example-cli inspect item-123 && example-cli delete item-123"),
    ).toBeTruthy();
  });
});
