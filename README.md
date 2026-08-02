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
| [Stats](packages/stats/) | Summarizes local Pi usage by period, model, project, and Subagent contribution without contacting a provider. | `/stats`, `/stats week`, `/stats month`, `/stats previous` | Local session history |
| [Subagents](packages/subagents/) | Runs isolated persistent explorer or worker Pi processes with follow-ups, interruption, usage tracking, and an activity viewer. | `/agents`, `subagent_spawn`, `subagent_send`, `subagent_wait`, `subagent_list`, `subagent_read`, `subagent_interrupt` | RPC by default; Herdr and Context Mode optional |
| [UV](packages/uv/) | Replaces Pi's Bash tool with a UV-aware wrapper and redirects unsafe `pip`, Poetry, `venv`, and bytecode commands toward UV workflows. | `bash` replacement | All sessions |
| [Working Indicator](packages/working-indicator/) | Shows the animated `Hackeln...` indicator and active explorer/worker counts while Subagents run. | Automatic | Active Subagents |
| [Web Search](packages/web-search/) | Routes bounded web and documentation retrieval through the active provider, returns normalized source evidence, and shows backend-aware progress/results. | `search` | `github-copilot` + authenticated Copilot CLI, or authenticated `openai-codex` |
| [Copilot Usage](packages/copilot-usage/) | Displays and refreshes the current GitHub Copilot quota without retaining credentials. | `/copilot-usage` | Active `github-copilot` model |
| [Copilot Compaction Fix](packages/copilot-compaction-fix/) | Applies the Copilot-specific compaction and branch-summary request workaround when needed. | Automatic | Active `github-copilot` model |

All 14 extension entrypoints are installed together. Missing optional tools do not prevent Pi from starting:

- **Copilot CLI** is needed for Search only while the active provider is `github-copilot`.
- **OpenAI Codex OAuth** is needed for Search only while the active provider is `openai-codex`; run `/login openai-codex`.
- **Herdr** is optional; Subagents normally use persistent Pi RPC children.
- **Context Mode** is discovered only for the narrow optional Subagent integration.

Search intentionally defaults Copilot CLI retrieval to `gpt-5.6-luna` with reasoning effort `none`; Codex uses native `/codex/alpha/search`. Both return bounded, untrusted external evidence with safe normalized sources while the active parent model handles substantive analysis. Retrieval consumption is provider-accounted because neither backend exposes usage or cost for inclusion in Pi's local totals.

## Configuration

See [Configuration](docs/configuration.md) for environment variables, provider-aware behavior, and optional capabilities. Feature directories include additional notes for Plan Mode, Subagents, Copilot features, Todos, Stats, Notify, and Ask User Question.

## Development

Requires Node.js 22 or newer and a current Pi installation.

```bash
npm install
npm run check
```

See [Development](docs/development.md) for individual validation commands and an isolated local runtime check. npm publication is disabled; this package is distributed through Git and has no install lifecycle scripts.

## License and attribution

Licensed under the [MIT License](LICENSE). See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for upstream acknowledgements and direct links to their licenses.
