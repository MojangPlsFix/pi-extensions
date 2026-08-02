/**
 * File-based todos stored under .pi/todos (or PI_TODO_PATH).
 * The default entry point only wires session initialization, the todo tool, and /todos.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerTodosCommand } from "./command.js";
import { ensureTodosDir, garbageCollectTodos, getTodosDir, readTodoSettings } from "./store.js";
import { registerTodoTool } from "./tool.js";

export default function todosExtension(pi: ExtensionAPI): void {
  pi.on("session_start", async (_event, ctx) => {
    const todosDir = getTodosDir(ctx.cwd);
    await ensureTodosDir(todosDir);
    const settings = await readTodoSettings(todosDir);
    await garbageCollectTodos(todosDir, settings);
  });

  registerTodoTool(pi);
  registerTodosCommand(pi);
}
