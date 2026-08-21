# Session Summary

Session Summary gives unnamed Pi sessions a short title for `/resume`. It runs after a completed TUI assistant turn.

The session must contain at least two messages and no manual name. Manual and backfill commands use the same provider rules.

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

Session Summary also respects the model output limit. It trims the transcript for the selected model context window, up to 80,000 characters.

The provider can return reasoning-only or truncated output. Session Summary records returned usage and tries the next profile model.

## Commands

- `/session-summary` generates or refreshes the current session title.
- `/session-summary-cost` shows total usage, cost, and a per-model breakdown.
- `/session-summaries` adds titles to unnamed sessions in the current project.

Set `PI_SESSION_SUMMARY=off` to disable automatic, manual, and backfill title generation.

## Persistence and accounting

Each request run writes a `session-summary` custom entry when it attempts a model. Successful runs also write the session name.

The custom entry stores the successful provider and model. It also stores each model attempt, returned usage, and combined usage.

Automatic runs attach combined usage to the parent assistant message. Attachment metadata lets Stats reassign that usage to each summary model.

Manual and backfill runs keep usage in the custom entry. Usage Meter includes this unattached usage and skips attached usage.

Stats keeps overall token and cost totals free from duplication. Its model table attributes each attempt to the model that handled it.

Readers continue to support historical `session-summary` entries without attempt or attachment metadata.

The extension does not provide daily exit summaries. Pi Memory is a separate feature.
