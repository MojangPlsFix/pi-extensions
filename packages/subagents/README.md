# Subagents

Subagents run isolated, persistent child Pi sessions for parallel investigation and focused implementation. The parent remains responsible for decisions, review, and integration.

## Roles

- **Explorer** is the default read-only role. It investigates code, architecture, documentation, and current web topics. Its reviewed tools do not include file mutation.
- **Worker** handles delegated file changes. At most one Worker can remain open. Workers cannot start or resume while Plan Mode is active.
- **Plan Reviewer** (`plan-reviewer`) is a built-in read-only Explorer role used by Plan Mode `/plan-review`. It is spawned through the manager service bridge, waits for a report, and closes automatically. A per-review model selection overrides normal role/configuration/parent precedence only for that reviewer.
- Trusted custom agents can use Markdown files in `~/.pi/agent/subagents/agents/`. The package ignores project-controlled definitions.

Children cannot start their own Subagents or ask users questions. They return questions and blockers to the parent.

## Models and thinking levels

Pi resolves model policy when the child starts. It checks these sources in order:

1. Per-agent settings.
2. Trusted custom-agent frontmatter.
3. Subagent defaults.
4. The parent model and thinking level at spawn time.

Create `~/.pi/agent/subagents/config.json` to configure roles. This development setup uses Luna with low thinking for inexpensive investigation and Luna with high thinking for the persistent implementation owner:

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

This setup is a recommendation, not a hard-coded requirement. The example uses Pi's built-in `github-copilot` provider. Authenticate it through Pi's GitHub Copilot login flow or `COPILOT_GITHUB_TOKEN`. A Codex installation can use `openai-codex/gpt-5.6-luna` after `/login openai-codex`. The `copilot` CLI and `copilot login` are required only for the separate Search integration. They are not required for Subagent children.

Pi resolves a model when a child starts. Explicit per-call model overrides take precedence over per-agent settings, custom frontmatter, defaults, and the parent snapshot. Existing children keep their model and thinking level. `inherit` takes the parent snapshot at that time. Later parent model changes do not affect an open child. Luna is opt-in. Pi has no built-in Luna default.

Before it allocates transcript directories, child processes, tabs, or panes, Subagents checks that Pi can resolve the selected model and provider authentication. Invalid configuration or missing authentication produces an actionable error.

Custom definition frontmatter can include `model` and `thinking`:

```md
---
name: careful-reviewer
description: Read-only review specialist
mode: explorer
model: inherit
thinking: high
---
Review the delegated scope and return evidence without modifying files.
```

## Tools

| Tool | Purpose |
| --- | --- |
| `subagent_spawn` | Starts an Explorer by default or a trusted role that you select. It returns after prompt acceptance. |
| `subagent_send` | Queues non-destructive guidance or resumes an open child. |
| `subagent_wait` | Waits for one or all running children to settle. |
| `subagent_list` | Shows roles, model policy, capacity, backend capabilities, lifecycle guidance, and known children. |
| `subagent_read` | Reads the latest report, status, usage, and diagnostics. |
| `subagent_interrupt` | Stops a running child and releases its open capacity. |
| `subagent_close` | Terminates transport and pane state while it keeps the report available. |

Continue independent parent work after you spawn a child. Read completed reports. Close children when you do not need follow-up.

## Lifecycle and capacity

Up to four Subagents can remain open. Only one can be a Worker.

- `running`: the child has an active turn and uses capacity.
- `completed`: the report is ready. The child remains open and uses capacity.
- `failed` or `interrupted`: recent history remains. Transport and capacity release at once.
- `closed`: the report remains readable. Transport ends and capacity becomes free.

Parent quit, reload, `/new`, `/resume`, and session replacement close every child. Cleanup waits for poller cancellation, RPC termination, forced-kill fallback, Herdr pane and tab closure, and temporary Context Mode and Todo directory removal.

## Activity UI and `/agents`

The working-indicator extension owns the Pi-styled inline activity block. It shows running children first, then completed open children, then recent failed, interrupted, or closed history. It shows at most four rows.

Wide terminals show role, status, model, effort, duration, and current activity. Narrow terminals remove lower-priority metadata but keep the task. Animation stops when no child runs. Ctrl+O expands tool output. It does not hide the activity block.

Completion cards use Pi's normal custom-message shell. Compact cards show the task, role, status, model, duration, usage, and a report preview. Ctrl+O expands the full report and diagnostics.

`/agents` shows complete interactive history. `/agents help` documents these controls:

