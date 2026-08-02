import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

export type HerdrExec = (
  args: string[],
  timeout?: number,
) => Promise<{ stdout: string; stderr: string }>;

export type HerdrPaneRect = { x: number; y: number; width: number; height: number };
export type HerdrPaneLayout = {
  tabId: string;
  panes: Array<{ paneId: string; rect: HerdrPaneRect }>;
};
export type HerdrTab = { tabId: string; paneId: string };
export type HerdrPaneMetadata = {
  agent: string;
  title: string;
  displayRole: string;
  stateLabels: Record<string, string>;
  tokens: Record<string, string>;
  seq: number;
};

type HerdrError = Error & { stderr?: string | Buffer };
type JsonRecord = Record<string, unknown>;

const SHELL_READY_TIMEOUT_MS = 5_000;
const SHELL_RETRY_DELAY_MS = 100;
export const HERDR_METADATA_SOURCE = "pi-subagents";

function errorText(cause: unknown): string {
  if (!(cause instanceof Error)) return String(cause);
  const stderr = (cause as HerdrError).stderr;
  return `${cause.message}\n${Buffer.isBuffer(stderr) ? stderr.toString() : (stderr ?? "")}`;
}

function unavailableShell(cause: unknown): boolean {
  return /agent_pane_busy|not an available shell/iu.test(errorText(cause));
}

/** Errors that mean a pane was removed outside this extension are terminal, not retryable. */
export function isMissingHerdrPane(cause: unknown): boolean {
  return /(?:pane|tab)(?:_|\s|-)*(?:not[_ -]?found|missing|unknown)|(?:no|unknown) (?:such )?(?:pane|tab)/iu.test(
    errorText(cause),
  );
}

/** Older control planes do not expose the geometry-rich pane.layout call. */
export function isHerdrLayoutUnavailable(cause: unknown): boolean {
  return /(?:method|command|subcommand).*(?:not found|unknown|unrecognized|unsupported)|(?:not found|unknown|unrecognized|unsupported).*(?:pane[._ -]?layout|\blayout\b)|unsupported_method|method_not_found/iu.test(
    errorText(cause),
  );
}

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

