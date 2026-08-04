# Pi Extensions

A modular collection of extensions for [Pi](https://pi.dev), installed together from one Git repository. General features work with any compatible provider; provider-specific and optional integrations stay dormant until their capability is available.

> **Security:** Pi extensions execute code with your user permissions. Review this repository and every update before installing it.

## Install

```bash
pi install git:github.com/MojangPlsFix/pi-extensions
```

Run `/reload` in an existing Pi session after installing. To update Git-installed packages later:

```bash
pi update --extensions
```

## Extensions

| Extension | What it does | Commands and tools | Availability |
| --- | --- | --- | --- |
| [Ask User Question](packages/ask-user-question/) | Gives the model a structured, reviewable UI for single-choice, multi-select, and custom questions. | `ask_user_question` | Interactive sessions |
| [Plan Mode](packages/plan-mode/) | Adds a read-oriented planning workflow, plan review, and controlled transition into implementation. | `/plan`, `/plan off`, `/plan-implement`, `/plan-implement fresh` | Any provider |
| [Notify](packages/notify/) | Sends a desktop or terminal notification when an assistant turn completes. | `/notify-test`, `/notify-toggle`, `/notify-status` | Windows, WSL, and supported terminals |
| [Todos](packages/todos/) | Stores durable project-local work items with status, tags, assignment, and locking for concurrent sessions. | `/todos`, `todo` | Any provider |
| [Context Size](packages/context-size/) | Temporarily limits the active model's context window and shows the selected limit in the status area. | `/context`, `/context 128k`, `/context auto` | Any model |
| [Large Paste](packages/large-paste/) | Saves input over 20,000 characters to a private bounded cache and sends the model a file reference instead. | Automatic | All sessions |
| [Model Cost Badges](packages/model-cost-badges/) | Displays the selected model's input, cache, output, and long-context API prices in Pi's model selector. | Automatic | Interactive model selector |
| [Stats](packages/stats/) | Restores the Bitbucket-style local Pi usage report with summaries, daily/weekly rows, model/project breakdowns, Subagent subsets, and optional Copilot start-credit history. | `/stats`, `/stats all`, `/stats week`, `/stats month`, `/stats previous` | Local session history; optional Copilot snapshots only |
| [Subagents](packages/subagents/) | Runs model-configurable isolated Explorer or Worker sessions with explicit lifecycle, hidden transcripts, reports, and a complete activity overlay. | `/agents`, `/agents help`, `subagent_spawn`, `subagent_send`, `subagent_wait`, `subagent_list`, `subagent_read`, `subagent_interrupt`, `subagent_close` | RPC by default; child integrations auto-detected |
| [UV](packages/uv/) | Replaces Pi's Bash tool with a UV-aware wrapper and redirects unsafe `pip`, Poetry, `venv`, and bytecode commands toward UV workflows. | `bash` replacement | All sessions |
| [Working Indicator](packages/working-indicator/) | Sole owner of the always-visible Pi-themed, task-first Subagent activity block and animated `Hackeln...` summary. | Automatic | Running, ready, and recent Subagents |
| [Web Search](packages/web-search/) | Routes bounded web and documentation retrieval through the active provider, returns normalized source evidence, and shows backend-aware progress/results. | `search` | `github-copilot` + authenticated Copilot CLI, or authenticated `openai-codex` |
| [Usage Meter](packages/usage-meter/) | Displays live GitHub Copilot or OpenAI Codex quota without retaining credentials or authenticated payloads. | `/usage-meter` | Active `github-copilot` or authenticated `openai-codex` model |
| [Copilot Compaction Fix](packages/copilot-compaction-fix/) | Applies the Copilot-specific compaction and branch-summary request workaround when needed. | Automatic | Active `github-copilot` model |

All 14 extension entrypoints are installed together. Missing optional tools do not prevent Pi from starting:

- **GitHub authentication** from Pi's Copilot credentials or `gh auth token` supplies Usage Meter quota for `github-copilot`; the Copilot CLI is needed only for Search.
- **OpenAI Codex OAuth** supplies Usage Meter quota and Search while the active provider is `openai-codex`; run `/login openai-codex`. No Codex CLI is required.
- **Herdr** is optional; Subagents normally use persistent Pi RPC children. When available, one non-focused task-named Subagents tab uses an adaptive one-to-four-pane layout and closes deterministically.
- **Context Mode** is discovered only for the narrow optional Subagent integration.
- **RTK 0.23+** and a working **UV** executable are auto-detected only for Worker children; either can be absent without blocking spawn, and native Pi Bash remains the fallback.

Search intentionally defaults Copilot CLI retrieval to `gpt-5.6-luna` with reasoning effort `none`; Codex uses native `/codex/alpha/search`. Both return bounded, untrusted external evidence with safe normalized sources while the active parent model handles substantive analysis. Retrieval consumption is provider-accounted because neither backend exposes usage or cost for inclusion in Pi's local totals.

### Stats periods and viewer

`/stats` and `/stats workweek` show the current Monday-Friday workweek; `/stats week` is an
alias. `/stats all` shows the Monday-Sunday calendar week, and `/stats month` shows the local
calendar month. Add `previous` or a negative offset such as `-2` to browse historical selected
periods. In the TUI, the read-only stats modal supports `↑`/`↓` scrolling, PageUp/PageDown,
Home/End, `←`/`→` historical navigation, `m`/`w` month/workweek switching, and `Esc`/`q` close.

Stats includes a `SUMMARY`, a `SUBAGENTS (included above)` subset, complete daily rows for week
views, monthly `WEEKLY` rows, and cost/token/response/session model and project tables. For an
active `github-copilot` model it may record one daily account-level checkpoint at
`<agent-dir>/copilot-credit-snapshots.json`; the daily table labels that independent value
`Start Credits`. Copilot credits never enter Pi totals, and non-Copilot stats runs do not invoke
Copilot quota retrieval. The standalone `/usage-meter` extension remains responsible for live
provider quota display.

## Skills

| Skill | Purpose |
| --- | --- |
| `bro` | Restate the last message in plain human language without jargon. |
| `subagent-orchestration` | Coordinate isolated Explorer and Worker Subagents. |
| `web-search` | Guide bounded current web and documentation research. |

## Configuration

For inexpensive parallel investigation and a high-effort implementation owner, this recommended Subagent setup can be copied to `~/.pi/agent/subagents/config.json`:

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

This is not a hard-coded default. Configure and authenticate the provider, run `/reload` after editing, and use `subagent_list` or `/agents` to verify newly spawned children. Model resolution happens at spawn time, so existing open children retain their model and thinking level.

See [Configuration](docs/configuration.md) for environment variables, child resource policies, provider-aware behavior, and optional capabilities. Feature directories include additional notes for Plan Mode, Subagents, Usage Meter, Copilot features, Todos, Stats, Notify, and Ask User Question.

## Development

Requires Node.js 22 or newer and a current Pi installation.

```bash
npm install
npm run check
```

See [Development](docs/development.md) for individual validation commands and an isolated local runtime check. npm publication is disabled; this package is distributed through Git and has no install lifecycle scripts.

## License and attribution

Licensed under the [MIT License](LICENSE). See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for upstream acknowledgements and direct links to their licenses.
