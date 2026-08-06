import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import askUserQuestion from "../packages/ask-user-question/index.js";
import contextSize from "../packages/context-size/index.js";
import largePaste from "../packages/large-paste/index.js";
import modelCostBadges from "../packages/model-cost-badges/index.js";
import notify from "../packages/notify/index.js";
import planMode from "../packages/plan-mode/index.js";
import stats from "../packages/stats/index.js";
import subagents from "../packages/subagents/index.js";
import todos from "../packages/todos/index.js";
import usageMeter from "../packages/usage-meter/index.js";
import uv from "../packages/uv/index.js";
import webSearch from "../packages/web-search/index.js";
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
      registerMessageRenderer: () => undefined,
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
  webSearch,
  usageMeter,
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
      expect.arrayContaining([
        "ask_user_question",
        "todo",
        "subagent_spawn",
        "subagent_close",
        "search",
      ]),
    );
  });

  it("declares the shared skills and the bro skill", async () => {
    const manifest = JSON.parse(await readFile("package.json", "utf8")) as {
      pi?: { skills?: string[] };
    };
    expect(manifest.pi?.skills).toEqual([
      "./packages/web-search/skills",
      "./packages/subagents/skills",
      "./packages/bro/skills",
      "./packages/ste-writing/skills",
    ]);
    expect(await readFile("packages/bro/skills/bro/SKILL.md", "utf8")).toContain("name: bro");
  });

  it("links referenced third-party projects and their licenses", async () => {
    const notices = await readFile("THIRD_PARTY_NOTICES.md", "utf8");
    for (const url of [
      "https://github.com/openai/codex/commit/578c1b2230288104041e880a86d0f7f3a5ca6e47",
      "https://github.com/openai/codex/commit/1e85ca099e4265bf89f4016772d299816e231bb3",
      "https://github.com/openai/codex/commit/2b5bdcf67547860f2e5c5a605009a70026796b2b",
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

  it("documents the recommended Luna Subagent roles everywhere users and agents look", async () => {
    const paths = [
      "README.md",
      "docs/configuration.md",
      "packages/subagents/README.md",
      "packages/subagents/skills/subagent-orchestration/SKILL.md",
    ];
    for (const path of paths) {
      const source = await readFile(path, "utf8");
      for (const expected of [
        "~/.pi/agent/subagents/config.json",
        "openai-codex/gpt-5.6-luna",
        '"thinking": "low"',
        '"thinking": "high"',
      ])
        expect(source, `${path} must contain ${expected}`).toContain(expected);
    }
    const skill = await readFile(
      "packages/subagents/skills/subagent-orchestration/SKILL.md",
      "utf8",
    );
    expect(skill).toContain("/reload");
    expect(skill).toContain("effective model");
    expect(skill).toContain("subagent_list");
    const command = await readFile("packages/subagents/agents-command.ts", "utf8");
    expect(command).toContain("~/.pi/agent/subagents/config.json");
    expect(command).toContain("/reload");
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
