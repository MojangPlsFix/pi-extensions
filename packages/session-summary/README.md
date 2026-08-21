# Session Summary

Session Summary gives each unnamed Pi session a short title for `/resume`. It makes one automatic attempt after the first meaningful completed TUI turn.

An exact greeting or acknowledgment does not consume the attempt. A later task can start the attempt. A response with a tool call or a non-final stop reason does not consume it.

Before model lookup, the extension writes a `session-summary-auto-attempt` marker to the full session history. This marker prevents more automatic attempts after a restart or `/tree` navigation. Model, authentication, request, timeout, and empty-output failures all consume the attempt. The extension does not retry automatically.

A manual session name prevents automatic generation. The extension checks the name again before it saves a generated title.

## Working indicator and warnings

Pi keeps its current working indicator visible during the automatic request. Session Summary does not add a footer row or a persistent status line.

Automatic and manual title-generation successes are silent. An automatic failure shows one bounded warning. The persisted attempt marker prevents repeated automatic warnings.

`/session-summary` shows a warning for each failed manual request. `/session-summaries` shows one aggregate warning when one or more sessions fail.

The working indicator is temporary. Warnings are UI notifications, not status entries. Pi does not store them in the session file.

The generated title and automatic-attempt marker remain in the session file.

## Provider and model selection

Session Summary uses the active session provider. It never sends conversation data to a different provider.

Two providers have built-in profiles:

| Provider | Models, in request order |
| --- | --- |
| `github-copilot` | `gpt-5.6-luna` |
| `openai-codex` | `gpt-5.3-codex-spark`, then `gpt-5.6-luna` |

Other providers use the active model by default. Authenticate the active provider in Pi before you request a title.

Codex Spark has separate five-hour and weekly limits during its research preview. A successful Spark title does not use standard Codex/Work allowance.

The Luna fallback uses standard Codex/Work allowance. Provider limits and preview terms can change.

Session Summary tries each profile model in order. It continues after model, authentication, request, and empty-output failures.

All attempts share one 20-second deadline. The extension pins the first successful model for that provider during the current session.

The extension reports a bounded diagnostic if all candidates fail. It does not replace a configured profile with an unlisted model.

## Optional profiles

Use a global configuration file at:

```text
<agent-dir>/pi-session-summary.json
```

A trusted project can replace global entries at:

```text
<project>/.pi/pi-session-summary.json
```

`<agent-dir>` follows `PI_CODING_AGENT_DIR`. It defaults to `~/.pi/agent`.

Use this format:

```json
{
  "profiles": {
    "anthropic": ["claude-haiku-4-5"],
    "my-provider": ["cheap-summary-model"]
  }
}
```

Configuration precedence is:

1. Built-in profiles.
2. Global configuration.
3. Trusted-project configuration.

A provider entry replaces the lower-precedence entry. An empty array disables Session Summary for that provider.

Pi ignores missing files, invalid JSON, and malformed profile entries. Pi does not read project configuration before project trust is active.

## Request limits

Each title request uses the selected model through Pi's model registry. The request does not set a reasoning level.

The request disables prompt-cache retention and uses a fresh session ID. The output limit is at most 800 tokens.

An automatic request uses only the current user input and completed assistant response. The extension limits this input to 8,000 characters.

Manual and backfill requests can use the full transcript. The extension limits this input to 80,000 characters and respects the model context window.

The provider can return reasoning-only or truncated output. Session Summary records returned usage and tries the next profile model.

## Commands

- `/session-summary` generates or refreshes the current session title. It ignores the automatic-attempt marker.
- `/session-summary-cost` shows total usage, cost, and a per-model breakdown.
- `/session-summaries` adds titles to unnamed sessions in the current project.

Set `PI_SESSION_SUMMARY=off` to disable automatic, manual, and backfill title generation.

## Persistence and accounting

The write-ahead `session-summary-auto-attempt` marker contains no model usage. Stats and Usage Meter ignore it.

A run writes a `session-summary` custom entry when it attempts a model. A successful run also writes the session name.

The custom entry stores the run source, successful provider, and successful model. It also stores each model attempt, returned usage, and combined usage.

All current runs keep usage in the custom entry. Usage Meter includes this usage in the session total.

Stats keeps overall token and cost totals free from duplication. Its model table assigns each attempt to the model that handled it.

Readers continue to support historical entries with attached usage or without attempt metadata. Any historical `session-summary` entry also prevents a new automatic attempt.

The extension does not provide daily exit summaries. Pi Memory is a separate feature.
