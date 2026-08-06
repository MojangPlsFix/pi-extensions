# Todos

Todos provides the `todo` tool and the `/todos` interactive browser. It stores durable project work items under `.pi/todos`.

Items support status, tags, assignment, and file locking for concurrent Pi sessions. Closed items remain available. Use `update` to reopen an item.

Use these actions with `todo`:

- `list`
- `list-all`
- `get`
- `create`
- `update`
- `append`
- `claim`
- `release`
- `delete`

The extension uses only the current project directory. It does not install commands or use external services.
