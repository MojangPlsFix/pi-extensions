import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const cleanup: string[] = [];
const runner = fileURLToPath(new URL("../inspector-runner.mjs", import.meta.url));
const terminalEscape = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x1b\x07]*(?:\x07|\x1b\\))/gu;
const unsafeControl = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\p{Cf}]/gu;

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => fs.rm(path, { recursive: true, force: true })));
});

function plainOutput(output: string): string {
  return output.replace(terminalEscape, "").replace(unsafeControl, " ");
}

function waitForOutput(read: () => string, expected: string, timeoutMs = 15_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const timer = setInterval(() => {
      if (read().includes(expected)) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() >= deadline) {
        clearInterval(timer);
        reject(new Error(`Timed out waiting for inspector output: ${expected}`));
      }
    }, 20);
  });
}

describe("display-only transcript runner", () => {
  it("renders native-style prose/tools, sanitizes transcript strings, and follows appended JSONL", async () => {
    const directory = await fs.mkdtemp(join(tmpdir(), "subagent-inspector-runner-"));
    cleanup.push(directory);
    const sessionFile = join(directory, "session.jsonl");
    await fs.writeFile(
      sessionFile,
      `${[
        "not-json",
        JSON.stringify({
          type: "message",
          timestamp: "2026-01-01T12:34:56.000Z",
          message: {
            role: "assistant\u001b]0;forged-title\u0007",
            stopReason: "stop",
            content: [
              { type: "text", text: "# Plan\n- item one" },
              { type: "thinking", thinking: "safe \u001b[31mthinking\u001b[0m\u202ereversed" },
              {
                type: "toolCall",
                id: "call-read-1",
                name: "read",
                arguments: {
                  path: "src/example.ts\u001b]52;c;payload\u0007",
                  offset: 1,
                  limit: 20,
                },
              },
            ],
          },
        }),
        JSON.stringify({
          type: "message",
          timestamp: "2026-01-01T12:34:57.000Z",
          message: {
            role: "toolResult",
            toolCallId: "call-read-1",
            toolName: "read",
            content: [{ type: "text", text: "const value = 42;\u001b[31m" }],
            details: { noisy: "NOISY_DETAILS", truncated: false },
            isError: false,
          },
        }),
        JSON.stringify({
          type: "message",
          timestamp: "2026-01-01T12:34:58.000Z",
          message: {
            role: "toolResult",
            toolCallId: "missing-call",
            toolName: "custom_tool",
            content: [{ type: "text", text: "fallback output" }],
            details: { noisy: "NOISY_ORPHAN" },
            isError: false,
          },
        }),
        JSON.stringify({
          type: "message",
          timestamp: "2026-01-01T12:34:59.000Z",
          message: {
            role: "assistant",
            stopReason: "length",
            content: [{ type: "text", text: "Partial answer" }],
          },
        }),
      ].join("\n")}
`,
    );

    const child = spawn(process.execPath, [runner, sessionFile, "4096", directory, "dark"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    try {
      await waitForOutput(() => plainOutput(stdout), "Display-only mirror");
      await waitForOutput(() => plainOutput(stdout), "requested theme dark");
      await waitForOutput(() => plainOutput(stdout), "Plan");
      await waitForOutput(() => plainOutput(stdout), "item one");
      await waitForOutput(() => plainOutput(stdout), "safe thinking reversed");
      await waitForOutput(() => plainOutput(stdout), "src/example.ts");
      await waitForOutput(() => plainOutput(stdout), "const value = 42;");
      await waitForOutput(() => plainOutput(stdout), "read");
      await waitForOutput(() => plainOutput(stdout), "custom_tool");
      await waitForOutput(() => plainOutput(stdout), "fallback output");
      await waitForOutput(() => plainOutput(stdout), "Response was truncated before completion.");
      expect(plainOutput(stdout)).not.toContain("NOISY_DETAILS");
      expect(plainOutput(stdout)).not.toContain("NOISY_ORPHAN");
      expect(plainOutput(stdout)).not.toContain("details:");
      await fs.appendFile(
        sessionFile,
        `${JSON.stringify({
          type: "message",
          message: {
            role: "user",
            content: [{ type: "text", text: "appended **markdown** line" }],
          },
        })}\n`,
      );
      await waitForOutput(() => plainOutput(stdout), "appended markdown line");
      expect(stdout).not.toContain("\u001b]0;forged-title");
      expect(stdout).not.toContain("\u001b]52");
      expect(stdout).not.toContain("\u202e");
      expect(stderr).toBe("");
    } finally {
      child.kill("SIGTERM");
      await new Promise<void>((resolve) => child.once("close", () => resolve()));
    }
  }, 30_000);

  it("applies pre-render safety budgets, compacts oversized entries, and keeps following", async () => {
    const directory = await fs.mkdtemp(join(tmpdir(), "subagent-inspector-runner-"));
    cleanup.push(directory);
    const sessionFile = join(directory, "session.jsonl");
    const manyParts = Array.from({ length: 300 }, (_, index) => ({
      type: "text",
      text: `chunk-${index}`,
    }));
    const hugeLine = JSON.stringify({
      type: "message",
      timestamp: "2026-01-01T13:00:01.000Z",
      message: {
        role: "assistant",
        stopReason: "stop",
        content: [{ type: "text", text: "x".repeat(180_000) }],
      },
    });
    await fs.writeFile(
      sessionFile,
      `${JSON.stringify({
        type: "message",
        timestamp: "2026-01-01T13:00:00.000Z",
        message: {
          role: "assistant",
          stopReason: "stop",
          content: manyParts,
        },
      })}\n`,
    );

    const child = spawn(process.execPath, [runner, sessionFile, "250000", directory, "dark"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });

    try {
      await waitForOutput(() => plainOutput(stdout), "more content parts omitted for safety");
      expect(plainOutput(stdout)).not.toContain("chunk-299");

      await fs.appendFile(sessionFile, `${hugeLine}\n`);
      await waitForOutput(() => plainOutput(stdout), "entry skipped:");

      await fs.appendFile(
        sessionFile,
        `${JSON.stringify({
          type: "message",
          timestamp: "2026-01-01T13:00:02.000Z",
          message: {
            role: "user",
            content: [{ type: "text", text: "still following after oversized entry" }],
          },
        })}\n`,
      );
      await waitForOutput(() => plainOutput(stdout), "still following after oversized entry");
    } finally {
      child.kill("SIGTERM");
      await new Promise<void>((resolve) => child.once("close", () => resolve()));
    }
  }, 30_000);

  it("keeps truncation byte-safe for tiny limits and reports requested (possibly invalid) theme", async () => {
    const trimModule = (await import(new URL("../inspector-runner.mjs", import.meta.url).href)) as {
      trimToBytes: (value: string, limit: number, suffix?: string) => string;
    };
    const trim = trimModule.trimToBytes;
    expect(trim("abcdef", 0, "XYZ")).toBe("");
    expect(trim("abcdef", 1, "XYZ")).toBe("X");
    expect(trim("abcdef", 2, "XYZ")).toBe("XY");
    expect(trim("abcdef", 5, "XYZ")).toBe("abXYZ");
    expect(Buffer.byteLength(trim("abcdef", 2, "XYZ"), "utf8")).toBeLessThanOrEqual(2);

    const directory = await fs.mkdtemp(join(tmpdir(), "subagent-inspector-runner-"));
    cleanup.push(directory);
    const sessionFile = join(directory, "session.jsonl");
    await fs.writeFile(
      sessionFile,
      `${JSON.stringify({
        type: "message",
        timestamp: "2026-01-01T13:10:00.000Z",
        message: {
          role: "assistant",
          stopReason: "stop",
          content: [{ type: "text", text: "theme fallback still renders content" }],
        },
      })}\n`,
    );

    const child = spawn(
      process.execPath,
      [runner, sessionFile, "4096", directory, "invalid-theme"],
      {
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    try {
      await waitForOutput(() => plainOutput(stdout), "requested theme invalid-theme");
      await waitForOutput(() => plainOutput(stdout), "theme fallback still renders content");
      expect(stderr).toBe("");
    } finally {
      child.kill("SIGTERM");
      await new Promise<void>((resolve) => child.once("close", () => resolve()));
    }
  }, 30_000);
});
