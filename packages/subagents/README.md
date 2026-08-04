# Subagents

Subagents runs isolated, persistent child Pi sessions for parallel investigation and focused implementation. The parent remains responsible for decisions, review, and integration.

## Roles

- **Explorer** is the default for read-only code investigation, architecture, documentation, and current web research. Its reviewed tool set does not include file mutation.
- **Worker** is only for delegated tasks that must modify files. At most one Worker may remain open, and Workers cannot start or resume while Plan Mode is active.
- Trusted custom agents may be defined as Markdown files in `~/.pi/agent/subagents/agents/`. Project-controlled definitions are intentionally ignored.

Children cannot recursively start Subagents or ask the user directly. They return questions and blockers to the parent.

## Models and thinking levels

Model policy is resolved once when the child spawns:

1. per-agent settings;
2. trusted custom-agent frontmatter;
3. Subagent defaults;
4. the parent model and thinking level at spawn time.

Create `~/.pi/agent/subagents/config.json` to configure roles. This recommended development setup uses inexpensive Luna/low Explorers for parallel investigation and review, and a Luna/high Worker as the persistent implementation owner:

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

This is a reproducible recommendation, not a hard-coded requirement. The selected provider must be configured and authenticated. Model resolution occurs when a child spawns; existing open children retain their original model and thinking level. Run `/reload` after changing the file, then use `subagent_list` or `/agents` to verify the effective model of newly spawned children.

`inherit` explicitly takes the parent snapshot immediately; later parent model changes do not affect an open child. Luna is opt-in—there is no built-in Luna default. Before allocating transcript directories, child processes, tabs, or panes, Subagents verifies that an explicitly resolved model exists and that Pi can resolve its provider authentication. Invalid configuration or missing auth fails with an actionable error.

Custom definition frontmatter may include `model` and `thinking`:

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
| `subagent_spawn` | Start an Explorer by default or an explicitly selected trusted role. Returns after prompt acceptance. |
| `subagent_send` | Queue non-destructive guidance or resume a completed/open child. |
| `subagent_wait` | Wait for one or all currently running children to settle. |
| `subagent_list` | Show roles, model policy, capacity, backend capabilities, lifecycle guidance, and all known children. |
| `subagent_read` | Read the latest report, status, usage, and diagnostics. |
| `subagent_interrupt` | Interrupt a running child and immediately release its open capacity. |
| `subagent_close` | Explicitly terminate transport and pane state while retaining the report for later reads. |

Continue independent parent work after spawning when useful instead of waiting immediately. Read completed reports and close agents when no follow-up is needed.

## Lifecycle and capacity

Up to four Subagents may remain **open**, with at most one open Worker.

- `running`: an active turn; open and consuming capacity.
- `completed`: report ready and retained for follow-ups; still open and consuming capacity.
- `failed` / `interrupted`: recent history; transport and capacity are released immediately.
- `closed`: report remains readable; transport is gone and capacity is free.

Parent quit, reload, `/new`, `/resume`, and session replacement close every child. Cleanup awaits poller cancellation, RPC termination (including forced-kill fallback), Herdr pane/tab closure, and temporary Context Mode/Todo directory removal.

## Activity UI and `/agents`

The working-indicator extension is the sole owner of the Pi-styled inline activity block. It is task-first, uses native theme tokens, shows running children first, then completed/open children, then recent failed/interrupted/closed history, and is limited to four rows. Terminal history is contextual: after the final running or completed agent closes, the inline block disappears while complete history remains in `/agents`. Wide terminals include role, status, model, effort, duration, and current activity; narrow terminals progressively remove low-priority metadata while preserving the task. Animation stops when no child is running. Ctrl+O only expands tool output and does not hide this live block.

Completion cards use Pi's normal custom-message shell. Compact cards show the task, role/status, model, duration, usage, and a report preview; Ctrl+O expands the full report and diagnostics.

`/agents` is the complete interactive history. `/agents help` documents the controls:

- Up/Down: navigate.
- Enter: guide or resume an open child.
- `s`: stop and redirect a running child.
- `f`: focus its Herdr pane.
- `x`: close the child and release capacity.
- `?`: help.
- Escape: close the overlay.

## Herdr

