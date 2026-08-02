import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  filterTodos,
  normalizeTodoId,
  sortTodos,
  type TodoFrontMatter,
  type TodoRecord,
  validateTodoId,
} from "../model.js";
import {
  ensureTodosDir,
  garbageCollectTodos,
  getTodoPath,
  listTodos,
  normalizeTodoSettings,
  parseTodoContent,
  serializeTodo,
  writeTodoFile,
} from "../store.js";

const directories: string[] = [];

function todo(overrides: Partial<TodoFrontMatter>): TodoFrontMatter {
  return {
    id: "00000000",
    title: "Todo",
    tags: [],
    status: "open",
    created_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("todo model", () => {
  it("normalizes and validates display ids without changing validation errors", () => {
    expect(normalizeTodoId(" #TODO-Ab12Cd34 ")).toBe("Ab12Cd34");
    expect(validateTodoId("TODO-Ab12Cd34")).toEqual({ id: "ab12cd34" });
    expect(validateTodoId("TODO-nope")).toEqual({
      error: "Invalid todo id. Expected TODO-<hex>.",
    });
  });

  it("sorts assigned and open todos before closed todos and filters all search fields", () => {
    const todos = [
      todo({ id: "cccccccc", title: "Closed", status: "done" }),
      todo({ id: "bbbbbbbb", title: "Open", created_at: "2026-01-02T00:00:00.000Z" }),
      todo({
        id: "aaaaaaaa",
        title: "Assigned",
        tags: ["review"],
        assigned_to_session: "session-one",
      }),
    ];

    expect(sortTodos(todos).map(({ id }) => id)).toEqual(["aaaaaaaa", "bbbbbbbb", "cccccccc"]);
    expect(filterTodos(todos, "review assigned:session-one").map(({ id }) => id)).toEqual([
      "aaaaaaaa",
    ]);
  });
});

describe("todo store", () => {
  it("round-trips the JSON front matter and markdown body format", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-extensions-todo-store-"));
    directories.push(directory);
    await ensureTodosDir(directory);

    const record: TodoRecord = {
      id: "deadbeef",
      title: "Keep the format",
      tags: ["storage"],
      status: "open",
      created_at: "2026-01-25T17:00:00.000Z",
      body: "\nDetails with a } brace.\n\n",
    };
    const filePath = getTodoPath(directory, record.id);
    await writeTodoFile(filePath, record);

    const content = await readFile(filePath, "utf8");
    expect(content).toBe(serializeTodo(record));
    expect(parseTodoContent(content, record.id)).toEqual({
      ...record,
      body: "Details with a } brace.\n",
    });
    expect(await listTodos(directory)).toEqual([
      {
        id: record.id,
        title: record.title,
        tags: record.tags,
        status: record.status,
        created_at: record.created_at,
        assigned_to_session: undefined,
      },
    ]);
  });

  it("normalizes settings and garbage-collects only old closed todos", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-extensions-todo-gc-"));
    directories.push(directory);
    await ensureTodosDir(directory);

    expect(normalizeTodoSettings({ gcDays: 2.9 })).toEqual({ gc: true, gcDays: 2 });
    expect(normalizeTodoSettings({ gc: false, gcDays: Number.NaN })).toEqual({
      gc: false,
      gcDays: 7,
    });

    const oldDate = "2000-01-01T00:00:00.000Z";
    await writeTodoFile(getTodoPath(directory, "11111111"), {
      ...todo({ id: "11111111", status: "closed", created_at: oldDate }),
      body: "remove",
    });
    await writeTodoFile(getTodoPath(directory, "22222222"), {
      ...todo({ id: "22222222", status: "open", created_at: oldDate }),
      body: "keep",
    });

    await garbageCollectTodos(directory, { gc: true, gcDays: 7 });
    expect((await listTodos(directory)).map(({ id }) => id)).toEqual(["22222222"]);
  });
});
