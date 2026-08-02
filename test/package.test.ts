import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import askUserQuestion from "../packages/ask-user-question/index.js";
import contextSize from "../packages/context-size/index.js";
import copilotCompactionFix from "../packages/copilot-compaction-fix/index.js";
import copilotSearch from "../packages/copilot-search/index.js";
import copilotUsage from "../packages/copilot-usage/index.js";
import largePaste from "../packages/large-paste/index.js";
import modelCostBadges from "../packages/model-cost-badges/index.js";
import notify from "../packages/notify/index.js";
import planMode from "../packages/plan-mode/index.js";
import stats from "../packages/stats/index.js";
import subagents from "../packages/subagents/index.js";
import todos from "../packages/todos/index.js";
import uv from "../packages/uv/index.js";
import workingIndicator from "../packages/working-indicator/index.js";

type Registered = { name: string };
function registry() {
  const tools: string[] = [];
  const commands: string[] = [];
  return {
    tools,
    commands,
    api: {
      on: () => undefined,
      registerTool: (tool: Registered) => {
        tools.push(tool.name);
      },
      registerCommand: (name: string) => {
        commands.push(name);
      },
      registerEntryRenderer: () => undefined,
      appendEntry: () => undefined,
      getActiveTools: () => ["read", "bash", "edit", "write"],
      setActiveTools: () => undefined,
      getAllTools: () => [],
      sendUserMessage: () => undefined,
      sendMessage: () => undefined,
      events: { on: () => undefined, emit: () => undefined },
    },
  };
}

const entrypoints = [
  askUserQuestion,
  planMode,
  notify,
  todos,
  contextSize,
  largePaste,
  modelCostBadges,
  stats,
  subagents,
  uv,
  workingIndicator,
  copilotSearch,
  copilotUsage,
  copilotCompactionFix,
];

describe("package manifest", () => {
  it("loads only default extension entrypoints with unique tool and command names", () => {
    const subject = registry();
    for (const entrypoint of entrypoints) {
      expect(typeof entrypoint).toBe("function");
      entrypoint(subject.api as never);
    }
    expect(new Set(subject.tools).size).toBe(subject.tools.length);
    expect(new Set(subject.commands).size).toBe(subject.commands.length);
    expect(subject.tools).toEqual(
      expect.arrayContaining(["ask_user_question", "todo", "subagent_spawn", "search"]),
    );
  });

  it("links referenced third-party projects and their licenses", async () => {
    const notices = await readFile("THIRD_PARTY_NOTICES.md", "utf8");
    for (const url of [
      "https://github.com/openai/codex/commit/578c1b2230288104041e880a86d0f7f3a5ca6e47",
      "https://github.com/openai/codex/commit/1e85ca099e4265bf89f4016772d299816e231bb3",
      "https://github.com/openai/codex/blob/main/LICENSE",
      "https://github.com/badlogic/pi-skills",
      "https://github.com/badlogic/pi-skills/blob/main/LICENSE",
      "https://github.com/mitsuhiko/agent-stuff",
      "https://github.com/mitsuhiko/agent-stuff/blob/main/LICENSE",
      "https://github.com/ogulcancelik/pi-extensions",
      "https://github.com/ogulcancelik/pi-extensions/blob/main/LICENSE",
      "https://github.com/earendil-works/pi",
      "https://github.com/earendil-works/pi/blob/main/LICENSE",
    ])
      expect(notices).toContain(url);
  });

  it("has no lifecycle install scripts or production dependencies", async () => {
    const manifest = JSON.parse(await readFile("package.json", "utf8")) as {
      dependencies?: object;
      scripts?: Record<string, string>;
    };
    expect(manifest.dependencies ?? {}).toEqual({});
    for (const name of ["preinstall", "install", "postinstall", "prepare"])
      expect(manifest.scripts?.[name]).toBeUndefined();
  });
});
