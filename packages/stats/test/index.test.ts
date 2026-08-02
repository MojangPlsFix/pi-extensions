import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildReport, collectStats, parseStatsArgs, periodRange } from "../index.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map(async (directory) =>
        (await import("node:fs/promises")).rm(directory, { recursive: true, force: true }),
      ),
  );
});

describe("stats", () => {
  it("calculates calendar periods and parses period arguments", () => {
    const range = periodRange("week", new Date("2026-03-04T12:00:00"));
    expect(range.start.getDay()).toBe(1);
    expect(parseStatsArgs("month previous")).toEqual({ mode: "month", offset: -1 });
    expect(parseStatsArgs("nonsense")).toBeUndefined();
  });
  it("reads valid usage once while ignoring malformed and custom summary records", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-extensions-stats-"));
    directories.push(directory);
    await mkdir(join(directory, "subagents"));
    const timestamp = "2026-03-03T10:00:00.000Z";
    const ignoredCustomType = ["session", "summary"].join("-");
    await writeFile(
      join(directory, "main.jsonl"),
      [
        `{"type":"session","id":"main","cwd":"/project"}`,
        `{"type":"message","timestamp":"${timestamp}","message":{"role":"assistant","provider":"test","model":"m","usage":{"input":10,"output":5,"cost":0.01}}}`,
        `{"type":"message","timestamp":"${timestamp}","message":{"role":"toolResult","usage":{}}}`,
        "not json",
        JSON.stringify({
          type: "custom",
          customType: ignoredCustomType,
          timestamp,
          usage: { input: 999 },
        }),
      ].join("\n"),
    );
    await writeFile(
      join(directory, "subagents", "child.jsonl"),
      [
        `{"type":"session","id":"child","cwd":"/project"}`,
        `{"type":"message","timestamp":"${timestamp}","message":{"role":"assistant","usage":{"input":3}}}`,
      ].join("\n"),
    );
    const report = await collectStats({ mode: "week", now: new Date("2026-03-04"), directory });
    expect(report.totals.input).toBe(13);
    expect(report.subagents.input).toBe(3);
    // The zero-usage tool result is not a model response.
    expect(report.totals.responses).toBe(2);
    expect(buildReport(report)).toContain("Subagents (included above)");
  });
});