- Up and Down: navigate.
- Enter: guide or resume an open child.
- `s`: stop and redirect a running child.
- `f`: focus its Herdr pane.
- `x`: close the child and release capacity.
- `?`: show help.
- Escape: close the overlay.

## Herdr

RPC is the normal backend. It does not require Herdr. A complete explicit Herdr environment with `HERDR_ENV=1`, `HERDR_PANE_ID`, and `HERDR_SOCKET_PATH` selects Herdr after control-plane verification. An incomplete or broken explicit environment blocks spawning. It does not silently select RPC.

Herdr creates one non-focused tab in the parent workspace. It labels the tab from the parent tab, such as `<parent tab label> - Subagents`. If the parent label is unavailable, it uses `Subagents`. The visible label never uses the cwd, project name, or username. `/agents` and pane metadata keep the parent workspace, Subagents tab, and pane IDs.

Herdr never takes focus by itself. One to four open children use the tab root pane and an adaptive layout. Before each split, Subagents checks current geometry. It selects the largest owned pane and splits right at `0.5` when the pane is at least twice as wide as tall. Otherwise, it splits down. It checks geometry again after closures.

Herdr's public CLI has no tab insertion or reorder operation. A new Subagents tab appears after existing workspace tabs. Exact placement after the orchestrator needs a future Herdr `--after` or tab-move capability. Subagents does not use undocumented reorder commands.

Pane titles use bounded task labels such as `Explorer · Trace auth flow`. They do not use internal IDs or full prompts. Guidance and redirects update the title. Metadata shows the role, an investigating, implementing, ready, blocked, or closed state, bounded model data, and a monotonic sequence number. Canonical IDs remain internal. Use `f` in `/agents` to focus a pane.

When another process deletes a pane, Subagents treats it as released. It does not retry forever. The dedicated tab closes after its last owned pane releases. Older Herdr versions use adjacent splits and show a capability warning.

## Sessions and Stats

New child transcripts stay hidden from Pi's `/resume` picker:

```text
~/.pi/agent/subagents/sessions/<parent>/<child>/
```

Stats scans normal Pi sessions, this hidden tree, and the legacy `~/.pi/agent/sessions/subagents/` tree. It does not count a child twice. Legacy transcripts stay in place. To migrate them, stop Pi, back up both trees, and move individual parent directories by hand. Migration is optional because Stats reads both locations.

Pi has no extension hook for nested children in the built-in `/resume` picker. Durable cross-parent restoration and nested resume remain deferred.

## Optional child resources

Child resources use a `resources` object in `defaults`, a built-in mode entry, or an exact custom-agent entry. Resolution checks the built-in mode profile, `defaults.resources`, the mode entry, and the exact custom-agent entry, in that order. Optional integrations accept `"auto"`, `"enabled"`, or `"disabled"`. `auto` activates an installed capability. `enabled` requests it and warns when it is unavailable. `disabled` skips probing and loading.

| Resource | Explorer | Worker |
| --- | --- | --- |
| Context Mode | Auto-detect | Auto-detect |
| Context execution | Never | When Context Mode is active |
| `ctx_execute_file` | Never (execution-only) | When Context Mode execution is active |
| Web Search | Enabled | Disabled by default |
| Todos | Disabled | Enabled |
| RTK | Never | Auto-detect |
| UV Bash policy | Never | Auto-detect |

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

Explorers remain read-only. They cannot enable Context execution, Todos, RTK, or UV. Explorer Web Search is enabled by default. Its retrieval calls use separate provider-accounted quota. Workers can enable Web Search. Arbitrary child extension and skill paths are not accepted.

Context Mode uses only the package-owned narrow child bridge. It does not use the full extension. A missing Context Mode installation never blocks a child. RTK needs version 0.23.0 or newer and fails open. UV needs the package extension and a working `uv` executable. When UV is unavailable, native Pi Bash remains active. When both tools are active, RTK rewrites commands before UV validates and executes them. Todo and Context Mode state is temporary and isolated.

Capability state appears in spawn, read, and list results, expanded completion cards, and `/agents`. An example is `UV: enabled → unavailable; native Bash active`.

Subagents use separate processes, not a security boundary. They inherit the user's process credentials so configured providers can authenticate. Review this extension, child prompts, trusted global definitions, delegated tasks, and Worker changes. Herdr receives only reviewed path overrides. Parent credentials never enter `herdr --env` arguments. Full prompts never become pane labels. Transcript content remains sensitive local data.