RPC is the normal backend and requires no Herdr installation. A complete explicit Herdr environment (`HERDR_ENV=1`, `HERDR_PANE_ID`, and `HERDR_SOCKET_PATH`) selects Herdr only after control-plane verification. An incomplete or broken explicit environment blocks spawning instead of silently falling back.

Herdr creates one non-focused tab in the parent workspace and labels it from the parent tab: `<parent tab label> - Subagents` (for example, `Orchestrator - Subagents`). If the parent tab label is unavailable, the neutral fallback is `Subagents`; the cwd, project name, and username are never used in the visible label. The parent-to-child mapping remains available in `/agents` and pane metadata as the parent workspace/tab, Subagents tab, and pane IDs.

It never steals focus automatically. One through four open children use the tab's root pane and an adaptive layout: before every split Subagents queries current geometry, chooses the largest owned pane by area, and splits at `0.5` right when the pane is at least twice as wide as tall, otherwise down. Geometry is queried again after closures.

Herdr's public CLI currently has no tab insertion or reorder operation, so a newly created Subagents tab is appended after existing tabs in the workspace. Exact placement immediately after the orchestrator requires a future Herdr `--after`/tab-move capability; Subagents does not use undocumented reordering shortcuts.

Pane titles are bounded task labels such as `Explorer · Trace auth flow`, not internal IDs or full prompts. Guidance and redirects update the title. Metadata reports display role, investigating/implementing/ready/blocked/closed labels, bounded model data, and monotonic sequence numbers. Canonical IDs remain internal for reliable targeting. Use `f` in `/agents` to focus a pane.

Externally deleted panes are treated as released rather than retried forever. The dedicated tab closes after its final owned pane is released. Older Herdr versions without rich layout/metadata APIs use adjacent splits and emit a visible capability warning.

## Sessions and Stats

New child transcripts are hidden from Pi's built-in `/resume` picker:

```text
~/.pi/agent/subagents/sessions/<parent>/<child>/
```

Stats scans normal Pi sessions, this hidden tree, and the legacy `~/.pi/agent/sessions/subagents/` tree without double-counting. Legacy transcripts are not moved automatically. To migrate them, stop Pi first, back up both trees, and move individual parent directories manually; migration is optional because Stats continues to read both locations.

Pi does not expose an extension hook for adding nested children to the built-in `/resume` picker, so durable cross-parent restoration and nested resume are deferred.

## Optional child resources

Child resources are selected by role and can be overridden with a `resources` object in `defaults`, a built-in mode entry, or an exact custom-agent entry. Resolution order is the built-in mode profile, `defaults.resources`, the mode entry (`agents.explorer` or `agents.worker`), then the exact custom-agent entry. Optional integration policies accept `"auto"`, `"enabled"`, or `"disabled"`: auto activates an installed capability, enabled requests it but only warns when unavailable, and disabled skips probing and loading.

| Resource | Explorer | Worker |
| --- | --- | --- |
| Context Mode | Auto-detect | Auto-detect |
| Context execution | Never | When Context Mode is effective |
| Web Search | Enabled | Disabled by default |
| Todos | Disabled | Enabled |
| RTK | Never | Auto-detect |
| UV Bash policy | Never | Auto-detect |
| Copilot compaction fix | Enabled, provider-gated | Enabled, provider-gated |

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

Explorers remain read-only: Context execution, Todos, RTK, and UV cannot be enabled for them. Explorer Web Search is enabled by default; its retrieval calls consume separately provider-accounted usage. Workers may explicitly enable Web Search. Arbitrary child extension and skill paths are not accepted.

Context Mode uses only the package-owned narrow child bridge, not the full extension. Missing Context Mode never blocks spawning. RTK requires version 0.23.0 or newer and fails open; UV requires both the package extension and a working `uv` executable, otherwise native Pi Bash remains active. When both are effective, RTK rewrites before UV validates and executes. Todo and Context Mode state is temporary and isolated. The Copilot compaction fix remains gated by its provider-aware implementation.

Capability state is visible in spawn/read/list results, expanded completion cards, and `/agents`; for example, `UV: enabled → unavailable; native Bash active`.

Subagents are separate processes, not a security boundary. They inherit the user's process credentials so configured providers can authenticate. Review this extension, child prompts, trusted global definitions, delegated tasks, and Worker changes. Herdr receives only reviewed path overrides; parent credentials are not serialized into `herdr --env` arguments. Full prompts are never used as pane labels, but transcript content remains sensitive local data.
