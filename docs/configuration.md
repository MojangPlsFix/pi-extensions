# Configuration

One Pi package delivers all resources. Use `pi config` to enable or disable them. The package has no home or work profiles and does not classify environments automatically.

## Provider-aware behavior

- Usage Meter runs with the active `github-copilot` or `openai-codex` provider.
- Session Summary makes one automatic attempt with the active provider. Copilot uses Luna. Codex tries Spark before Luna. Other providers use their active model.
- The `search` tool selects its backend at run time. `github-copilot` uses the installed Copilot CLI by default while the SDK release gate remains open. `openai-codex` uses native `/codex/alpha/search` with refreshed Pi OAuth. Other providers receive an availability error. The tool does not use a cross-provider or cross-transport fallback.
- Hackler resolves model policy when it starts. Resolution checks an explicit review override, `models.overrides`, profile frontmatter, `models.default`, and the parent snapshot. `inherit` selects the parent value.

Use the [Hackler model-selection guide](../packages/subagents/MODEL_SELECTION.md) to compare models and thinking levels. Use the [orchestration evaluation guide](../packages/subagents/ORCHESTRATION_EVALUATION.md) to compare topologies under matched aggregate budgets.

### Hackler model providers

Hackler model IDs include the provider name. Child sessions use the selected model through Pi's model runtime. They do not run the `copilot` executable.

| Pi provider | Example Hackler model | Authentication |
| --- | --- | --- |
| GitHub Copilot | `github-copilot/gpt-5.6-luna` | Pi's GitHub Copilot login flow or `COPILOT_GITHUB_TOKEN` |
| OpenAI Codex | `openai-codex/gpt-5.6-luna` | `/login openai-codex` |

The default Search transport requires the local `copilot` CLI. Run `copilot login` to authenticate it. The opt-in SDK transport uses its bundled runtime. It can use GitHub CLI credentials or supported token environment variables. Its isolated empty mode does not import the CLI's stored login. Hackler workers that use Pi's `github-copilot` provider do not need the CLI.

## Configuration variables

- `PI_EXTENSIONS_LARGE_PASTE_CACHE_DIR`: private cache location for Large Paste files.
- `PI_WINDOWS_TOAST_APP_ID`: optional Windows toast application identity.
- `PI_COPILOT_SEARCH_TRANSPORT=sdk|cli`: selects the GitHub Search transport. `cli` remains the default until the SDK live release gate passes. `sdk` selects the opt-in bundled runtime preview. Invalid values cause a configuration error. Search does not retry on the other transport.
- `PI_COPILOT_SEARCH_TIMEOUT_MS`: Copilot Search inactivity limit in milliseconds. Meaningful SDK events or legacy CLI output reset the timer. The default is 600,000 (10 minutes).
- `PI_SESSION_SUMMARY=off`: disables automatic, manual, and backfill Session Summary title generation.
- `PI_CODING_AGENT_DIR`: Pi's agent directory. User Hackler profiles and configuration live below this directory. New Hackler transcripts use `<agent-dir>/subagents/sessions`.
- `PI_CODING_AGENT_SESSION_DIR`: the normal Pi session location used by Stats. Stats also scans legacy session trees.
- `HERDR_ENV=1`, `HERDR_PANE_ID`, and `HERDR_SOCKET_PATH`: permit optional display-only Hackler transcript panes. Herdr does not run child agents.

## Session Summary profiles

Copilot and Codex work without Session Summary configuration. The built-in profiles are:

```text
github-copilot: gpt-5.6-luna
openai-codex: gpt-5.3-codex-spark, gpt-5.6-luna
```

Spark uses separate five-hour and weekly limits during its research preview. Luna uses standard Codex/Work allowance when Codex falls back.

Other providers use the active model unless a profile replaces it. Session Summary never routes a request to a different provider.

Automatic generation runs after the first meaningful completed TUI turn. A persisted marker prevents automatic retries after restarts and `/tree` navigation. Session Summary uses Pi's current working row and creates no persistent status line.

