import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

export type HerdrExec = (
  args: string[],
  timeout?: number,
) => Promise<{ stdout: string; stderr: string }>;

type HerdrError = Error & { stderr?: string | Buffer };

const SHELL_READY_TIMEOUT_MS = 5_000;
const SHELL_RETRY_DELAY_MS = 100;

function unavailableShell(cause: unknown): boolean {
  if (!(cause instanceof Error)) return false;
  const stderr = (cause as HerdrError).stderr;
  const text = `${cause.message}\n${Buffer.isBuffer(stderr) ? stderr.toString() : (stderr ?? "")}`;
  return /agent_pane_busy|not an available shell/iu.test(text);
}

function defaultExec(
  args: string[],
  timeout = 30_000,
): Promise<{ stdout: string; stderr: string }> {
  return execFile("herdr", args, { timeout, maxBuffer: 1024 * 1024 }).then(
    ({ stdout, stderr }) => ({ stdout, stderr }),
  );
}

function paneId(output: string): string {
  try {
    // Herdr emits a JSON RPC envelope: { result: { pane: { pane_id } } }.
    const value = JSON.parse(output) as {
      id?: unknown;
      pane?: { id?: unknown; pane_id?: unknown };
      result?: { pane?: { id?: unknown; pane_id?: unknown } };
    };
    const id =
      value.result?.pane?.pane_id ??
      value.result?.pane?.id ??
      value.pane?.pane_id ??
      value.pane?.id ??
      value.id;
    if (typeof id === "string" && id) return id;
  } catch {
    /* Older Herdr versions may emit a human-readable response. */
  }
  const match =
    output.match(/(?:created\s+pane|pane(?:\s+id)?)\s*[:#]?\s*([\w:-]+)/iu) ??
    output.match(/\b([\w:-]{8,})\b/u);
  if (!match?.[1])
    throw new Error(`Herdr did not return a pane id: ${output.trim() || "(empty response)"}`);
  return match[1];
}

/** Thin, testable control-plane wrapper.  Child transcripts remain owned by Pi session JSONL. */
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
        // A freshly split pane can be returned before its interactive shell owns the foreground.
        // Herdr rejects that transient state immediately rather than applying --timeout to it.
        if (!unavailableShell(cause) || Date.now() >= deadline) throw cause;
        await this.delay(SHELL_RETRY_DELAY_MS);
      }
    }
  }

  /** Submit immediately; lifecycle observation is intentionally separate. */
  async prompt(target: string, text: string): Promise<void> {
    await this.run(["agent", "prompt", target, text]);
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
}
