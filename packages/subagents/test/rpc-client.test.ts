import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { RpcClient } from "../rpc-client.js";

function processDouble(): {
  child: ChildProcessWithoutNullStreams;
  stdout: PassThrough;
} {
  const stdout = new PassThrough();
  return {
    child: {
      stdin: new PassThrough(),
      stdout,
      stderr: new PassThrough(),
    } as unknown as ChildProcessWithoutNullStreams,
    stdout,
  };
}

describe("RpcClient", () => {
  it("parses object frames and rejects malformed stdout instead of hanging", () => {
    const { child, stdout } = processDouble();
    const onEvent = vi.fn();
    const onProtocolError = vi.fn();
    new RpcClient(child, onEvent, onProtocolError);

    stdout.write('{"type":"agent_settled"}\n');
    stdout.write("startup diagnostic\n");
    stdout.write("[]\n");

    expect(onEvent).toHaveBeenCalledWith({ type: "agent_settled" });
    expect(onProtocolError).toHaveBeenCalledTimes(2);
    expect(onProtocolError.mock.calls[0]?.[0]).toBeInstanceOf(Error);
  });

  it("rejects an oversized unterminated frame", () => {
    const { child, stdout } = processDouble();
    const onProtocolError = vi.fn();
    new RpcClient(child, vi.fn(), onProtocolError);
    stdout.write("x".repeat(4 * 1024 * 1024 + 1));
    expect(onProtocolError).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining("oversized") }),
    );
  });
});