Global profiles use `<agent-dir>/pi-session-summary.json`. Trusted projects can use `<project>/.pi/pi-session-summary.json`.

```json
{
  "profiles": {
    "anthropic": ["claude-haiku-4-5"],
    "my-provider": ["cheap-summary-model"]
  }
}
```

Built-in profiles have the lowest precedence. Global entries replace built-in entries. Trusted-project entries replace global entries.

An empty provider array disables summaries for that provider. Pi ignores missing files, invalid JSON, and malformed profile entries.

## Optional capabilities

- **GitHub authentication:** Usage Meter reads Pi's GitHub Copilot credentials or falls back to `gh auth token`. It then requests the trusted GitHub Copilot quota endpoint. GitHub Search uses the local `copilot` command by default. The opt-in SDK runtime can use GitHub CLI credentials or supported token environment variables. Its isolated empty mode does not import the CLI's stored login. `gpt-5.6-luna` is the default Search model unless the request overrides it. The SDK omits reasoning effort. The CLI uses effort `none`.
- **OpenAI Codex OAuth:** Usage Meter and Search require OpenAI Codex OAuth under `openai-codex`. Run `/login openai-codex`. Pi refreshes the credential for each direct request. Usage Meter requests subscription quota from the trusted HTTPS `chatgpt.com/backend-api/wham/usage` endpoint. Neither feature needs the Codex CLI. Both features reject plaintext and custom-host endpoints.
- **Hackler capabilities:** The user catalog can load trusted extensions, skills, and external command rules. Profiles select capability names. Project profiles cannot define implementation paths.
- **Herdr:** Hackler can open a raw display pane for a persisted child transcript. The Agent Hub remains the lifecycle authority.

Search reports its backend and returns bounded output marked as untrusted external content. Codex results contain deduplicated titles, URLs, and snippets. The extension excludes credentials, encrypted output, unknown fields, and raw responses. The TUI shows a bounded source list and a short preview. The extension marks truncated output.

The SDK transport starts one bundled runtime lazily per Pi session. It reuses the runtime for later searches. Each tool invocation gets a fresh isolated SDK session and one prompt turn. Completion, failure, inactivity timeout, and cancellation close that search session. Pi session shutdown stops the runtime and removes its temporary state. Cancellation does not stop unrelated searches that share the runtime.

The legacy CLI transport starts one local process per search. Search never resends a failed prompt through another transport. A broken SDK connection can start again only for a later independent search.

Copilot Search and native Codex Search can use provider subscription quota. Neither backend exposes token or monetary usage for this retrieval. Search therefore returns no Pi `usage` or fabricated cost. It marks retrieval as `provider-accounted`, outside Pi's local totals. Usage Meter and `/stats` show provider quota as a live snapshot. They do not add balances, percentages, or limits to Pi's local token and cost totals. The package does not log or persist OAuth tokens or authenticated quota payloads.

GitHub does not publish a supported standalone REST API or direct GitHub MCP contract for `web_search`. The extension does not call private Copilot search endpoints.

## Hackler configuration

Hackler v2 uses `~/.pi/agent/subagents/config.json`, or the matching path under `PI_CODING_AGENT_DIR`.

The file requires `schemaVersion: 2`. Version 2 rejects version 1 keys.

```json
{
  "schemaVersion": 2,
  "runtime": {
    "maxActive": 4,
    "maxSharedWriters": 1,
    "maxDepth": 2,
    "maxWallSeconds": 2700,
    "maxTurns": 128,
    "wrapUpRatio": 0.8
  },
  "retention": {
    "days": 30,
    "entries": 200
  },
  "models": {
    "default": {
      "model": "inherit",
      "thinking": "low"
    },
    "overrides": {
      "worker": {
        "model": "github-copilot/gpt-5.6-luna",
        "thinking": "high"
      }
    }
  },
  "capabilities": {},
  "runners": {},
  "validators": {},
  "herdr": {
    "enabled": false,
    "direction": "right",
    "maxOutputBytes": 1000000
  },
  "profiles": {}
}
```

