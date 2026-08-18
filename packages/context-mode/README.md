# Context Mode

This is the repository's **single Pi-facing Context Mode owner**. It registers Pi-native `ctx_execute`, `ctx_execute_file`, and `ctx_batch_execute` tools and owns the narrow bridge for `ctx_index`, `ctx_search`, `ctx_fetch_and_index`, `ctx_stats`, and read-only `ctx_doctor`. The upstream Context Mode Pi entrypoint (`build/adapters/pi/extension.js`) must not be loaded alongside this extension.

## Runtime strategy

The Context Mode engine is not vendored or copied here. The bridge resolves an external `context-mode` installation and is pinned/documented against **1.0.169**:

```sh
pi install npm:context-mode@1.0.169
```

Keep the runtime installed, but configure its package entry with `"extensions": []`, `"skills": []`, `"prompts": []`, and `"themes": []`. This prevents the upstream Pi extension from registering duplicate tools and hooks. The replacement also stays inactive and writes a diagnostic if another extension registered `ctx_*` tools before it loads.

`PI_CONTEXT_MODE_DIR` may point at an explicitly managed installation. The resolver also checks Pi's package directory and the current project's `node_modules`. A version mismatch is rejected rather than silently running an unreviewed engine. The upstream engine uses the Elastic License 2.0; see the repository-level third-party notice.

The Pi-native execution path deliberately uses a real Node 22+ runtime and never spawns the Pi or Bun host executable for JavaScript/TypeScript. It bounds source/output, confines working directories and file inputs to the project, uses detached process groups (or Windows tree termination), forwards Pi abort signals, handles EPIPE, and removes temporary files. Before execution it loads the pinned runtime's `build/security.js` module to apply the same deny-only Bash, embedded shell-command, and Read-path policies as upstream Context Mode. JavaScript keeps CommonJS semantics (`require` works), and Rust uses a cancellation-aware compile-then-run path. Background execution is intentionally absent from the public schema so unmanaged processes cannot escape session cleanup.

Native execution accepts `intent`. When derived output exceeds 5 KB, including output from a non-zero command, the replacement indexes it through the external runtime and returns matching searched sections instead of the raw output while preserving failure status. Without `intent`, output is capped at 100,000 bytes and returned inline. The cap is enforced on bytes: crossing it kills the process tree and reports bounded failure output. Results and indexed content retain a bounded executed-source or batch-command echo for audit provenance. `ctx_execute_file` validates and canonicalizes the requested project path, then the child runtime reads that original file directly so Pi does not duplicate large inputs in its own heap.

The `shell` runtime uses the configured POSIX shell and a `.sh` temporary script on Unix. On Windows it uses `ComSpec`/`cmd.exe` and a `.cmd` temporary script. Windows shell file analysis exposes `FILE_CONTENT_PATH` and `file_path`; use `type` or another command to process multiline content because CMD environment variables cannot safely preserve it.

External MCP calls have no upstream cancellation field. On abort, Pi stops waiting and renders a cancelled state, but the adapter explicitly does **not** claim that the external operation was killed. The bridge lifecycle is shut down on session shutdown and inherits the external bridge's pending-request, respawn, EPIPE, output, and process-tree protections.

`ctx_batch_execute` runs commands through the same native abort-aware runner with bounded concurrency and ordered results. It caps the combined captured output, indexes that output through the external runtime, and returns the requested indexed search results. Command execution has hard cancellation; cancellation during external indexing/search remains best-effort because upstream MCP has no per-request cancellation field.

All tools use tool-specific chat-row renderers. Native execution reports throttled elapsed time and captured byte counts; batch execution also reports completed-command counts and the indexing/search phases. External calls report their tool-specific phase and elapsed time without creating a footer, widget, or separate chat message.

The replacement composes the pinned upstream Pi lifecycle through a tool-suppressing adapter. Session event capture, active-memory injection, resume snapshots, compaction counters, token/cost tracking, and the upstream stats/doctor commands remain active, while the upstream MCP bridge is forced off. The injected routing paragraph is rewritten to name only tools this replacement actually exposes.
