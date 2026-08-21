# Pi Extensions

This repository contains modular extensions for [Pi](https://pi.dev). It supports Pi 0.84+. Install all extensions from one Git repository. General features work with compatible providers. Provider-specific features stay inactive when the provider is unavailable.

> **Security:** Pi extensions run with your user permissions. Review this repository and each update before you install it.

## Install

```bash
pi install git:github.com/MojangPlsFix/pi-extensions
```

Run `/reload` in an active Pi session after installation. Update Git-installed packages with:

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
| [Codex Compaction](packages/codex-compaction/) | Uses OpenAI opaque checkpoints through Pi's compaction lifecycle at 90% context usage. | Automatic, `/compact` | Exact `openai-codex/openai-codex-responses` models |
| [Large Paste](packages/large-paste/) | Saves input over 20,000 characters to a private cache and sends a file reference to the model. | Automatic | All sessions |
| [Model Cost Badges](packages/model-cost-badges/) | Shows model input, cache, output, and long-context prices in the model selector. | Automatic | Interactive model selector |
| [Stats](packages/stats/) | Reports local usage with summaries, time periods, model and project breakdowns, Hackler subsets, and optional Copilot credit history. | `/stats`, `/stats all`, `/stats week`, `/stats month`, `/stats previous` | Local session history. Optional Copilot snapshots |
| [Hackler](packages/subagents/) | Runs profile-based child sessions with task ownership, parked reports, approvals, and reviewed worktree integration. | `/agents`, `/orchestrate`, `subagent_dispatch`, `subagent_status`, `subagent_collect`, `subagent_steer`, `subagent_stop` | Native Pi AgentSession by default. RPC and external runners are optional |
| [UV](packages/uv/) | Replaces the Pi Bash tool with a UV-aware wrapper and redirects unsafe Python environment commands to UV workflows. | `bash` replacement | All sessions |
| [Working Indicator](packages/working-indicator/) | Keeps Pi's normal loading indicator visible with `Hackler hackeln...` while native Hackler runs. | Automatic | Running, blocked, and completed Hackler runs |
| [Web Search](packages/web-search/) | Routes bounded web and documentation retrieval through the active provider. | `search` | `github-copilot` with Copilot CLI, or authenticated `openai-codex` |
| [Usage Meter](packages/usage-meter/) | Shows GitHub Copilot and OpenAI Codex quota without retaining credentials. | `/usage-meter` | Active `github-copilot` or authenticated `openai-codex` model |

The package installs all 15 extension entrypoints. Missing optional tools do not block Pi startup:

- **GitHub authentication:** Usage Meter uses Pi's Copilot credentials or `gh auth token` for `github-copilot`. Search requires the Copilot CLI.
- **OpenAI Codex OAuth:** Codex Compaction, Usage Meter, and Search use OpenAI Codex OAuth. Run `/login openai-codex`.
- **Herdr:** Hackler can open display-only transcript panes. Herdr does not run or prompt child agents.
- **Capabilities:** User configuration can load reviewed extensions, skills, and executable rules for selected profiles.
- **External runners:** The manager starts configured commands without a shell and sends tasks through stdin.

Search uses `gpt-5.6-luna` with no reasoning effort for every Copilot CLI retrieval. Codex uses native `/codex/alpha/search`. Both backends return bounded, untrusted source evidence. The active parent model handles the analysis. Retrieval uses provider-accounted quota because neither backend exposes usage or cost for local Pi totals.

### Stats periods and viewer

`/stats` and `/stats workweek` show the current Monday to Friday workweek. `/stats week` is an alias. `/stats all` shows the current Monday to Sunday calendar week. `/stats month` shows the current local calendar month. Add `previous` or a negative offset such as `-2` to browse an earlier period.

The TUI stats viewer supports `↑` and `↓`, PageUp, PageDown, Home, End, `←`, and `→` for navigation. Use `m` for month view, `w` for workweek view, and `Esc` or `q` to close the viewer.

Stats reports `SUMMARY` totals, a `HACKLER (included above)` subset, daily rows for week views, monthly `WEEKLY` rows, and model and project tables. For an active `github-copilot` model, Stats may record one daily account checkpoint at `<agent-dir>/copilot-credit-snapshots.json`. The daily table labels this value `Start Credits`. Copilot credits never enter Pi totals. The `/usage-meter` extension remains responsible for live provider quota.

## Skills

| Skill | Purpose |
| --- | --- |
| [Grilling](packages/grilling/) | Runs a design-tree interview before a plan or decision. | `/skill:grilling`, `/skill:grill-me` | Any provider. The structured dialog is optional. |
| `bro` | Restates the last message in plain human language. |
| `subagent-orchestration` | Coordinates profile-based Hackler runs with explicit ownership, batching, approvals, and integration. |
| `ste-writing` | Rewrites prose in ASD-STE100 Simplified Technical English. |
| `web-search` | Guides bounded current web and documentation research. |

## Configuration

Hackler v2 uses a versioned configuration at `~/.pi/agent/subagents/config.json`:

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

Authenticate the selected provider before you start a child. Run `/agents doctor` after a configuration change. Existing runs keep their captured model and policy.

See [Configuration](docs/configuration.md) for environment variables, Hackler capability policy, provider behavior, and optional integrations. Feature directories contain more notes for Plan Mode, Hackler, Usage Meter, Copilot features, Todos, Stats, Notify, and Ask User Question.

## Development

Use Node.js 22 or newer and a current Pi installation.

```bash
npm install
npm run check
```

See [Development](docs/development.md) for individual validation commands and an isolated runtime check. The package does not publish to npm. Git distributes the package. It has no install lifecycle scripts.

## License and attribution

This project uses the [MIT License](LICENSE). See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for upstream acknowledgements and license links.
