# Configuration

One Pi package delivers all resources. Use `pi config` to enable or disable them. The package has no home or work profiles and does not classify environments automatically.

## Provider-aware behavior

- Usage Meter runs with the active `github-copilot` or `openai-codex` provider.
- Session Summary uses the active provider. Copilot uses Luna. Codex tries Spark before Luna. Other providers use their active model by default.
- The `search` tool selects its backend at run time. `github-copilot` uses the authenticated local Copilot CLI. `openai-codex` uses native `/codex/alpha/search` with refreshed Pi OAuth. Other providers receive an availability error. The tool does not use a cross-provider fallback.
- Hackler resolves model policy when it starts. Resolution checks an explicit review override, `models.overrides`, profile frontmatter, `models.default`, and the parent snapshot. `inherit` selects the parent value.

Use the [Hackler model-selection guide](../packages/subagents/MODEL_SELECTION.md) to compare models and thinking levels with provider-neutral criteria and local tests.

### Hackler model providers

Hackler model IDs include the provider name. Child sessions use the selected model through Pi's model runtime. They do not run the `copilot` executable.

| Pi provider | Example Hackler model | Authentication |
| --- | --- | --- |
| GitHub Copilot | `github-copilot/gpt-5.6-luna` | Pi's GitHub Copilot login flow or `COPILOT_GITHUB_TOKEN` |
| OpenAI Codex | `openai-codex/gpt-5.6-luna` | `/login openai-codex` |

The local `copilot` CLI and `copilot login` are required only when the Search integration uses the Copilot CLI. Hackler workers that use Pi's `github-copilot` provider do not need them.

## Configuration variables

- `PI_EXTENSIONS_LARGE_PASTE_CACHE_DIR`: private cache location for Large Paste files.
- `PI_WINDOWS_TOAST_APP_ID`: optional Windows toast application identity.
- `PI_COPILOT_SEARCH_TIMEOUT_MS`: Copilot CLI inactivity limit in milliseconds. Copilot output resets the timer. The default is 600,000 (10 minutes).
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

- **GitHub authentication:** Usage Meter reads Pi's GitHub Copilot credentials or falls back to `gh auth token`. It then requests the trusted GitHub Copilot quota endpoint. The Copilot CLI is required only when `search` runs under `github-copilot`. Its model is `gpt-5.6-luna` with effort `none` for every search.
- **OpenAI Codex OAuth:** Usage Meter and Search require OpenAI Codex OAuth under `openai-codex`. Run `/login openai-codex`. Pi refreshes the credential for each direct request. Usage Meter requests subscription quota from the trusted HTTPS `chatgpt.com/backend-api/wham/usage` endpoint. Neither feature needs the Codex CLI. Both features reject plaintext and custom-host endpoints.
- **Hackler capabilities:** The user catalog can load trusted extensions, skills, and external command rules. Profiles select capability names. Project profiles cannot define implementation paths.
- **Herdr:** Hackler can open a raw display pane for a persisted child transcript. The Agent Hub remains the lifecycle authority.

Search reports its backend and returns bounded output marked as untrusted external content. Codex results contain deduplicated titles, URLs, and snippets. The extension excludes credentials, encrypted output, unknown fields, and raw responses. The TUI shows a bounded source list and a short preview. The extension marks truncated output.

Copilot CLI and native Codex Search can use provider subscription quota. Neither backend exposes token or monetary usage for this retrieval. Search therefore returns no Pi `usage` or fabricated cost. It marks retrieval as `provider-accounted`, outside Pi's local totals. Usage Meter and `/stats` show provider quota as a live snapshot. They do not add balances, percentages, or limits to Pi's local token and cost totals. The package does not log or persist OAuth tokens or authenticated quota payloads.

## Hackler configuration

Hackler v2 uses `~/.pi/agent/subagents/config.json`, or the matching path under `PI_CODING_AGENT_DIR`.

The file requires `schemaVersion: 2`. Version 2 rejects version 1 keys.

```json
{
  "schemaVersion": 2,
  "runtime": {
    "maxActive": 4,
    "maxSharedWriters": 1,
    "maxDepth": 2
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
  "herdr": {
    "enabled": false,
    "direction": "right",
    "maxOutputBytes": 1000000
  },
  "profiles": {}
}
```

The manager checks the selected model and provider authentication before it allocates a session. Completed runs park automatically and release active capacity.

User profiles use `~/.pi/agent/subagents/agents/*.md`. Trusted project profiles use `<cwd>/.pi/agents/*.md`.

The user configuration owns capability extension paths, package names, executable prefixes, and environment-variable names. Project profiles can select these capabilities after project trust is active.

Run `/agents doctor --json` to inspect effective profile and capability policy. Read [the Hackler documentation](../packages/subagents/README.md) for the full schema and migration steps.

The activity widget shows active task status. `/agents` contains lineage, reports, requests, profile controls, and diagnostics. New transcripts stay at `<agent-dir>/subagents/sessions/<parent>/<child>`. Stats also reads the legacy `<agent-dir>/sessions/subagents` location.

See [Session Summary](../packages/session-summary/README.md) for title generation, provider requirements, usage accounting, and failure behavior. See feature-level READMEs for other command details, lifecycle rules, and security limits. Pi Memory is not part of this package.
