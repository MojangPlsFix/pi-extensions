# Configuration

All resources are delivered by one Pi package and can be enabled or disabled with `pi config`. There are no home/work profiles or automatic environment classification.

## Provider-aware behavior

- Copilot Usage and the Copilot compaction workaround act only while the active model provider is `github-copilot`.
- The single `search` tool routes at execution time: `github-copilot` uses the authenticated local Copilot CLI, while `openai-codex` uses native `/codex/alpha/search` with Pi's refreshed OAuth. Other providers receive an explicit availability error; there is no cross-provider fallback.
- Subagents inherit the parent model and thinking level unless a trusted user-global agent definition explicitly overrides them.

## Configuration variables

- `PI_EXTENSIONS_LARGE_PASTE_CACHE_DIR`: private cache location for Large Paste files.
- `PI_DISABLE_COPILOT_COMPACTION_BASE_URL_FIX=1`: disable the Copilot compaction workaround.
- `PI_WINDOWS_TOAST_APP_ID`: optional Windows toast application identity.
- `PI_SUBAGENT_CONTEXT_MODE_DIR`: explicit local Context Mode installation for optional child integration.
- `PI_CODING_AGENT_DIR` and `PI_CODING_AGENT_SESSION_DIR`: Pi's documented locations used by Stats and trusted user-global Subagent definitions.

## Optional capabilities

- **Copilot CLI:** Required only when `search` runs under `github-copilot`. Invoking Search without an installed, authenticated CLI reports a useful error. The CLI backend defaults to `gpt-5.6-luna` with effort `none` unless overridden.
- **OpenAI Codex OAuth:** Required only when `search` runs under `openai-codex`. Use `/login openai-codex`; Pi resolves and refreshes the credential for every native search request. Search sends OAuth only to the trusted HTTPS `chatgpt.com` endpoint and rejects plaintext or custom-host overrides.
- **Context Mode:** Subagents discover it only when installed. Missing Context Mode does not prevent ordinary RPC subagents.
- **Herdr:** Attached-pane support is selected only after explicit environment and control-plane checks succeed. Normal subagents use RPC.

Search reports the selected backend immediately and returns bounded output labeled as untrusted external content. Codex structured results are normalized to deduplicated titles, URLs, and snippets; credentials, encrypted output, unknown fields, and raw responses are excluded. Expanded TUI output shows only a bounded source list and short preview. Truncation is explicit.

Copilot CLI and Codex native search can consume provider subscription quota, but their retrieval responses expose no token or monetary usage. Search therefore returns no Pi `usage` or fabricated cost and marks consumption as `provider-accounted`, outside Pi's local totals.

See feature-level READMEs for specific commands and limits. Pi Memory and Session Summary are not supplied by this package.
