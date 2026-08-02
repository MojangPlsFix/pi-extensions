import type { ChildProcessWithoutNullStreams } from "node:child_process";

export type RpcEvent = {
  type?: string;
  message?: { role?: string; content?: unknown; usage?: unknown };
  data?: { sessionFile?: string };
  error?: { message?: string };
};

/** Strict JSONL client for Pi RPC children. */
export class RpcClient {
  private buffer = "";

  constructor(
    private readonly process: ChildProcessWithoutNullStreams,
    private readonly onEvent: (event: RpcEvent) => void,
  ) {
    process.stdout.on("data", (chunk) => this.consume(chunk.toString("utf8")));
  }

  prompt(id: string, message: string, streamingBehavior?: "followUp" | "steer"): void {
    this.send({ id, type: "prompt", message, ...(streamingBehavior ? { streamingBehavior } : {}) });
  }

  abort(): void {
    this.send({ type: "abort" });
  }

  private send(frame: object): void {
    if (this.process.stdin.destroyed || !this.process.stdin.writable)
      throw new Error("Cannot communicate with a closed RPC child process.");
    this.process.stdin.write(`${JSON.stringify(frame)}\n`);
  }

  private consume(chunk: string): void {
    this.buffer += chunk;
    let newline: number;
    while ((newline = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, newline).replace(/\r$/u, "");
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      try {
        this.onEvent(JSON.parse(line) as RpcEvent);
      } catch {
        /* Child diagnostics are not RPC events. */
      }
    }
  }
}
