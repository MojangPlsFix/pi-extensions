# Pi Extensions

This repository contains modular extensions for [Pi](https://pi.dev). It supports Pi 0.84+. Install all extensions from one Git repository. General features work with compatible providers. Provider-specific features stay inactive when the provider is unavailable.

> **Security:** Pi extensions run with your user permissions. Review this repository and each update before you install it.

## Install

```bash
pi install git:github.com/MojangPlsFix/pi-extensions

# Required external Context Mode engine for indexed tools
pi install npm:context-mode@1.0.169
```

Keep the npm package installed as a runtime, but disable all of its Pi resources so this repository remains the only tool owner. Replace its string entry in `~/.pi/agent/settings.json` with this filtered package entry:

```json
{
  "source": "npm:context-mode@1.0.169",
  "extensions": [],
  "skills": [],
  "prompts": [],
  "themes": []
}
```

Run `/reload` in an active Pi session after installation and filtering. Update Git-installed packages with:

```bash
pi update --extensions
```

## Extensions

| Extension | Purpose | Commands and tools | Availability |
| --- | --- | --- | --- |
| [Ask User Question](packages/ask-user-question/) | Gives the model a structured UI for single-choice, multi-select, and custom questions. | `ask_user_question` | Interactive sessions |
| [Plan Mode](packages/plan-mode/) | Adds a read-only planning workflow, advisory `/plan-review`, and controlled implementation steps. | `/plan`, `/plan off`, `/plan-review`, `/plan-implement`, `/plan-implement fresh` | Any provider |
| [Repository Reference](packages/repository-reference/) | Clones validated Git remotes and revisions into managed temporary paths with list, remove, and cleanup operations. | `repository_reference` | Any provider; no Context Mode dependency |
| [Notify](packages/notify/) | Sends a desktop or terminal notification after an assistant turn completes. | `/notify-test`, `/notify-toggle`, `/notify-status` | Windows, WSL, and supported terminals |
| [Todos](packages/todos/) | Stores project work items with status, tags, assignment, and locking. | `/todos`, `todo` | Any provider |
| [Context Size](packages/context-size/) | Sets a temporary context-window limit and shows it in the status area. | `/context`, `/context 128k`, `/context auto` | Any model |
| [Context Mode replacement](packages/context-mode/) | Owns cancellable Pi execution, indexed Context Mode tools, and the pinned session-memory/compaction lifecycle. | `ctx_execute`, `ctx_execute_file`, `ctx_batch_execute`, `ctx_index`, `ctx_search`, `ctx_fetch_and_index`, `ctx_stats`, `ctx_doctor` | Node 22+; requires filtered `context-mode@1.0.169` runtime |
| [Codex Compaction](packages/codex-compaction/) | Uses OpenAI opaque checkpoints through Pi's compaction lifecycle at 90% context usage. | Automatic, `/compact` | Exact `openai-codex/openai-codex-responses` models |
| [Large Paste](packages/large-paste/) | Saves input over 20,000 characters to a private cache and sends a file reference to the model. | Automatic | All sessions |
| [Model Cost Badges](packages/model-cost-badges/) | Shows model input, cache, output, and long-context prices in the model selector. | Automatic | Interactive model selector |
| [Stats](packages/stats/) | Reports local usage with summaries, time periods, model and project breakdowns, Subagent subsets, and optional Copilot credit history. | `/stats`, `/stats all`, `/stats week`, `/stats month`, `/stats previous` | Local session history. Optional Copilot snapshots |
| [Subagents](packages/subagents/) | Runs isolated Explorer and Worker sessions with reports, hidden transcripts, and activity status. | `/agents`, `/agents help`, `subagent_spawn`, `subagent_send`, `subagent_wait`, `subagent_list`, `subagent_read`, `subagent_interrupt`, `subagent_close` | RPC by default. Child integrations are optional |
| [UV](packages/uv/) | Replaces the Pi Bash tool with a UV-aware wrapper and redirects unsafe Python environment commands to UV workflows. | `bash` replacement | All sessions |
| [Working Indicator](packages/working-indicator/) | Owns the visible Pi-styled Subagent activity block and the animated `Hackeln...` summary. | Automatic | Running, ready, and recent Subagents |
| [Web Search](packages/web-search/) | Routes bounded web and documentation retrieval through the active provider. | `search` | `github-copilot` with Copilot CLI, or authenticated `openai-codex` |
| [Usage Meter](packages/usage-meter/) | Shows GitHub Copilot and OpenAI Codex quota without retaining credentials, with an optional Copilot AI-credit daily pace. | `/usage-meter` | Active `github-copilot` or authenticated `openai-codex` model |

The package installs all 16 extension entrypoints. Missing optional tools do not block Pi startup:

- **GitHub authentication:** Usage Meter uses Pi's Copilot credentials or `gh auth token` for `github-copilot`. Search requires the Copilot CLI.
- **OpenAI Codex OAuth:** Codex Compaction, Usage Meter, and Search use OpenAI Codex OAuth. Run `/login openai-codex`.
- **Herdr:** Subagents normally use persistent Pi RPC children. When Herdr is available, one non-focused task-named Subagents tab uses one to four panes and closes in a controlled way.
- **Context Mode replacement:** Install the external engine with `pi install npm:context-mode@1.0.169`, then use the filtered package entry above so none of the upstream package's Pi resources load. The runtime remains available to the indexed bridge while this repository stays the only tool owner. See [Context Mode](packages/context-mode/) for execution and indexing details.
- **RTK and UV:** Worker children detect RTK 0.23 or newer and a working UV executable. A missing tool does not block a Worker. Native Pi Bash remains the fallback.

Search uses `gpt-5.6-luna` with no reasoning effort for every Copilot CLI retrieval. Codex uses native `/codex/alpha/search`. Both backends return bounded, untrusted source evidence. The active parent model handles the analysis. Retrieval uses provider-accounted quota because neither backend exposes usage or cost for local Pi totals.

### Stats periods and viewer

`/stats` and `/stats workweek` show the current Monday to Friday workweek. `/stats week` is an alias. `/stats all` shows the current Monday to Sunday calendar week. `/stats month` shows the current local calendar month. Add `previous` or a negative offset such as `-2` to browse an earlier period.

The TUI stats viewer supports `↑` and `↓`, PageUp, PageDown, Home, End, `←`, and `→` for navigation. Use `m` for month view, `w` for workweek view, and `Esc` or `q` to close the viewer.

Stats reports `SUMMARY` totals, a `SUBAGENTS (included above)` subset, daily rows for week views, monthly `WEEKLY` rows, and model and project tables. For an active `github-copilot` model, Stats may record one daily account checkpoint at `<agent-dir>/copilot-credit-snapshots.json`. The daily table labels this value `Start Credits`. Copilot credits never enter Pi totals. The `/usage-meter` extension remains responsible for live provider quota. Finite Copilot AI-credit quotas also show the current workday’s remaining allowance and percentage before the monthly quota; weekends and missing or incompatible checkpoints show `daily: —`, while unlimited and premium-request quotas omit the label.

## Skills

| Skill | Purpose |
| --- | --- |
| [Grilling](packages/grilling/) | Runs a design-tree interview before a plan or decision. | `/skill:grilling`, `/skill:grill-me` | Any provider. The structured dialog is optional. |
| `bro` | Restates the last message in plain human language. |
| `subagent-orchestration` | Coordinates isolated Explorer and Worker Subagents. |
| `ste-writing` | Rewrites prose in ASD-STE100 Simplified Technical English. |
| `web-search` | Guides bounded current web and documentation research. |

## Configuration

Copy this recommended Subagent setup to `~/.pi/agent/subagents/config.json` when you want inexpensive parallel investigation and a high-effort implementation owner:

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

This example uses Pi's built-in `github-copilot` provider. Authenticate it through Pi's GitHub Copilot login flow or `COPILOT_GITHUB_TOKEN`. For OpenAI Codex, use `openai-codex/gpt-5.6-luna` after `/login openai-codex`. The `copilot` CLI is required only for Search. Run `/reload` after you edit the configuration. Use `subagent_list` or `/agents` to verify a new child. Pi resolves the model when the child starts. Existing children keep their model and thinking level.

See [Configuration](docs/configuration.md) for environment variables, child resource policies, provider behavior, and optional capabilities. Feature directories contain more notes for Plan Mode, Subagents, Usage Meter, Copilot features, Todos, Stats, Notify, and Ask User Question.

## Development

Use Node.js 22 or newer and a current Pi installation.

```bash
npm install
npm run check
```

See [Development](docs/development.md) for individual validation commands and an isolated runtime check. The package does not publish to npm. Git distributes the package. It has no install lifecycle scripts.

## License and attribution

This project uses the [MIT License](LICENSE). See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for upstream acknowledgements and license links.