function paneId(output: string): string {
  const value = jsonObject(output);
  const result = member(value, "result");
  const pane = member(result, "pane") ?? member(value, "pane");
  const id = stringMember(pane, "pane_id", "id") ?? stringMember(result, "pane_id", "id");
  if (id) return id;
  const match =
    output.match(/(?:created\s+pane|pane(?:\s+id)?)\s*[:#]?\s*([\w:-]+)/iu) ??
    output.match(/\b([\w:-]{8,})\b/u);
  if (!match?.[1])
    throw new Error(`Herdr did not return a pane id: ${output.trim() || "(empty response)"}`);
  return match[1];
}

function createdTab(output: string): HerdrTab {
  const value = jsonObject(output);
  const result = member(value, "result");
  const tab = member(result, "tab") ?? member(value, "tab");
  const rootPane =
    member(result, "root_pane") ?? member(result, "pane") ?? member(value, "root_pane");
  const tabId = stringMember(tab, "tab_id", "id") ?? stringMember(result, "tab_id");
  const rootPaneId =
    stringMember(rootPane, "pane_id", "id") ?? stringMember(result, "root_pane_id", "pane_id");
  if (tabId && rootPaneId) return { tabId, paneId: rootPaneId };
  throw new Error(
    `Herdr did not return a tab and root pane id: ${output.trim() || "(empty response)"}`,
  );
}

function paneLayout(output: string): HerdrPaneLayout {
  const value = jsonObject(output);
  const result = member(value, "result") ?? value;
  const layout = member(result, "layout") ?? member(value, "layout");
  const tabId = stringMember(layout, "tab_id", "tabId");
  const rawPanes = member(layout, "panes");
  if (!tabId || !Array.isArray(rawPanes))
    throw new Error("Herdr returned an unsupported pane layout response.");
  const panes = rawPanes.flatMap((raw) => {
    const id = stringMember(raw, "pane_id", "paneId", "id");
    const rect = member(raw, "rect");
    const x = member(rect, "x");
    const y = member(rect, "y");
    const width = member(rect, "width");
    const height = member(rect, "height");
    return id &&
      typeof x === "number" &&
      typeof y === "number" &&
      typeof width === "number" &&
      typeof height === "number"
      ? [{ paneId: id, rect: { x, y, width, height } }]
      : [];
  });
  if (panes.length !== rawPanes.length)
    throw new Error("Herdr returned unsupported pane layout geometry.");
  return { tabId, panes };
}

/** Thin, testable control-plane wrapper. Child transcripts remain owned by Pi session JSONL. */
export class HerdrClient {
  constructor(
    private readonly run: HerdrExec = defaultExec,
    private readonly delay: (ms: number) => Promise<void> = (ms) =>
      new Promise((resolve) => setTimeout(resolve, ms)),
  ) {}

  /**
   * Detection never starts a Herdr process. A complete environment still needs
   * `verify()` before attached panes are selected.
   */
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

  static isEnvironment(env: NodeJS.ProcessEnv = process.env): boolean {
    return HerdrClient.environmentState(env) === "complete";
  }

  async verify(parentPaneId: string): Promise<void> {
    await this.run(["pane", "current", "--pane", parentPaneId], 5_000);
  }

  async createTab(label: string, cwd: string, env: Record<string, string> = {}): Promise<HerdrTab> {
    const environment = Object.entries(env).flatMap(([key, value]) => ["--env", `${key}=${value}`]);
    const { stdout } = await this.run([
      "tab",
      "create",
      "--label",
      label,
      "--cwd",
      cwd,
      ...environment,
      "--no-focus",
    ]);
    return createdTab(stdout);
  }

  async split(
    parentPaneId: string,
    direction: "right" | "down",
    cwd: string,
    env: Record<string, string> = {},
  ): Promise<string> {
    const environment = Object.entries(env).flatMap(([key, value]) => ["--env", `${key}=${value}`]);
    const { stdout } = await this.run([
      "pane",
      "split",
      parentPaneId,
      "--direction",
      direction,
      "--ratio",
      "0.5",
      "--cwd",
      cwd,
      ...environment,
      "--no-focus",
    ]);
    return paneId(stdout);
  }

  async layout(pane: string): Promise<HerdrPaneLayout> {
    const { stdout } = await this.run(["pane", "layout", "--pane", pane], 5_000);
    return paneLayout(stdout);
  }

  async reportMetadata(pane: string, metadata: HerdrPaneMetadata): Promise<void> {
    const stateLabels = Object.entries(metadata.stateLabels).flatMap(([state, label]) => [
      "--state-label",
      `${state}=${label}`,
    ]);
    const tokens = Object.entries(metadata.tokens).flatMap(([name, value]) => [
      "--token",
      `${name}=${value}`,
    ]);
    await this.run([
      "pane",
      "report-metadata",
      pane,
      "--source",
      HERDR_METADATA_SOURCE,
      "--agent",
      metadata.agent,
      "--title",
      metadata.title,
      "--display-agent",
      metadata.displayRole,
      ...stateLabels,
      ...tokens,
      "--seq",
      String(metadata.seq),
    ]);
  }

  async start(name: string, pane: string, args: string[]): Promise<void> {
    const command = [
      "agent",
      "start",
      name,
      "--kind",
      "pi",
      "--pane",
      pane,
      "--timeout",
      "30000",
      "--",
      ...args,
    ];
    const deadline = Date.now() + SHELL_READY_TIMEOUT_MS;
    for (;;) {
      try {
        await this.run(command);
        return;
      } catch (cause) {
        if (!unavailableShell(cause) || Date.now() >= deadline) throw cause;
        await this.delay(SHELL_RETRY_DELAY_MS);
      }
    }
  }

  /** Submit immediately; lifecycle observation is intentionally separate. */
  async prompt(target: string, text: string): Promise<void> {
    await this.run(["agent", "prompt", target, text]);
  }
  async focus(target: string): Promise<void> {
    // Pane ids are Herdr's canonical internal targets; display names and task titles are not unique.
    await this.run(["agent", "focus", target]);
  }
  async interrupt(target: string): Promise<void> {
    await this.run(["agent", "send-keys", target, "escape"]);
  }
  async waitForWorking(target: string): Promise<void> {
    await this.run(["agent", "wait", target, "--until", "working"]);
  }
  async wait(target: string, timeout = 0): Promise<void> {
    const args = ["agent", "wait", target, "--until", "idle", "--until", "done"];
    if (timeout > 0) args.push("--timeout", String(timeout));
    await this.run(args, timeout || undefined);
  }
  async close(pane: string): Promise<void> {
    await this.run(["pane", "close", pane], 10_000);
  }
  async closeTab(tab: string): Promise<void> {
    await this.run(["tab", "close", tab], 10_000);
  }
}
