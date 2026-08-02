import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import todosExtension from "../index.js";

type TodoTool = {
  execute(
    id: string,
    params: Record<string, unknown>,
    signal: AbortSignal,
    update: () => void,
    ctx: unknown,
  ): Promise<any>;
};
const directories: string[] = [];

function createTool(): TodoTool {
  let tool: TodoTool | undefined;
  todosExtension({
    on: () => undefined,
    registerCommand: () => undefined,
    registerTool: (value: TodoTool) => {
      tool = value;
    },
  } as unknown as ExtensionAPI);
  if (!tool) throw new Error("todo tool was not registered");
  return tool;
}

async function context(directory: string, session = "session-one") {
  return {
    cwd: directory,
    sessionManager: { getSessionId: () => session, getSessionFile: () => `/tmp/${session}.jsonl` },
    hasUI: false,
  };
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("todos", () => {
  it("persists, renders, locks, and coordinates assignments between sessions", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-extensions-todos-"));
    directories.push(directory);
    const tool = createTool();
    const first = await context(directory);
    const created = await tool.execute(
      "1",
      { action: "create", title: "Review public API", tags: ["review"], body: "Check docs." },
      new AbortController().signal,
      () => undefined,
      first,
    );
    const id = created.details.todo.id as string;
    expect(created.content[0].text).toContain("Review public API");

    await tool.execute(
      "2",
      { action: "append", id, body: "Add tests." },
      new AbortController().signal,
      () => undefined,
      first,
    );
    const claimed = await tool.execute(
      "3",
      { action: "claim", id },
      new AbortController().signal,
      () => undefined,
      first,
    );
    expect(claimed.details.todo.assigned_to_session).toBe("session-one");
    const blocked = await tool.execute(
      "4",
      { action: "claim", id },
      new AbortController().signal,
      () => undefined,
      await context(directory, "session-two"),
    );
    expect(blocked.details.error).toContain("assigned");

    const listed = await tool.execute(
      "5",
      { action: "list-all" },
      new AbortController().signal,
      () => undefined,
      first,
    );
    expect(listed.content[0].text).toContain("TODO-");
    const fetched = await tool.execute(
      "6",
      { action: "get", id },
      new AbortController().signal,
      () => undefined,
      first,
    );
    expect(fetched.content[0].text).toContain("Add tests.");
  });
});
