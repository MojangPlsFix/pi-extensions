import path from "node:path";
import { copyToClipboard, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { buildRefinePrompt, formatTodoList } from "./formatters.js";
import {
  formatTodoId,
  isTodoClosed,
  type TodoFrontMatter,
  type TodoMenuAction,
  type TodoOverlayAction,
  type TodoRecord,
} from "./model.js";
import {
  deleteTodo,
  ensureTodoExists,
  ensureTodosDir,
  generateTodoId,
  getTodoPath,
  getTodosDir,
  listTodos,
  releaseTodoAssignment,
  updateTodoStatus,
  withTodoLock,
  writeTodoFile,
} from "./store.js";
import {
  TodoActionMenuComponent,
  TodoDeleteConfirmComponent,
  TodoDetailOverlayComponent,
  TodoSelectorComponent,
} from "./ui.js";

export function registerTodosCommand(pi: ExtensionAPI): void {
  pi.registerCommand("todos", {
    description: "List todos from .pi/todos",
    handler: async (args, ctx) => {
      const todosDir = getTodosDir(ctx.cwd);
      const todos = await listTodos(todosDir);
      const currentSessionId = ctx.sessionManager.getSessionId();
      const searchTerm = (args ?? "").trim();

      if (!ctx.hasUI) {
        const text = formatTodoList(todos);
        console.log(text);
        return;
      }

      let nextPrompt: string | null = null;
      let rootTui: TUI | undefined;
      await ctx.ui.custom<void>((tui, theme, keybindings, done) => {
        rootTui = tui;
        let selector: TodoSelectorComponent | null = null;
        let actionMenu: TodoActionMenuComponent | null = null;
        let deleteConfirm: TodoDeleteConfirmComponent | null = null;
        let activeComponent: {
          render: (width: number) => string[];
          invalidate: () => void;
          handleInput?: (data: string) => void;
          focused?: boolean;
        } | null = null;
        let wrapperFocused = false;

        const setActiveComponent = (
          component: {
            render: (width: number) => string[];
            invalidate: () => void;
            handleInput?: (data: string) => void;
            focused?: boolean;
          } | null,
        ) => {
          if (activeComponent && "focused" in activeComponent) {
            activeComponent.focused = false;
          }
          activeComponent = component;
          if (activeComponent && "focused" in activeComponent) {
            activeComponent.focused = wrapperFocused;
          }
          tui.requestRender();
        };

        const copyTodoPathToClipboard = (todoId: string) => {
          const filePath = getTodoPath(todosDir, todoId);
          const absolutePath = path.resolve(filePath);
          try {
            copyToClipboard(absolutePath);
            ctx.ui.notify(`Copied ${absolutePath} to clipboard`, "info");
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            ctx.ui.notify(message, "error");
          }
        };

        const copyTodoTextToClipboard = (record: TodoRecord) => {
          const title = record.title || "(untitled)";
          const body = record.body?.trim() || "";
          const text = body ? `# ${title}\n\n${body}` : `# ${title}`;
          try {
            copyToClipboard(text);
            ctx.ui.notify("Copied todo text to clipboard", "info");
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            ctx.ui.notify(message, "error");
          }
        };

        const resolveTodoRecord = async (todo: TodoFrontMatter): Promise<TodoRecord | null> => {
          const filePath = getTodoPath(todosDir, todo.id);
          const record = await ensureTodoExists(filePath, todo.id);
          if (!record) {
            ctx.ui.notify(`Todo ${formatTodoId(todo.id)} not found`, "error");
            return null;
          }
          return record;
        };

        const openTodoOverlay = async (record: TodoRecord): Promise<TodoOverlayAction> => {
          const action = await ctx.ui.custom<TodoOverlayAction>(
            (overlayTui, overlayTheme, overlayKeybindings, overlayDone) =>
              new TodoDetailOverlayComponent(
                overlayTui,
                overlayTheme,
                overlayKeybindings,
                record,
                overlayDone,
              ),
            {
              overlay: true,
              overlayOptions: { width: "80%", maxHeight: "80%", anchor: "center" },
            },
          );

          return action ?? "back";
        };

        const parseTagsInput = (value: string | undefined): string[] =>
          (value ?? "")
            .split(",")
            .map((tag) => tag.trim())
            .filter(Boolean);

        const promptForTodoDraft = async (initial?: {
          title?: string;
          tags?: string[];
          body?: string;
        }): Promise<{ title: string; tags: string[]; body: string } | null> => {
          const title = await ctx.ui.input("Todo title", initial?.title ?? "");
          if (title === undefined) return null;
          const normalizedTitle = title.trim();
          if (!normalizedTitle) {
            ctx.ui.notify("Todo title cannot be empty", "error");
            return null;
          }

          const tags = await ctx.ui.input(
            "Tags (comma-separated)",
            (initial?.tags ?? []).join(", "),
          );
          if (tags === undefined) return null;

          const body = await ctx.ui.editor("Todo details", initial?.body ?? "");
          if (body === undefined) return null;

          return {
            title: normalizedTitle,
            tags: parseTagsInput(tags),
            body,
          };
        };

        const refreshTodos = async () => {
          const updatedTodos = await listTodos(todosDir);
          selector?.setTodos(updatedTodos);
        };

        const createTodoInteractively = async () => {
          const draft = await promptForTodoDraft();
          if (!draft) return;

          await ensureTodosDir(todosDir);
          const id = await generateTodoId(todosDir);
          const filePath = getTodoPath(todosDir, id);
          const todo: TodoRecord = {
            id,
            title: draft.title,
            tags: draft.tags,
            status: "open",
            created_at: new Date().toISOString(),
            body: draft.body,
          };

          const result = await withTodoLock(todosDir, id, ctx, async () => {
            await writeTodoFile(filePath, todo);
            return todo;
          });
          if (typeof result === "object" && "error" in result) {
            ctx.ui.notify(result.error, "error");
            return;
          }

          await refreshTodos();
          ctx.ui.notify(`Created todo ${formatTodoId(id)}`, "info");
        };

        const editTodoInteractively = async (record: TodoRecord) => {
          const draft = await promptForTodoDraft(record);
          if (!draft) return;

          const result = await withTodoLock(todosDir, record.id, ctx, async () => {
            const filePath = getTodoPath(todosDir, record.id);
            const existing = await ensureTodoExists(filePath, record.id);
            if (!existing) {
              return { error: `Todo ${formatTodoId(record.id)} not found` } as const;
            }
            existing.title = draft.title;
            existing.tags = draft.tags;
            existing.body = draft.body;
            await writeTodoFile(filePath, existing);
            return existing;
          });
          if (typeof result === "object" && "error" in result) {
            ctx.ui.notify(result.error, "error");
            return;
          }

          await refreshTodos();
          ctx.ui.notify(`Updated todo ${formatTodoId(record.id)}`, "info");
        };

        const applyTodoAction = async (
          record: TodoRecord,
          action: TodoMenuAction,
        ): Promise<"stay" | "exit"> => {
          if (action === "refine") {
            const title = record.title || "(untitled)";
            nextPrompt = buildRefinePrompt(record.id, title);
            done();
            return "exit";
          }
          if (action === "work") {
            const title = record.title || "(untitled)";
            nextPrompt = `work on todo ${formatTodoId(record.id)} "${title}"`;
            done();
            return "exit";
          }
          if (action === "view") {
            return "stay";
          }
          if (action === "edit") {
            await editTodoInteractively(record);
            return "stay";
          }
          if (action === "copyPath") {
            copyTodoPathToClipboard(record.id);
            return "stay";
          }
          if (action === "copyText") {
            copyTodoTextToClipboard(record);
            return "stay";
          }

          if (action === "release") {
            const result = await releaseTodoAssignment(todosDir, record.id, ctx, true);
            if ("error" in result) {
              ctx.ui.notify(result.error, "error");
              return "stay";
            }
            await refreshTodos();
            ctx.ui.notify(`Released todo ${formatTodoId(record.id)}`, "info");
            return "stay";
          }

          if (action === "delete") {
            const result = await deleteTodo(todosDir, record.id, ctx);
            if ("error" in result) {
              ctx.ui.notify(result.error, "error");
              return "stay";
            }
            await refreshTodos();
            ctx.ui.notify(`Deleted todo ${formatTodoId(record.id)}`, "info");
            return "stay";
          }

          const nextStatus = action === "close" ? "closed" : "open";
          const result = await updateTodoStatus(todosDir, record.id, nextStatus, ctx);
          if ("error" in result) {
            ctx.ui.notify(result.error, "error");
            return "stay";
          }

          await refreshTodos();
          ctx.ui.notify(
            `${action === "close" ? "Closed" : "Reopened"} todo ${formatTodoId(record.id)}`,
            "info",
          );
          return "stay";
        };

        const handleActionSelection = async (record: TodoRecord, action: TodoMenuAction) => {
          if (action === "view") {
            const overlayAction = await openTodoOverlay(record);
            if (overlayAction === "work") {
              await applyTodoAction(record, "work");
              return;
            }
            if (actionMenu) {
              setActiveComponent(actionMenu);
            }
            return;
          }

          if (action === "delete") {
            const message = `Delete todo ${formatTodoId(record.id)}? This cannot be undone.`;
            deleteConfirm = new TodoDeleteConfirmComponent(theme, message, (confirmed) => {
              if (!confirmed) {
                setActiveComponent(actionMenu);
                return;
              }
              void (async () => {
                await applyTodoAction(record, "delete");
                setActiveComponent(selector);
              })();
            });
            setActiveComponent(deleteConfirm);
            return;
          }

          const result = await applyTodoAction(record, action);
          if (result === "stay") {
            setActiveComponent(selector);
          }
        };

        const showActionMenu = async (todo: TodoFrontMatter | TodoRecord) => {
          const record = "body" in todo ? todo : await resolveTodoRecord(todo);
          if (!record) return;
          actionMenu = new TodoActionMenuComponent(
            theme,
            record,
            (action) => {
              void handleActionSelection(record, action);
            },
            () => {
              setActiveComponent(selector);
            },
          );
          setActiveComponent(actionMenu);
        };

        const handleSelect = async (todo: TodoFrontMatter) => {
          await showActionMenu(todo);
        };

        selector = new TodoSelectorComponent(
          tui,
          theme,
          keybindings,
          todos,
          (todo) => {
            void handleSelect(todo);
          },
          () => done(),
          searchTerm || undefined,
          currentSessionId,
          (todo, action) => {
            if (action === "edit" || action === "view" || action === "delete") {
              void (async () => {
                const record = await resolveTodoRecord(todo);
                if (!record) return;
                if (action === "edit") {
                  await editTodoInteractively(record);
                  setActiveComponent(selector);
                  return;
                }
                if (action === "view") {
                  await handleActionSelection(record, "view");
                  return;
                }
                await handleActionSelection(record, "delete");
              })();
              return;
            }
            if (action === "toggleClosed") {
              void (async () => {
                const record = await resolveTodoRecord(todo);
                if (!record) return;
                await applyTodoAction(record, isTodoClosed(record.status) ? "reopen" : "close");
                setActiveComponent(selector);
              })();
              return;
            }
            const title = todo.title || "(untitled)";
            nextPrompt =
              action === "refine"
                ? buildRefinePrompt(todo.id, title)
                : `work on todo ${formatTodoId(todo.id)} "${title}"`;
            done();
          },
          () => {
            void (async () => {
              await createTodoInteractively();
              setActiveComponent(selector);
            })();
          },
        );

        setActiveComponent(selector);

        const rootComponent = {
          get focused() {
            return wrapperFocused;
          },
          set focused(value: boolean) {
            wrapperFocused = value;
            if (activeComponent && "focused" in activeComponent) {
              activeComponent.focused = value;
            }
          },
          render(width: number) {
            return activeComponent ? activeComponent.render(width) : [];
          },
          invalidate() {
            activeComponent?.invalidate();
          },
          handleInput(data: string) {
            activeComponent?.handleInput?.(data);
          },
        };

        return rootComponent;
      });

      if (nextPrompt) {
        ctx.ui.setEditorText(nextPrompt);
        rootTui?.requestRender();
      }
    },
  });
}
