# Todos

Provides the `todo` tool and `/todos` interactive browser for durable, project-local work items stored under `.pi/todos`. Todos have Markdown details, tags, status, assignment, and file locking to coordinate concurrent Pi sessions.

Use `todo` actions `list`, `list-all`, `get`, `create`, `update`, `append`, `claim`, `release`, and `delete`. Closed items are retained and can be reopened through `update`. The extension uses only the current project's `.pi/todos` directory; it does not install commands or use external services.
