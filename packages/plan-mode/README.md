# Plan Mode

Plan Mode provides a conservative, provider-independent inspection mode for Pi. It blocks state-changing tools and shell operations. It allows the built-in inspection policy.

Additional approvals require explicit, exact, and local trust from the user or project.

## Configuration

Pi loads global configuration from `~/.pi/agent/plan-mode.json`, or from the directory in `PI_CODING_AGENT_DIR`. A trusted project can also use `.pi/plan-mode.json`. Pi merges the files. Pi ignores project configuration when the project is not trusted. Missing files act as empty configuration.

```json
{
  "readOnlyTools": ["example_external_tool"],
  "readOnlyCommands": {
    "example-cli": ["help", "inspect", "list"]
  }
}
```

Pi uses exact registered tool names after it removes a runtime namespace such as `functions.`. CLI entries match the executable name and its first top-level subcommand. For example, approval for `example-cli inspect item-123` does not approve `example-cli delete item-123`.

Use `/plan-tools` to add an approval. The command lists registered Pi tools and their source metadata, or asks for a CLI executable and read-only subcommands. It asks for scope and confirmation before it writes. Leave Plan Mode before you change policy. The command refuses policy changes while Plan Mode is active. Run `/reload` after you install an extension or change configuration. Enter Plan Mode again after reload.

## Validation and security

Pi ignores invalid JSON, malformed entries, empty names, and unavailable executables. It shows warnings for these entries. It removes duplicate entries. Pi writes configuration through a temporary file and an atomic rename.

Direct mutators remain blocked even when a configuration lists them. These mutators include `edit`, `write`, `apply_patch`, long-term memory overwrite/update/delete/forget operations, `ctx_execute`, `ctx_execute_file`, `ctx_batch_execute`, `ctx_purge`, `ctx_upgrade`, `subagent_close`, and `subagent_interrupt`. Plan Mode permits `memory_read`/`memory_search` and only `memory_write` calls targeting `daily` or `long_term` with append semantics.

Safe Context Mode references (`ctx_search`, `ctx_stats`, `ctx_doctor`, `ctx_index`, and `ctx_fetch_and_index`) remain available. The reviewed `repository_reference` tool can also clone validated remotes into managed temporary paths and list, remove, or clean up only its own references; it has no Context Mode dependency. Context execution is never an approved Plan Mode operation, even if configured. The configuration does not change restrictions on Git mutations, package installation, todos, scratchpad writes, containers, shell composition, redirection, command substitution, or arbitrary interpreter execution.

A proposal is recognized only when `<proposed_plan>` and `</proposed_plan>` occupy standalone lines outside fenced code. Inline and fenced examples are ignored. While active, `/plan` autocompletes `off`; `/plan-implement` autocompletes `fresh` for a new session. `/plan-review` requires active Plan Mode, an idle parent, a latest unconsumed plan, and no running Worker, then lets the user select an available/scoped model for a temporary read-only Explorer review. Cancellation, unavailable models, and authentication failures leave plan state unchanged. The reviewer report is displayed and injected for plan revision; it never approves or implements a plan. `/plan-implement` consumes the reviewed plan source once, so a newer proposal is required for another implementation attempt. Pi checks shell composition before configured commands. An approval cannot chain commands or write output.

Plan Mode is a Pi policy guardrail, not an operating-system sandbox. A configured CLI represents an explicit trust decision. Add only read-only subcommands. The upstream repository contains no environment-specific tool or server configuration. Keep personal integrations in local configuration.
