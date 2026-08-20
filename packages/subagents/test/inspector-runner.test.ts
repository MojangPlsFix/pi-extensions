import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const cleanup: string[] = [];
const runner = fileURLToPath(new URL("../inspector-runner.mjs", import.meta.url));

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => fs.rm(path, { recursive: true, force: true })));
});

function waitForOutput(read: () => string, expected: string, timeoutMs = 3_000): Promise<void> {
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
  it("follows appended JSONL while stripping transcript terminal controls", async () => {
    const directory = await fs.mkdtemp(join(tmpdir(), "subagent-inspector-runner-"));
    cleanup.push(directory);
    const sessionFile = join(directory, "session.jsonl");
    const first = {
      type: "message",
      timestamp: "2026-01-01T12:34:56.000Z",
      message: {
        role: "assistant\u001b]0;forged-title\u0007",
        content: [
          {
            type: "text",
            text: "safe \u001b[31mred\u001b[0m \u001b]52;c;payload\u0007 text\u202ereversed",
          },
        ],
      },
    };
    await fs.writeFile(sessionFile, `not-json\n${JSON.stringify(first)}\n`);
    await fs.appendFile(
      sessionFile,
      `${JSON.stringify({
        type: "message",
        timestamp: "2026-01-01T12:34:57.000Z",
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              name: "read",
              arguments: { path: "src/example.ts", offset: 1, limit: 20 },
            },
          ],
        },
      })}\n${JSON.stringify({
        type: "message",
        timestamp: "2026-01-01T12:34:58.000Z",
        message: {
          role: "toolResult",
          toolName: "read",
          content: [{ type: "text", text: "const value = 42;" }],
          details: { truncated: false },
        },
      })}\n`,
    );

    const child = spawn(process.execPath, [runner, sessionFile, "4096"], {
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
      await waitForOutput(() => stdout, "safe red  text reversed");
      await waitForOutput(() => stdout, '"path": "src/example.ts"');
      await waitForOutput(() => stdout, "output:\nconst value = 42;");
      expect(stdout).toContain("details:");
      await fs.appendFile(
        sessionFile,
        `${JSON.stringify({
          type: "message",
          message: { role: "user", content: [{ type: "text", text: "appended" }] },
        })}\n`,
      );
      await waitForOutput(() => stdout, "appended");
      expect(stdout).not.toContain("\u001b]0;forged-title");
      expect(stdout).not.toContain("\u001b]52");
      expect(stdout).not.toContain("\u202e");
      expect(stderr).toBe("");
    } finally {
      child.kill("SIGTERM");
      await new Promise<void>((resolve) => child.once("close", () => resolve()));
    }
  });
});