The manager checks the selected model and provider authentication before it allocates a session. Completed runs park automatically and release active capacity.

### Trusted patch validators

The optional global `validators` catalog defines report-only commands for pending isolated run or mission candidates:

```json
{
  "schemaVersion": 2,
  "validators": {
    "unit-tests": {
      "command": "node",
      "args": ["--test", "test/unit.test.js"],
      "timeoutMs": 300000,
      "maxOutputBytes": 1000000
    }
  }
}
```

Names are selected exactly by `subagent_validate` or the Agent Hub Validate action. `command` must contain a non-whitespace character and is preserved as one executable token. `args` is an array of literal string tokens; empty tokens and leading or trailing whitespace are preserved. `timeoutMs` accepts 1 through 600,000. `maxOutputBytes` accepts 1 through 1,048,576. Validator entries reject unknown keys and cannot configure environment variables. Project configuration cannot define validators.

Hackler uses direct trusted argv execution with `shell: false` and closed stdin. It creates a disposable detached worktree at the candidate base, applies only the exact stored patch, and runs in the equivalent relative directory. Combined stdout and stderr are bounded and retained with the latest candidate-and-validator record for the normal run or mission retention period. A cleanup quarantine also protects its owning record from retention. The source checkout and original Worker worktree remain outside the validator workspace.

Validation is explicit and report only. It never starts automatically, retries, ranks candidates, applies source changes, answers Integrate or Keep, or invokes a model provider. A nonzero exit or other ordinary check failure remains manually integrable after cleanup. Timeout, cancellation, session switch, shutdown, and restart do not retry the command. Active validation and unproven cleanup block integration. Unsafe workspaces are retained for manual inspection. This version has no Windows Job Object integration, so it cannot prove descendant termination after a Windows validator process starts. It quarantines that validation workspace even after the direct process exits normally.

A validator is not an operating-system sandbox. It inherits the Pi process environment and the user's OS authority. On POSIX, Hackler owns the spawned process group; a command that deliberately daemonizes into another session escapes that lifecycle boundary. Configure only reviewed, non-daemonizing commands. A pass supports only the behavior covered by that command; Hackler makes no broader correctness claim.

The runtime accepts 1 through 32 active runs and 0 through 8 shared writers. Nesting depth cannot exceed 2.

The wall limit accepts 1 through 2,700 seconds. The turn limit accepts 1 through 128 turns. The wrap ratio must be greater than zero and less than one.

A run uses the minimum applicable global, profile, and external-runner wall limit. A non-external run uses the minimum global and profile turn limit.

Each start or revival opens a wall lease. A revival keeps the captured profile and capability policy, and later settings can only tighten limits.

`subagent_collect` waits 60 seconds by default. Set `timeoutSeconds` from 10 through 3,600 seconds for another bounded wait.

User profiles use `~/.pi/agent/subagents/agents/*.md`. Trusted project profiles use `<cwd>/.pi/agents/*.md`.

The user configuration owns capability extension paths, package names, executable prefixes, and environment-variable names. Project profiles can select these capabilities after project trust is active.

Run `/agents doctor --json` to inspect effective profile and capability policy. Run `/agents trace --json` to inspect the redacted runtime evaluation trace.

The trace excludes task text, reports, request text, ownership, and file paths. Read [the Hackler documentation](../packages/subagents/README.md) for the full schema and migration steps.

The activity widget shows active task status. `/agents` contains lineage, reports, requests, profile controls, and diagnostics. New transcripts stay at `<agent-dir>/subagents/sessions/<parent>/<child>`. Stats also reads the legacy `<agent-dir>/sessions/subagents` location.

See [Session Summary](../packages/session-summary/README.md) for title generation, provider requirements, usage accounting, and failure behavior. See feature-level READMEs for other command details, lifecycle rules, and security limits. Pi Memory is not part of this package.
