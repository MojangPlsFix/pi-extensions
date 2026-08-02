import { StringEnum } from "@earendil-works/pi-ai";
import { fuzzyMatch } from "@earendil-works/pi-tui";
import { Type } from "typebox";

export const TODO_ID_PREFIX = "TODO-";
export const TODO_ID_PATTERN = /^[a-f0-9]{8}$/i;

export interface TodoFrontMatter {
  id: string;
  title: string;
  tags: string[];
  status: string;
  created_at: string;
  assigned_to_session?: string;
}

export interface TodoRecord extends TodoFrontMatter {
  body: string;
}
export type KeybindingMatcher = {
  matches: (keyData: string, keybindingId: any) => boolean;
};

export const TodoParams = Type.Object({
  action: StringEnum([
    "list",
    "list-all",
    "get",
    "create",
    "update",
    "append",
    "delete",
    "claim",
    "release",
  ] as const),
  id: Type.Optional(Type.String({ description: "Todo id (TODO-<hex> or raw hex filename)" })),
  title: Type.Optional(Type.String({ description: "Short summary shown in lists" })),
  status: Type.Optional(Type.String({ description: "Todo status" })),
  tags: Type.Optional(Type.Array(Type.String({ description: "Todo tag" }))),
  body: Type.Optional(
    Type.String({ description: "Long-form details (markdown). Update replaces; append adds." }),
  ),
  force: Type.Optional(Type.Boolean({ description: "Override another session's assignment" })),
});

export type TodoAction =
  | "list"
  | "list-all"
  | "get"
  | "create"
  | "update"
  | "append"
  | "delete"
  | "claim"
  | "release";

export type TodoOverlayAction = "back" | "work";

export type TodoMenuAction =
  | "work"
  | "refine"
  | "edit"
  | "close"
  | "reopen"
  | "release"
  | "delete"
  | "copyPath"
  | "copyText"
  | "view";

export type TodoShortcutAction = "work" | "refine" | "edit" | "view" | "toggleClosed" | "delete";

export type TodoToolDetails =
  | {
      action: "list" | "list-all";
      todos: TodoFrontMatter[];
      currentSessionId?: string;
      error?: string;
    }
  | {
      action: "get" | "create" | "update" | "append" | "delete" | "claim" | "release";
      todo: TodoRecord;
      error?: string;
    };

export function formatTodoId(id: string): string {
  return `${TODO_ID_PREFIX}${id}`;
}

export function normalizeTodoId(id: string): string {
  let trimmed = id.trim();
  if (trimmed.startsWith("#")) {
    trimmed = trimmed.slice(1);
  }
  if (trimmed.toUpperCase().startsWith(TODO_ID_PREFIX)) {
    trimmed = trimmed.slice(TODO_ID_PREFIX.length);
  }
  return trimmed;
}

export function validateTodoId(id: string): { id: string } | { error: string } {
  const normalized = normalizeTodoId(id);
  if (!normalized || !TODO_ID_PATTERN.test(normalized)) {
    return { error: "Invalid todo id. Expected TODO-<hex>." };
  }
  return { id: normalized.toLowerCase() };
}

export function displayTodoId(id: string): string {
  return formatTodoId(normalizeTodoId(id));
}

export function isTodoClosed(status: string): boolean {
  return ["closed", "done"].includes(status.toLowerCase());
}

export function clearAssignmentIfClosed(todo: TodoFrontMatter): void {
  if (isTodoClosed(getTodoStatus(todo))) {
    todo.assigned_to_session = undefined;
  }
}

export function sortTodos(todos: TodoFrontMatter[]): TodoFrontMatter[] {
  return [...todos].sort((a, b) => {
    const aClosed = isTodoClosed(a.status);
    const bClosed = isTodoClosed(b.status);
    if (aClosed !== bClosed) return aClosed ? 1 : -1;
    const aAssigned = !aClosed && Boolean(a.assigned_to_session);
    const bAssigned = !bClosed && Boolean(b.assigned_to_session);
    if (aAssigned !== bAssigned) return aAssigned ? -1 : 1;
    return (a.created_at || "").localeCompare(b.created_at || "");
  });
}

export function buildTodoSearchText(todo: TodoFrontMatter): string {
  const tags = todo.tags.join(" ");
  const assignment = todo.assigned_to_session ? `assigned:${todo.assigned_to_session}` : "";
  return `${formatTodoId(todo.id)} ${todo.id} ${todo.title} ${tags} ${todo.status} ${assignment}`.trim();
}

export function filterTodos(todos: TodoFrontMatter[], query: string): TodoFrontMatter[] {
  const trimmed = query.trim();
  if (!trimmed) return todos;

  const tokens = trimmed
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean);

  if (tokens.length === 0) return todos;

  const matches: Array<{ todo: TodoFrontMatter; score: number }> = [];
  for (const todo of todos) {
    const text = buildTodoSearchText(todo);
    let totalScore = 0;
    let matched = true;
    for (const token of tokens) {
      const result = fuzzyMatch(token, text);
      if (!result.matches) {
        matched = false;
        break;
      }
      totalScore += result.score;
    }
    if (matched) {
      matches.push({ todo, score: totalScore });
    }
  }

  return matches
    .sort((a, b) => {
      const aClosed = isTodoClosed(a.todo.status);
      const bClosed = isTodoClosed(b.todo.status);
      if (aClosed !== bClosed) return aClosed ? 1 : -1;
      const aAssigned = !aClosed && Boolean(a.todo.assigned_to_session);
      const bAssigned = !bClosed && Boolean(b.todo.assigned_to_session);
      if (aAssigned !== bAssigned) return aAssigned ? -1 : 1;
      return a.score - b.score;
    })
    .map((match) => match.todo);
}
export function getTodoTitle(todo: TodoFrontMatter): string {
  return todo.title || "(untitled)";
}

export function getTodoStatus(todo: TodoFrontMatter): string {
  return todo.status || "open";
}
export function splitTodosByAssignment(todos: TodoFrontMatter[]): {
  assignedTodos: TodoFrontMatter[];
  openTodos: TodoFrontMatter[];
  closedTodos: TodoFrontMatter[];
} {
  const assignedTodos: TodoFrontMatter[] = [];
  const openTodos: TodoFrontMatter[] = [];
  const closedTodos: TodoFrontMatter[] = [];
  for (const todo of todos) {
    if (isTodoClosed(getTodoStatus(todo))) {
      closedTodos.push(todo);
      continue;
    }
    if (todo.assigned_to_session) {
      assignedTodos.push(todo);
    } else {
      openTodos.push(todo);
    }
  }
  return { assignedTodos, openTodos, closedTodos };
}
