# Plan Mode

Plan Mode is a conservative, provider-independent inspection mode for Pi. It blocks
state-changing tools and shell operations while allowing the built-in inspection
policy. Additional approvals are explicit, exact, and local to the user or trusted
project.

## Configuration

Global configuration is loaded from `~/.pi/agent/plan-mode.json` (or from the
`PI_CODING_AGENT_DIR` directory). A trusted project may additionally use
`.pi/plan-mode.json`. The files are merged additively; project configuration is
ignored when the project is not trusted. Missing files are equivalent to an empty
configuration.

```json
{
  "readOnlyTools": ["example_external_tool"],
  "readOnlyCommands": {
    "example-cli": ["help", "inspect", "list"]
  }
}
```

Pi tool names are exact registered names after removing a runtime namespace such
as `functions.`. CLI entries match the exact executable name and its first,
top-level subcommand. Thus `example-cli inspect item-123` can be approved without
approving `example-cli delete item-123`.

Use `/plan-tools` to add an approval interactively. It discovers registered Pi
tools and displays their source metadata, or asks for a CLI executable and its
read-only subcommands. The command asks for a scope and confirmation before
writing. Leave Plan Mode first; policy changes are refused while Plan Mode is
active. Run `/reload` after installing an extension or making a configuration
change, then enter Plan Mode again.

## Validation and security

Invalid JSON, malformed entries, empty names, and unavailable executables are
ignored with warnings. Duplicate entries are removed. Configuration is written
through a temporary file and atomic rename. Direct mutators (`edit`, `write`,
`apply_patch`, memory mutators, `ctx_purge`, and `ctx_upgrade`) remain blocked even
when listed in configuration.

The configuration does not change the existing restrictions on Git mutations,
package installation, todos, scratchpad writes, containers, shell composition,
redirection, command substitution, or arbitrary interpreter execution. Shell
composition is checked before configured commands, so an approval cannot be used
to chain commands or write output.

This is a Pi policy guardrail, not an operating-system sandbox. A configured CLI
represents an explicit user trust decision and should contain only read-only
subcommands. The upstream repository contains no environment-specific tool or
server configuration; personal integrations belong in the local configuration.
