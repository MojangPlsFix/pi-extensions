import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

export type HerdrExec = (
  args: string[],
  timeout?: number,
) => Promise<{ stdout: string; stderr: string }>;

export type HerdrPaneContext = {
  paneId: string;
  tabId: string;
  workspaceId: string;
};

type JsonRecord = Record<string, unknown>;

function defaultExec(
  args: string[],
  timeout = 30_000,
): Promise<{ stdout: string; stderr: string }> {
  return execFile("herdr", args, { timeout, maxBuffer: 1024 * 1024 }).then(
    ({ stdout, stderr }) => ({ stdout, stderr }),
  );
}

function jsonObject(output: string): JsonRecord | undefined {
  try {
    const value: unknown = JSON.parse(output);
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as JsonRecord)
      : undefined;
  } catch {
    return undefined;
  }
}

function member(value: unknown, key: string): unknown {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)[key]
    : undefined;
}

function stringMember(value: unknown, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const candidate = member(value, key);
    if (typeof candidate === "string" && candidate) return candidate;
  }
  return undefined;
}

function parsePaneId(output: string): string {
  const value = jsonObject(output);
  const result = member(value, "result");
  const pane = member(result, "pane") ?? member(value, "pane");
  const id = stringMember(pane, "pane_id", "paneId", "id") ?? stringMember(result, "pane_id", "id");
  if (id) return id;
  const match =
    output.match(/(?:created\s+pane|pane(?:\s+id)?)\s*[:#]?\s*([\w:-]+)/iu) ??
    output.match(/\b([\w:-]{8,})\b/u);
  if (!match?.[1])
    throw new Error(`Herdr did not return a pane id: ${output.trim() || "(empty response)"}`);
  return match[1];
}

function parsePaneContext(output: string): HerdrPaneContext {
  const value = jsonObject(output);
  const result = member(value, "result");
  const pane = member(result, "pane") ?? member(value, "pane");
  const paneId = stringMember(pane, "pane_id", "paneId", "id");
  const tabId = stringMember(pane, "tab_id", "tabId");
  const workspaceId = stringMember(pane, "workspace_id", "workspaceId");
  if (paneId && tabId && workspaceId) return { paneId, tabId, workspaceId };
  throw new Error(
    `Herdr did not return the parent pane context: ${output.trim() || "(empty response)"}`,
  );
}

/** Display-only Herdr control-plane wrapper. It never starts or prompts a child agent. */
export class HerdrClient {
  constructor(private readonly run: HerdrExec = defaultExec) {}

  static environmentState(
    env: NodeJS.ProcessEnv = process.env,
  ): "absent" | "incomplete" | "complete" {
    const explicit =
      env.HERDR_ENV === "1" || Boolean(env.HERDR_PANE_ID) || Boolean(env.HERDR_SOCKET_PATH);
    if (!explicit) return "absent";
    return env.HERDR_ENV === "1" && env.HERDR_PANE_ID && env.HERDR_SOCKET_PATH
      ? "complete"
      : "incomplete";
  }

  async verify(parentPaneId: string): Promise<HerdrPaneContext> {
    const { stdout } = await this.run(["pane", "current", "--pane", parentPaneId], 5_000);
    return parsePaneContext(stdout);
  }

  async splitCurrent(direction: "right" | "down", cwd: string, focus = false): Promise<string> {
    const { stdout } = await this.run([
      "pane",
      "split",
      "--current",
      "--direction",
      direction,
      "--cwd",
      cwd,
      focus ? "--focus" : "--no-focus",
    ]);
    return parsePaneId(stdout);
  }

  /** Run the package-owned transcript renderer in a raw pane, never in an agent pane. */
  async runInPane(pane: string, command: string): Promise<void> {
    await this.run(["pane", "run", pane, command], 15_000);
  }

  async close(pane: string): Promise<void> {
    await this.run(["pane", "close", pane], 10_000);
  }
}
