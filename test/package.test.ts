import { access, readdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import askUserQuestion from "../packages/ask-user-question/index.js";
import codexCompaction from "../packages/codex-compaction/index.js";
import contextMode from "../packages/context-mode/index.js";
import contextSize from "../packages/context-size/index.js";
import largePaste from "../packages/large-paste/index.js";
import modelCostBadges from "../packages/model-cost-badges/index.js";
import notify from "../packages/notify/index.js";
import planMode from "../packages/plan-mode/index.js";
import repositoryReference from "../packages/repository-reference/index.js";
import sessionSummary from "../packages/session-summary/index.js";
import stats from "../packages/stats/index.js";
import subagents from "../packages/subagents/index.js";
import todos from "../packages/todos/index.js";
import usageMeter from "../packages/usage-meter/index.js";
import uv from "../packages/uv/index.js";
import webSearch from "../packages/web-search/index.js";
import workflowFinalization from "../packages/workflow-finalization/index.js";
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
  workflowFinalization,
  planMode,
  repositoryReference,
  notify,
  todos,
  contextSize,
  contextMode,
  codexCompaction,
  largePaste,
  modelCostBadges,
  stats,
  subagents,
  uv,
  workingIndicator,
  webSearch,
  usageMeter,
  sessionSummary,
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
        "subagent_dispatch",
        "subagent_status",
        "subagent_collect",
        "subagent_steer",
        "subagent_stop",
        "search",
        "repository_reference",
        "ctx_execute",
        "ctx_execute_file",
        "ctx_batch_execute",
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
      "./packages/grilling/skills",
    ]);
    expect(await readFile("packages/bro/skills/bro/SKILL.md", "utf8")).toContain("name: bro");
    expect(await readFile("packages/grilling/skills/grilling/SKILL.md", "utf8")).toContain(
      "name: grilling",
    );
    const grillMe = await readFile("packages/grilling/skills/grill-me/SKILL.md", "utf8");
    expect(grillMe).toContain("name: grill-me");
    expect(grillMe).toContain("disable-model-invocation: true");
  });

  it("links referenced third-party projects and their licenses", async () => {
    const notices = await readFile("THIRD_PARTY_NOTICES.md", "utf8");
    for (const url of [
      "https://github.com/github/copilot-sdk/tree/v1.0.9",
      "https://github.com/github/copilot-sdk/blob/v1.0.9/LICENSE",
      "https://github.com/github/copilot-cli/tree/v1.0.80",
      "https://github.com/github/copilot-cli/blob/v1.0.80/LICENSE.md",
      "https://github.com/openai/codex/commit/578c1b2230288104041e880a86d0f7f3a5ca6e47",
      "https://github.com/openai/codex/commit/1e85ca099e4265bf89f4016772d299816e231bb3",
      "https://github.com/openai/codex/commit/2b5bdcf67547860f2e5c5a605009a70026796b2b",
      "https://github.com/openai/codex/blob/main/LICENSE",
      "https://github.com/ogulcancelik/pi-extensions/commit/ca37adb6c8000f6a83c447b4a119657c7714bc94",
      "https://github.com/ogulcancelik/pi-extensions/blob/ca37adb6c8000f6a83c447b4a119657c7714bc94/packages/pi-codex-compaction/LICENSE",
      "https://github.com/badlogic/pi-skills",
      "https://github.com/badlogic/pi-skills/blob/main/LICENSE",
      "https://github.com/mitsuhiko/agent-stuff",
      "https://github.com/mitsuhiko/agent-stuff/blob/main/LICENSE",
      "https://github.com/ogulcancelik/pi-extensions",
      "https://github.com/ogulcancelik/pi-extensions/blob/main/LICENSE",
      "https://github.com/earendil-works/pi",
      "https://github.com/earendil-works/pi/blob/main/LICENSE",
      "https://github.com/mksglu/context-mode",
      "https://github.com/mksglu/context-mode/blob/v1.0.169/LICENSE",
    ])
      expect(notices).toContain(url);
  });

  it("keeps one portable offline repository guidance contract", async () => {
    const rootEntries = await readdir(".");
    const rootInstructionFiles = rootEntries
      .filter(
        (name) =>
          /^(?:(?:agents|claude|gemini|copilot)(?:\.[^.]+)?|instructions|rules)\.md$/i.test(name) ||
          name.toLowerCase() === ".cursorrules",
      )
      .sort();
    expect(rootEntries.filter((name) => name.toLowerCase() === "agents.md")).toEqual(["AGENTS.md"]);
    expect(rootInstructionFiles).toEqual(["AGENTS.md"]);

    const agentsBuffer = await readFile("AGENTS.md");
    expect(agentsBuffer.byteLength).toBeLessThan(32 * 1024);
    const agents = agentsBuffer.toString("utf8");
    expect(agents).toContain("Do not add a competing root instruction file");

    const guidance = new Map([
      ["AGENTS.md", agents],
      ["docs/development.md", await readFile("docs/development.md", "utf8")],
      ["docs/harnesses.md", await readFile("docs/harnesses.md", "utf8")],
    ]);
    const missingLinks: string[] = [];
    for (const [path, source] of guidance) {
      for (const match of source.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)) {
        const href = (match[1] ?? "").trim().replace(/^<|>$/g, "");
        if (/^(?:https?:|mailto:)/.test(href)) continue;
        const [rawTarget = "", rawFragment = ""] = href.split("#", 2);
        const target = decodeURIComponent(rawTarget.replace(/\?.*$/, ""));
        const targetPath = target ? resolve(dirname(path), target) : resolve(path);
        try {
          await access(targetPath);
        } catch {
          missingLinks.push(`${path} -> ${href}`);
          continue;
        }
        if (!rawFragment) continue;
        const targetSource = await readFile(targetPath, "utf8");
        const headingSlugs = new Set(
          [...targetSource.matchAll(/^#{1,6}\s+(.+?)\s*#*$/gm)].map((heading) =>
            (heading[1] ?? "")
              .replace(/[`*_~]/g, "")
              .toLowerCase()
              .replace(/[^a-z0-9\s-]/g, "")
              .trim()
              .replace(/\s+/g, "-"),
          ),
        );
        const fragment = decodeURIComponent(rawFragment).toLowerCase();
        if (!headingSlugs.has(fragment)) missingLinks.push(`${path} -> ${href} (missing heading)`);
      }
    }
    expect(missingLinks).toEqual([]);

    const harnesses = guidance.get("docs/harnesses.md") ?? "";
    for (const heading of [
      "## Implementation authority",
      "## Core references — mandatory relevance screening",
      "## Task-specific references — use when directly relevant",
      "## Optional references — candidates, not requirements or endorsements",
    ])
      expect(harnesses).toContain(heading);
    for (const url of [
      "https://github.com/anomalyco/opencode",
      "https://github.com/openai/codex",
      "https://github.com/can1357/oh-my-pi",
    ])
      expect(harnesses).toContain(url);
    const reviewDate = harnesses.match(/^Last reviewed: \*\*(\d{4}-\d{2}-\d{2})\*\*\.$/m)?.[1];
    expect(reviewDate).toBeDefined();
    if (reviewDate)
      expect(new Date(`${reviewDate}T00:00:00Z`).toISOString().slice(0, 10)).toBe(reviewDate);

    const notices = await readFile("THIRD_PARTY_NOTICES.md", "utf8");
    for (const url of [
      "https://github.com/anomalyco/opencode",
      "https://github.com/anomalyco/opencode/blob/dev/LICENSE",
      "https://github.com/can1357/oh-my-pi",
      "https://github.com/can1357/oh-my-pi/blob/main/LICENSE",
    ])
      expect(notices).toContain(url);

    const manifest = JSON.parse(await readFile("package.json", "utf8")) as {
      scripts?: Record<string, string>;
    };
    expect(manifest.scripts?.["lint:docs"]).toMatch(/(?:^|\s)AGENTS\.md(?:\s|$)/);
  });

  it("documents the Subagents v2 configuration and orchestration contract", async () => {
    for (const path of ["README.md", "docs/configuration.md", "packages/subagents/README.md"]) {
      const source = await readFile(path, "utf8");
      for (const expected of [
        "~/.pi/agent/subagents/config.json",
        '"schemaVersion": 2',
        '"thinking": "low"',
        '"thinking": "high"',
      ])
        expect(source, `${path} must contain ${expected}`).toContain(expected);
      expect(source, `${path} must contain a Luna provider model`).toMatch(
        /(?:github-copilot|openai-codex)\/gpt-5\.6-luna/,
      );
    }
    const configuration = await readFile("docs/configuration.md", "utf8");
    expect(configuration).toContain("openai-codex/gpt-5.6-luna");
    expect(configuration).toContain("copilot login");
    const skill = await readFile(
      "packages/subagents/skills/subagent-orchestration/SKILL.md",
      "utf8",
    );
    for (const tool of ["subagent_dispatch", "subagent_status", "subagent_collect"])
      expect(skill).toContain(tool);
    expect(skill).not.toContain("subagent_spawn");
    expect(skill).not.toContain("subagent_list");
    const command = await readFile("packages/subagents/agents-command.ts", "utf8");
    expect(command).toContain('operation === "doctor"');
    expect(command).toContain("effectivePolicy");
  });

  it("has no lifecycle install scripts and only reviewed production dependencies", async () => {
    const manifest = JSON.parse(await readFile("package.json", "utf8")) as {
      dependencies?: object;
      engines?: { node?: string };
      scripts?: Record<string, string>;
    };
    expect(manifest.engines?.node).toBe(">=22.12.0");
    expect(manifest.dependencies).toEqual({
      "@github/copilot-sdk": "1.0.9",
    });
    for (const name of ["preinstall", "install", "postinstall", "prepare"])
      expect(manifest.scripts?.[name]).toBeUndefined();
  });
});
