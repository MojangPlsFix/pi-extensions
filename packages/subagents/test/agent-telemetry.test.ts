import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  consumeRpcTelemetry,
  consumeSessionRecord,
  recordActivity,
  SessionPoller,
} from "../agent-telemetry.js";
import { emptyUsage, type ManagedAgent } from "../types.js";

const temporaryDirectories: string[] = [];

function agent(sessionDir = "/tmp/session"): ManagedAgent {
  return {
    id: "agent",
    name: "explorer",
    definition: {
      name: "explorer",
      description: "test",
      mode: "explorer",
      prompt: "test",
      source: "builtin",
    },
    task: "test",
    taskHistory: ["test"],
    status: "running",
    backend: "rpc",
    startedAt: "2026-01-01T00:00:00.000Z",
    sessionDir,
    stderr: "",
    output: "",
    usage: emptyUsage(),
    completionReported: false,
    activity: [],
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

describe("agent telemetry", () => {
  it("records effective settings, reports, tool activity, and usage", () => {
    const subject = agent();
    consumeSessionRecord(subject, {
      type: "model_change",
      provider: "provider",
      modelId: "model",
    });
    consumeSessionRecord(subject, {
      type: "thinking_level_change",
      thinkingLevel: "high",
    });
    expect(
      consumeSessionRecord(subject, {
        type: "message",
        timestamp: "2026-01-01T00:00:01.000Z",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "hidden" },
            { type: "text", text: "final report" },
          ],
          usage: { input: 7, output: 3, totalTokens: 10, cost: { total: 0.25 } },
        },
      }),
    ).toBe(true);
    consumeSessionRecord(subject, {
      type: "message",
      timestamp: "2026-01-01T00:00:02.000Z",
      message: { role: "toolResult", toolName: "read" },
    });

    expect(subject.effectiveModel).toBe("provider/model");
    expect(subject.effectiveThinking).toBe("high");
    expect(subject.output).toBe("final report");
    expect(subject.usage).toMatchObject({ input: 7, output: 3, total: 10, cost: 0.25 });
    expect(subject.activity).toEqual([
      { at: "2026-01-01T00:00:01.000Z", kind: "message", text: "final report" },
      { at: "2026-01-01T00:00:02.000Z", kind: "tool", text: "used read" },
    ]);
  });

  it("uses RPC events as the direct usage and session-file authority", () => {
    const subject = agent();
    consumeRpcTelemetry(subject, {
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "RPC report" }],
        usage: { input: 4, totalTokens: 4 },
      },
    });
    consumeRpcTelemetry(subject, {
      type: "response",
      data: { sessionFile: "/tmp/session/child.jsonl" },
    });

    expect(subject.output).toBe("RPC report");
    expect(subject.usage.total).toBe(4);
    expect(subject.sessionFile).toBe("/tmp/session/child.jsonl");
    expect(subject.activity.at(-1)?.text).toBe("RPC report");
  });

  it("bounds activity history to the latest 24 observations", () => {
    const subject = agent();
    for (let index = 0; index < 30; index++)
      recordActivity(subject, "status", `event ${index}`, `time ${index}`);

    expect(subject.activity).toHaveLength(24);
    expect(subject.activity[0]?.text).toBe("event 6");
    expect(subject.activity.at(-1)?.text).toBe("event 29");
  });

  it("incrementally follows partial session records and tracks prompt boundaries", async () => {
    const directory = await fs.mkdtemp(join(tmpdir(), "subagent-telemetry-"));
    temporaryDirectories.push(directory);
    const nested = join(directory, "nested");
    await fs.mkdir(nested);
    const sessionFile = join(nested, "child.jsonl");
    await fs.writeFile(sessionFile, '{"type":"message","message":');
    const subject = agent(directory);
    const onUpdate = vi.fn();
    const poller = new SessionPoller(subject, onUpdate, false);

    await poller.pollOnce();
    expect(poller.hasAssistantSincePrompt()).toBe(false);
    await fs.appendFile(
      sessionFile,
      '{"role":"assistant","content":[{"type":"text","text":"done"}],"usage":{"totalTokens":9}}}\n',
    );
    await poller.pollOnce();

    expect(subject.sessionFile).toBe(sessionFile);
    expect(subject.output).toBe("done");
    expect(subject.usage.total).toBe(0);
    expect(poller.hasAssistantSincePrompt()).toBe(true);
    expect(onUpdate).toHaveBeenCalledTimes(2);
    poller.resetPromptBoundary();
    expect(poller.hasAssistantSincePrompt()).toBe(false);
  });
});
