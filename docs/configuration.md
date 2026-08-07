# Configuration

One Pi package delivers all resources. Use `pi config` to enable or disable them. The package has no home or work profiles and does not classify environments automatically.

## Provider-aware behavior

- Usage Meter runs with the active `github-copilot` or `openai-codex` provider.
- The `search` tool selects its backend at run time. `github-copilot` uses the authenticated local Copilot CLI. `openai-codex` uses native `/codex/alpha/search` with refreshed Pi OAuth. Other providers receive an availability error. The tool does not use a cross-provider fallback.
- Subagents resolve the model and thinking policy when they start. Resolution checks per-agent `~/.pi/agent/subagents/config.json`, trusted custom-agent frontmatter, Subagent defaults, and the parent snapshot, in that order. `inherit` selects the parent value. Luna is opt-in.

### Subagent model providers

Subagent model IDs include the provider name. Children start Pi with the selected model. They do not run the `copilot` executable.

| Pi provider | Example Subagent model | Authentication |
| --- | --- | --- |
| GitHub Copilot | `github-copilot/gpt-5.6-luna` | Pi's GitHub Copilot login flow or `COPILOT_GITHUB_TOKEN` |
| OpenAI Codex | `openai-codex/gpt-5.6-luna` | `/login openai-codex` |

The local `copilot` CLI and `copilot login` are required only when the Search integration uses the Copilot CLI. Subagent Workers that use Pi's `github-copilot` provider do not need them.

## Configuration variables

- `PI_EXTENSIONS_LARGE_PASTE_CACHE_DIR`: private cache location for Large Paste files.
- `PI_WINDOWS_TOAST_APP_ID`: optional Windows toast application identity.
- `PI_COPILOT_SEARCH_TIMEOUT_MS`: Copilot CLI inactivity limit in milliseconds. Copilot output resets the timer. The default is 600,000 (10 minutes).
- `PI_SUBAGENT_CONTEXT_MODE_DIR`: explicit local Context Mode installation for optional child integration.
- `PI_CODING_AGENT_DIR` and `PI_CODING_AGENT_SESSION_DIR`: documented Pi locations for Stats and trusted user-global Subagent definitions. New Subagent transcripts use `<agent-dir>/subagents/sessions`. Stats also scans normal and legacy session trees.
- `HERDR_ENV=1`, `HERDR_PANE_ID`, and `HERDR_SOCKET_PATH`: together select the Herdr backend. A partial set produces a configuration error.

## Optional capabilities

- **GitHub authentication:** Usage Meter reads Pi's GitHub Copilot credentials or falls back to `gh auth token`. It then requests the trusted GitHub Copilot quota endpoint. The Copilot CLI is required only when `search` runs under `github-copilot`. Its model is `gpt-5.6-luna` with effort `none` for every search.
- **OpenAI Codex OAuth:** Usage Meter and Search require OpenAI Codex OAuth under `openai-codex`. Run `/login openai-codex`. Pi refreshes the credential for each direct request. Usage Meter requests subscription quota from the trusted HTTPS `chatgpt.com/backend-api/wham/usage` endpoint. Neither feature needs the Codex CLI. Both features reject plaintext and custom-host endpoints.
- **Context Mode:** Subagents discover Context Mode only when it is installed. A missing installation does not block normal RPC Subagents. Children use the reviewed narrow bridge, not the full Context Mode extension.
- **RTK:** Worker children detect RTK 0.23.0 or newer. A missing, old, failed, or timed-out probe does not block a Worker. Native command execution remains available.
- **UV:** Worker children require the packaged UV extension and a successful `uv --version` probe. When UV is unavailable, Pi uses native Bash.
- **Herdr:** Attached-pane support requires explicit environment variables and successful control-plane checks. Normal Subagents use RPC. Herdr creates one non-focused `Subagents · <project>` tab, queries geometry for one to four panes, reports bounded task metadata, supports focus through `/agents`, and closes the tab after its final pane closes. Older Herdr versions use adjacent splits and show a capability warning.

Search reports its backend and returns bounded output marked as untrusted external content. Codex results contain deduplicated titles, URLs, and snippets. The extension excludes credentials, encrypted output, unknown fields, and raw responses. The TUI shows a bounded source list and a short preview. The extension marks truncated output.

Copilot CLI and native Codex Search can use provider subscription quota. Neither backend exposes token or monetary usage for this retrieval. Search therefore returns no Pi `usage` or fabricated cost. It marks retrieval as `provider-accounted`, outside Pi's local totals. Usage Meter and `/stats` show provider quota as a live snapshot. They do not add balances, percentages, or limits to Pi's local token and cost totals. The package does not log or persist OAuth tokens or authenticated quota payloads.

## Subagent configuration

Create `~/.pi/agent/subagents/config.json`, or the matching path under `PI_CODING_AGENT_DIR`, when roles need different models. This setup is suitable for development:

```json
{
  "agents": {
    "explorer": {
      "model": "github-copilot/gpt-5.6-luna",
      "thinking": "low"
    },
    "worker": {
      "model": "github-copilot/gpt-5.6-luna",
      "thinking": "high"
    }
  }
}
```

Explorer Luna with low thinking uses less quota for parallel investigation and review. The built-in Reviewer role is also read-only and is selected temporarily by `/plan-review`; its explicit model overrides normal role configuration only for that review. Worker Luna with high thinking suits the persistent implementation owner. This example uses GitHub Copilot because it is the active provider on this PC. A Codex installation can replace the model prefix with `openai-codex` and use `/login openai-codex`. This setup is a recommendation, not a requirement. Configure and authenticate the selected provider. Pi resolves the model when each child starts. Existing children keep their model and thinking level. Run `/reload` after you edit the file. Use `subagent_list` or `/agents` to verify a new child.

Before Subagents allocates child files, processes, tabs, or panes, it checks the selected model and provider authentication. Up to four children can remain open. Only one can be a Worker. Use `subagent_close` or `x` in `/agents` to release capacity. Failed and interrupted children release capacity automatically.

Optional child resources use `resources` in `defaults` or an agent entry. Resolution checks built-in mode defaults, `defaults.resources`, the mode entry, and the exact custom-agent entry, in that order. `contextMode`, `rtk`, and `uv` accept `"auto"`, `"enabled"`, or `"disabled"`. A missing requested integration produces a diagnostic. It does not block spawning.

```json
{
  "agents": {
    "explorer": {
      "resources": {
        "contextMode": "auto",
        "contextExecution": false,
        "webSearch": true,
        "todos": false,
        "rtk": "disabled",
        "uv": "disabled"
      }
    },
    "worker": {
      "resources": {
        "contextMode": "auto",
        "contextExecution": true,
        "webSearch": false,
        "todos": true,
        "rtk": "auto",
        "uv": "auto"
      }
    }
  }
}
```

Explorers cannot enable Context execution, including `ctx_execute_file`, Todos, RTK, or UV. Workers can enable Web Search. The built-in Plan Mode Reviewer uses the Explorer restrictions and therefore never receives execution-only Context tools. Explorer Search uses separate provider-accounted quota. Arbitrary extension and skill paths are not allowed. Capability diagnostics appear in spawn, list, and read results and in expanded `/agents` details.

The activity widget shows task-first child status. `/agents` contains full history, reports, Herdr focus, and cleanup. New transcripts stay hidden from `/resume` at `<agent-dir>/subagents/sessions/<parent>/<child>`. Stats also reads the unchanged legacy `<agent-dir>/sessions/subagents` location. You do not need to migrate legacy transcripts.

See feature-level READMEs for command details, lifecycle rules, and security limits. Pi Memory and Session Summary are not part of this package.
