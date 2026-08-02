# Configuration

All resources are delivered by one Pi package and can be enabled or disabled with `pi config`. There are no home/work profiles or automatic environment classification.

## Provider-aware behavior

- Usage Meter acts while the active model provider is `github-copilot` or `openai-codex`; the Copilot compaction workaround remains limited to `github-copilot`.
- The single `search` tool routes at execution time: `github-copilot` uses the authenticated local Copilot CLI, while `openai-codex` uses native `/codex/alpha/search` with Pi's refreshed OAuth. Other providers receive an explicit availability error; there is no cross-provider fallback.
- Subagents resolve model and thinking policy at spawn time: per-agent `~/.pi/agent/subagents/config.json`, trusted custom-agent frontmatter, Subagent defaults, then a parent snapshot. `inherit` explicitly selects the parent value. Luna is opt-in.

## Configuration variables

- `PI_EXTENSIONS_LARGE_PASTE_CACHE_DIR`: private cache location for Large Paste files.
- `PI_DISABLE_COPILOT_COMPACTION_BASE_URL_FIX=1`: disable the Copilot compaction workaround.
- `PI_WINDOWS_TOAST_APP_ID`: optional Windows toast application identity.
- `PI_SUBAGENT_CONTEXT_MODE_DIR`: explicit local Context Mode installation for optional child integration.
- `PI_CODING_AGENT_DIR` and `PI_CODING_AGENT_SESSION_DIR`: Pi's documented locations used by Stats and trusted user-global Subagent definitions. New Subagent transcripts live under `<agent-dir>/subagents/sessions`; Stats also scans normal and legacy session trees.
- `HERDR_ENV=1`, `HERDR_PANE_ID`, and `HERDR_SOCKET_PATH`: together opt an active Herdr pane into the Subagent backend. A partial set is treated as a configuration error.

## Optional capabilities

- **GitHub authentication:** Usage Meter reads Pi's GitHub Copilot credentials or falls back to `gh auth token`, then requests the trusted GitHub Copilot quota endpoint. The Copilot CLI itself is required only when `search` runs under `github-copilot`; its backend defaults to `gpt-5.6-luna` with effort `none` unless overridden.
- **OpenAI Codex OAuth:** Required when Usage Meter or Search runs under `openai-codex`. Use `/login openai-codex`; Pi resolves and refreshes the credential for each direct request. Usage Meter requests subscription quota directly from the trusted HTTPS `chatgpt.com/backend-api/wham/usage` endpoint, with no Codex CLI dependency. Both features reject plaintext and custom-host endpoints.
- **Context Mode:** Subagents discover it only when installed. Missing Context Mode does not prevent ordinary RPC subagents. Children use only the reviewed narrow bridge, never the full Context Mode extension.
- **RTK:** Worker children auto-detect RTK 0.23.0 or newer. Missing, outdated, failed, or timed-out probes are nonfatal and native command execution remains available.
- **UV:** Worker children require both the packaged UV extension and a successful `uv --version` probe. Unavailable UV falls back to native Pi Bash.
- **Herdr:** Attached-pane support is selected only after explicit environment and control-plane checks succeed. Normal Subagents use RPC. Current Herdr creates one non-focused `Subagents · <project>` tab, queries geometry for adaptive one-to-four-pane placement, reports bounded task metadata, supports explicit focus from `/agents`, and closes the tab with its final pane. Older installations fall back to adjacent splitting with a visible capability warning.

Search reports the selected backend immediately and returns bounded output labeled as untrusted external content. Codex structured results are normalized to deduplicated titles, URLs, and snippets; credentials, encrypted output, unknown fields, and raw responses are excluded. Expanded TUI output shows only a bounded source list and short preview. Truncation is explicit.

Copilot CLI and Codex native search can consume provider subscription quota, but their retrieval responses expose no token or monetary usage. Search therefore returns no Pi `usage` or fabricated cost and marks consumption as `provider-accounted`, outside Pi's local totals. Usage Meter and `/stats` display provider quota only as a live snapshot; they never add balances, percentages, or limits to Pi's local token and cost totals. OAuth tokens and authenticated quota payloads are not logged or persisted.

## Subagent configuration

Create `~/.pi/agent/subagents/config.json` (or the corresponding path beneath `PI_CODING_AGENT_DIR`) when roles should use different models. A recommended development setup is:

```json
{
  "agents": {
    "explorer": {
      "model": "openai-codex/gpt-5.6-luna",
      "thinking": "low"
    },
    "worker": {
      "model": "openai-codex/gpt-5.6-luna",
      "thinking": "high"
    }
  }
}
```

Explorer Luna/low is suitable for inexpensive parallel investigation and review; Worker Luna/high is suitable for the persistent implementation owner. This is a recommended example, not a hard-coded requirement, and the provider must be configured and authenticated. Resolution happens when each child spawns. Open children keep their original model and thinking level. Run `/reload` after editing configuration, then use `subagent_list` or `/agents` to verify the effective model of a newly spawned child.

Configured models and provider authentication are preflighted before child files, processes, or Herdr layouts are allocated. Up to four running/completed children may remain open, including one Worker. Use `subagent_close` or `x` in `/agents` to release completed capacity. Failed and interrupted children release automatically.

Optional child resources are configured under `resources` in `defaults` or an agent entry. Built-in mode defaults resolve first, followed by `defaults.resources`, the mode entry, and the exact custom-agent entry. `contextMode`, `rtk`, and `uv` accept `"auto"`, `"enabled"`, or `"disabled"`; requested integrations that are missing only produce diagnostics and never block spawning.

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
        "uv": "disabled",
        "copilotCompactionFix": true
      }
    },
    "worker": {
      "resources": {
        "contextMode": "auto",
        "contextExecution": true,
        "webSearch": false,
        "todos": true,
        "rtk": "auto",
        "uv": "auto",
        "copilotCompactionFix": true
      }
    }
  }
}
```

Explorers cannot enable Context execution, Todos, RTK, or UV. Workers may explicitly enable Web Search. Explorer search retrieval uses separately provider-accounted usage. Arbitrary extension and skill paths are prohibited. Capability diagnostics appear in spawn, list, and read results and in expanded `/agents` details.

The always-visible task-first activity widget is not controlled by Ctrl+O; `/agents` contains full history, reports, Herdr focus, and cleanup. New transcripts are hidden from `/resume` at `<agent-dir>/subagents/sessions/<parent>/<child>`. Stats also reads the unchanged legacy `<agent-dir>/sessions/subagents` location, so migration is optional.

See feature-level READMEs for specific commands, lifecycle, and security limits. Pi Memory and Session Summary are not supplied by this package.
