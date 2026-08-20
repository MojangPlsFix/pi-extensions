import type { ChildProcessWithoutNullStreams } from "node:child_process";

export type RpcEvent = {
  id?: string;
  type?: string;
  command?: string;
  success?: boolean;
  message?: { role?: string; content?: unknown; usage?: unknown };
  assistantMessageEvent?: { type?: string; delta?: string };
  toolName?: string;
  partialResult?: unknown;
  isError?: boolean;
  data?: { sessionFile?: string; [key: string]: unknown };
  error?: string | { message?: string };
};

/** Strict JSONL client for a directly spawned Pi RPC child. */
export class RpcClient {
  private static readonly maxBufferedFrameBytes = 4 * 1024 * 1024;
  private buffer = "";

  constructor(
    private readonly process: ChildProcessWithoutNullStreams,
    private readonly onEvent: (event: RpcEvent) => void,
    private readonly onProtocolError: (error: Error) => void = () => {},
  ) {
    process.stdout.on("data", (chunk) => this.consume(chunk.toString("utf8")));
  }

  prompt(id: string, message: string, streamingBehavior?: "followUp" | "steer"): void {
    this.send({ id, type: "prompt", message, ...(streamingBehavior ? { streamingBehavior } : {}) });
  }

  steer(id: string, message: string): void {
    this.send({ id, type: "steer", message });
  }

  followUp(id: string, message: string): void {
    this.send({ id, type: "follow_up", message });
  }

  getState(id: string): void {
    this.send({ id, type: "get_state" });
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
    if (Buffer.byteLength(this.buffer, "utf8") > RpcClient.maxBufferedFrameBytes) {
      this.buffer = "";
      this.onProtocolError(new Error("RPC child emitted an oversized JSONL frame."));
      return;
    }
    let newline: number;
    while ((newline = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, newline).replace(/\r$/u, "");
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      try {
        const parsed: unknown = JSON.parse(line);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
          throw new Error("RPC frame must be a JSON object.");
        this.onEvent(parsed as RpcEvent);
      } catch (cause) {
        this.onProtocolError(
          new Error(
            `RPC child emitted malformed JSONL: ${cause instanceof Error ? cause.message : String(cause)}`,
          ),
        );
      }
    }
  }
}
