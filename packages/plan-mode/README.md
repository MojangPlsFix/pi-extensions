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

Pi ignores invalid JSON, malformed entries, empty names, and unavailable executables. It shows warnings for these entries and removes duplicates. Pi writes configuration through a temporary file and an atomic rename.

Plan Mode parses each Bash request as one literal command. Spaces and tabs separate arguments. Quotes, escapes, and adjacent fragments follow the documented Bash word rules. Quoted or escaped shell metacharacters are allowed as literal argument text. Thus, a quoted regular expression can contain `|`. Active pipelines, chains, redirects, comments, grouping, expansion, substitutions, globs, braces, and leading tildes remain blocked. Malformed quotes, line breaks, and trailing escapes also fail closed.

The policy checks decoded arguments without joining them again. It rejects known write, execution, helper, pager, and delegation options for reviewed native utilities. It parses Git and package-manager subcommands separately. Exact third-party CLI approvals still represent explicit user trust. They use the same literal-command grammar, so an approval cannot enable shell composition or expansion.

Plan Mode does not run `rtk --version` or use an RTK version gate. An RTK wrapper gets the same authorization as its unwrapped command. This parity covers authorization only. RTK can still change output and runtime behavior.

The RTK root grammar allows bare `rtk`, `help`, `-h`, `--help`, `-V`, and `--version`. It allows only these leading output-control globals: `--ultra-compact`, `--verbose`, `-v`, `-vv`, and `-vvv`. Plan Mode blocks `--skip-env`, unknown globals, nested RTK, ambiguous global placement, and unsupported `--` forms.

`rtk read` requires one or more files. It accepts only `-l` or `--level` with `none`, `minimal`, or `aggressive`. It also accepts unsigned values for `-m`, `--max-lines`, and `--tail-lines`. The `-n` and `--line-numbers` flags are valid. Max-lines and tail-lines modes cannot occur together.

`rtk json` requires exactly one file. It accepts an unsigned `-d` or `--depth` value and the `--keys-only` flag. Help and valid end-of-options forms remain available for `read` and `json`. `rtk env` accepts no arguments or one nonempty `-f` or `--filter` value. Other options, values, operands, and command-execution forms fail closed.

Plan Mode blocks RTK meta, execution, mutation, and state commands before it checks configured CLI approvals. The blocked set includes `rewrite`, `run`, `proxy`, `session`, `smart`, `gain`, `discover`, `learn`, `init`, and `config`. It also includes hooks, pipes, telemetry, trust changes, verification, command-running tests, error modes, and summary modes. Native `gh` and `rtk gh` always remain blocked. A configured command with the same name cannot override an RTK-owned denial. An unknown RTK pass-through command is valid only when its native or configured form passes the shared policy.

While Plan Mode is active, `tool_execution_start` copies the original Bash command into a transient map. The map uses the tool-call ID and stores an invalid marker for bad input. The Bash handler consumes this snapshot before it checks the mutable `tool_call` input. An unsafe original always blocks, even when an earlier handler supplies a safe rewrite.

The policy observes three authorization boundaries:

1. The original command.
2. The rewrite that survives all earlier `tool_call` handlers.
3. Each later assignment to the guarded `command` accessor.

A safe surviving rewrite becomes the selected command. An unsafe or non-string surviving rewrite restores the approved original. The accessor applies the same rule to every later assignment and does not throw a policy exception. A later safe assignment can replace the restored original. Transient values that an earlier handler overwrites cannot reach execution, so Plan Mode cannot observe them.

The snapshot is runtime-only. Plan Mode does not add it to Plan state, revision expectations, receipts, continuation messages, session entries, or workflow-finalization state. Missing or invalid snapshots block the call. Tool completion removes unused snapshots. Session starts, tree changes, and shutdown also clear all snapshots. A non-configurable or otherwise unguardable `command` property blocks the call.

Pi 0.84 currently emits the start event before it creates the mutable tool-call clone. This order is current implementation behavior, not a permanent public API guarantee.

Direct project mutators remain blocked even when configuration lists them. These include `edit`, `write`, `apply_patch`, memory overwrite or deletion, `ctx_execute`, `ctx_execute_file`, `ctx_batch_execute`, `ctx_purge`, and `ctx_upgrade`. Plan Mode permits the Hackler control tools, but the manager rejects write runs and write-session revival. Plan Mode permits memory reads and append-only writes to daily or long-term memory.

Context routing follows the tools active for each turn. Exact file inspection uses Pi's built-in `read` when active because Context Mode has no `ctx_read` tool. Context execution remains unavailable in Plan Mode, even for apparent read tasks. `ctx_execute_file` runs supplied code and is not an exact reader. `ctx_index` and `ctx_fetch_and_index` remain allowed for compatibility. They can change the external Context index, and fetch can use the network. Search, statistics, and diagnostics remain available when active.

The reviewed `repository_reference` tool can clone validated remotes into managed temporary paths. It can change only references that it created. It has no Context Mode dependency.

## Plan workflow

A proposal is recognized only when `<proposed_plan>` and `</proposed_plan>` occupy standalone lines outside fenced code. Inline and fenced examples are ignored. While active, `/plan` autocompletes `off`. `/plan-implement` autocompletes `fresh` for a new session.

`/plan-review` requires active Plan Mode, an idle parent, a latest unconsumed plan, no pending revision expectation, and no running Worker. It uses an available, scoped model for a temporary read-only review. Cancellation, unavailable models, and authentication failures leave plan state unchanged. A successful review durably records the exact reviewed plan and response boundary before its visible report is queued through the workflow continuation coordinator. The next response must contain one complete final `<proposed_plan>` block even when no revision is needed. Marker-free acknowledgements are skipped; within the bounded response, a newer malformed proposal supersedes an older valid one.

A missing or malformed review response queues one durable correction turn. A second failure warns once, queues no third turn, preserves the previously valid plan, and leaves Plan Mode active. Coordinator request IDs, delivery and settlement bounds, retry phase, last checked assistant entry, and parse failure are persisted so reloads and tree navigation do not replay review or correction turns. Transient Bash snapshots do not change these delivery or settlement boundaries. Plan Mode state is strict version 2; valid version 1 entries under either historical custom type are migrated without replaying an old proposal.

`/plan-implement` consumes a plan source once in the active session. Another attempt requires a newer proposal. Current-session implementation advances the implementation wave and uses the continuation coordinator rather than a direct automatic send. Fresh implementation records version 2 Plan Mode state and a separate armed workflow-finalization implementation-wave entry in replacement setup before the replacement context sends its kickoff. The parent session keeps independent state if you resume it.

## Trust boundary

Plan Mode is a guardrail over the model-supplied command and reviewed in-event rewrites. It is not an operating-system filesystem or network sandbox. Pi applies `shellCommandPrefix` after Plan Mode validation. Treat that prefix as trusted host configuration.

The argument guarantee does not cover executable resolution, aliases, shell functions, or the shell startup environment. It also does not cover project or user tool configuration, pagers, helper programs, utility versions, caches, or temporary files. RTK can filter, mask, or truncate output. Its telemetry, history, configured filters, tee files, and future semantics remain ambient risks. Package-manager metadata and other bookkeeping state are managed-state exceptions. Ambient programs can still use their normal network access.

A configured CLI is an explicit trust decision. Add only read-only subcommands. Keep personal integrations in local configuration. Absolute read-only execution requires a separate operating-system sandbox or a shell-free runner. This change does not provide either mechanism.
