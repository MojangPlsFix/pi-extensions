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

Direct mutators remain blocked even when a configuration lists them. These mutators include `edit`, `write`, `apply_patch`, memory mutators, `ctx_purge`, and `ctx_upgrade`.

The configuration does not change restrictions on Git mutations, package installation, todos, scratchpad writes, containers, shell composition, redirection, command substitution, or arbitrary interpreter execution. Pi checks shell composition before configured commands. An approval cannot chain commands or write output.

Plan Mode is a Pi policy guardrail, not an operating-system sandbox. A configured CLI represents an explicit trust decision. Add only read-only subcommands. The upstream repository contains no environment-specific tool or server configuration. Keep personal integrations in local configuration.
