import { promises as fs } from "node:fs";
import { join } from "node:path";
import { AGENT_DIR } from "./config.js";
import type { AgentDefinition } from "./types.js";

const builtins: AgentDefinition[] = [
  {
    name: "explorer",
    description:
      "Read-only investigator for code, documentation, architecture, and current web research.",
    mode: "explorer",
    prompt:
      "Investigate the delegated task carefully and return concise evidence, exact paths, source URLs where relevant, and recommended next steps.",
    source: "builtin",
  },
  {
    name: "worker",
    description: "Focused implementation agent that may modify the shared working tree.",
    mode: "worker",
    prompt:
      "Implement only the delegated scope. Preserve unrelated work, validate your changes, and report exact files and commands.",
    source: "builtin",
  },
];

export function safeName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function parseFrontmatter(source: string, _file: string): AgentDefinition | undefined {
  const match = /^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/u.exec(source);
  if (!match) return undefined;
  const fields = new Map<string, string>();
  for (const line of match[1]!.split("\n")) {
    const field = /^([A-Za-z][\w-]*):\s*(.*?)\s*$/u.exec(line);
    if (field) fields.set(field[1]!, field[2]!.replace(/^['"]|['"]$/g, ""));
  }
  const name = safeName(fields.get("name") ?? "");
  const description = fields.get("description")?.trim() ?? "";
  const mode = fields.get("mode") ?? "explorer";
  const thinking = fields.get("thinking");
  if (!name || !description || (mode !== "explorer" && mode !== "worker")) return undefined;
  if (thinking && !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(thinking))
    return undefined;
  return {
    name,
    description,
    mode,
    model: fields.get("model"),
    thinking,
    prompt: match[2]!.trim(),
    source: "user",
  };
}

export async function discoverAgents(): Promise<AgentDefinition[]> {
  let names: string[];
  try {
    names = await fs.readdir(AGENT_DIR);
  } catch {
    return builtins;
  }
  const custom: AgentDefinition[] = [];
  for (const name of names.filter((entry) => entry.endsWith(".md")).sort()) {
    try {
      const agent = parseFrontmatter(await fs.readFile(join(AGENT_DIR, name), "utf8"), name);
      if (
        agent &&
        !builtins.some((builtin) => builtin.name === agent.name) &&
        !custom.some((item) => item.name === agent.name)
      )
        custom.push(agent);
    } catch {
      /* Ignore invalid trusted user definitions. */
    }
  }
  return [...builtins, ...custom];
}
