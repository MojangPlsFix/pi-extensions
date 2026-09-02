# Hackler v2

Hackler v2 runs child Pi sessions through the Pi SDK. It does not type prompts into a shell or a terminal.

Hackler is the product-facing name. Technical `subagent_*` tool names, configuration and session paths, and skill IDs remain unchanged for compatibility.

The parent Pi session owns every child, decision, review, and integration. A child stops when its parent session stops.

## What changed

Version 2 is a clean break. It does not register the version 1 tools or read the version 1 configuration schema.

Read [MIGRATION.md](MIGRATION.md) before you replace an existing setup.

Use [ORCHESTRATION_EVALUATION.md](ORCHESTRATION_EVALUATION.md) to compare parent-only work, specialists, batches, adaptive waves, and fixed fan-out. The guide defines matched budgets and private local gates. It does not report benchmark results.

The main changes are:

- Native children use `AgentSession.prompt()`.
- Completed children park automatically and release live resources.
- The Agent Hub is the main status and control view.
- Herdr shows transcripts only. Herdr does not run child agents.
- Profiles replace the fixed Explorer and Worker roles.
- Task claims reject duplicate work and overlapping writer scopes.
- A capability catalog controls optional work systems and external commands.
- One explicit sidecar orchestrator can own a mission scope.

## Built-in profiles

| Profile | Class | Use | Pilot timeout | Pilot turns |
| --- | --- | --- | ---: | ---: |
| `scout` | `read` | Map code, architecture, constraints, and risks. | 600 seconds | 60 |
| `researcher` | `advisory` | Research current web sources and primary documentation. | 1,800 seconds | 64 |
| `worker` | `write` | Change one owned code slice and run local checks. | 1,800 seconds | 110 |
| `reviewer` | `review` | Review one angle without file changes. | 2,100 seconds | 40 |
| `oracle` | `advisory` | Check decisions, assumptions, and consistency. | 2,100 seconds | 72 |
| `orchestrator` | `orchestrator` | Coordinate one explicit mission and its child task graph. | 2,700 seconds | 128 |

The hidden `plan-reviewer` profile supports Plan Mode reviews. Its pilot timeout is 2,100 seconds, and its pilot turn budget is 40.

A profile class sets an authority ceiling. A read, review, advisory, or orchestrator profile cannot select mutation tools.

## Parent tools

| Tool | Purpose |
| --- | --- |
| `subagent_dispatch` | Start one batch of independent tasks with explicit ownership. |
| `subagent_status` | Show profiles, task claims, capacity, requests, and diagnostics. |
| `subagent_respond` | Resolve a pending supervisor request so a blocked child can continue. |
| `subagent_collect` | Read reports or wait for selected runs; returns early when a child needs supervisor input. |
| `subagent_validate` | Explicitly run one trusted configured validator against the exact pending run or mission patch. |
| `subagent_steer` | Guide an active run or revive a parked native or RPC run. |
| `subagent_stop` | Stop runs and their descendants. |

Child model usage is retained per run. `subagent_collect`, `subagent_stop`, and steering a persisted run attach newly observed child usage to the parent tool result, so Pi's normal session cost display includes it once and keeps it after reload. `/stats` scans the child sessions separately and avoids counting those parent attachments twice.

The parent agent handles pending supervisor requests with `subagent_status` followed by `subagent_respond`. `subagent_collect` returns as soon as a selected child becomes blocked, so the parent can resolve the request instead of waiting in a deadlock. `/agents` remains available as a manual UI fallback.

Batch the smallest justified set of ready independent tasks in one `subagent_dispatch` call. Give each task a unique key and profile. Also give it a self-contained task, owned scope, deliverable, acceptance criteria, and stop conditions.

The manager rejects these cases before it starts a child:

- duplicate normalized task text
- overlapping writer paths or symbols
- more than one shared-checkout writer by default
- an unknown or disabled profile
- a nested profile that the parent profile does not allow
- a write profile while Plan Mode is active
- a capability above the profile class ceiling

## Persisted dispatch batches

Each `subagent_dispatch` call creates one schema-version-3 batch before any child starts. The batch keeps the ordered run IDs and lease generations, origin session and branch entry, route, terminal evidence, and delivery state. A top-level tool call derives its stable batch ID from the parent session and tool-call ID. Each revival creates a separate singleton batch.

A live top-level batch sends one aggregate continuation after all members are terminal and transport cleanup is complete. The message stays on its origin branch. If another branch is active, delivery waits until that branch is active again. Hidden Plan Mode review batches are silent. Nested batches go only to their owning orchestrator; they never send a top-level Pi message. A batch restored after startup or reload does not send a new chat message or start a parent turn; its result stays available in Agent Hub and through `subagent_collect` until explicitly collected. Restored manual-recovery batches do not emit an active workflow gate, so they do not block unrelated parent continuations.

`subagent_collect` returns complete expandable evidence. An orchestrator that collects every member claims the aggregate before it waits and acknowledges it afterward. Partial collection does not suppress evidence for the other members. If the owner ends first, the manager marks the batch orphaned and folds errors, cleanup failures, and partial reports into the owner result.

The collapsed aggregate renderer shows each report or failure summary. Expanded output shows ordered reports and terminal evidence. The legacy `subagent-completion-v2` renderer remains available for old session messages.

Manager persistence now uses schema version 4 and reads versions 2, 3, and 4. Schema-version-2 state restores its runs but does not create or replay ambiguous historical completion batches. Batch claims, ready state, manual-recovery state, and continuation IDs survive reload. Restored top-level Hackler batches remain ready for explicit collection instead of being replayed automatically. Schema 4 also stores the latest validation for each candidate and validator. The manager marks unfinished validation interrupted on restore and never executes or retries its command. It writes the intended disposable path before worktree creation and the running state before command spawn.

An open worktree integration request gates implementation finalization. Accepting the integration advances the implementation wave after the candidate changes the source checkout. Keeping the worktree closes the gate without reporting a source change. Validation does not answer this request. An ordinary failed check remains manually integrable. Active validation or unproven validator-workspace cleanup blocks integration.

## Native transport and lifecycle

The default `native` runner creates an in-process `AgentSession`. It calls `prompt()`, `steer()`, `followUp()`, `abort()`, and `dispose()` directly.

The task does not enter shell history. The runner does not need a simulated Enter key.

Each child gets a separate session manager, settings manager, resource loader, transcript directory, and extension runtime. Children do not share a session file. Native children use the parent model runtime for the authenticated provider catalog. Trusted capability extensions must not mutate shared provider registration.

Each start opens a wall lease. The lease covers startup, execution, and finalization.

At the wall or turn wrap threshold, Hackler queues or sends a private final-report request. This behavior applies to native and RPC runs.

The hard wall or turn limit ends the run. Token and cost limits apply after the runtime receives reported usage.

A normal run follows these states:

1. `starting`
2. `running`
3. `blocked`, if it waits for the supervisor
4. `parked`, after it settles

A parked run has no live model session. Its report and transcript remain available for follow-up.

Other terminal states are `failed` and `stopped`. Parent shutdown aborts active turns and parks their records. An active isolated run keeps its worktree so that the run can be revived or recovered. Retention cleanup removes an expired worktree only after Git proves that removal completed.

The default limits are four active runs, one shared-checkout writer, and nesting depth two. The default wall limit is 2,700 seconds. The default turn limit is 128, and the default wrap threshold is `0.8`.

The effective wall limit is the minimum global, profile, and external-runner limit. The effective turn limit is the minimum global and profile limit. External runners do not have a model-turn limit.

A parked native or RPC run can revive with a persisted session unless a hard limit failed. A revival keeps the captured policy. New global settings can only tighten its original wall, turn, and wrap limits.

The manager keeps history for 30 days and at most 200 records. A record with an unsafe worktree cleanup remains quarantined beyond these limits. The Hub reports the cleanup failure and retained state.

## Agent Hub

Run `/agents` to open the event-driven Agent Hub.

The Hub has three sections:

- **Runs** shows parent and child lineage, ownership, activity, reports, usage, and transcript paths.
- **Inbox** shows decisions, approvals, blockers, progress, and integration requests.
- **Profiles** shows profile source, class, runner, tools, capabilities, and enabled state.

Use these keys:

| Key | Action |
| --- | --- |
| Tab | Change the Hub section. |
| Up or Down | Change the selected item. |
| Home, End, Page Up, or Page Down | Move through long sections. |
| Enter | Answer a request, revive a parked run, or toggle a profile. |
| `v` | Validate a selected pending integration candidate with a configured trusted validator. |
| `s` | Steer the selected run. |
| `x` | Stop the selected active run and its descendants. |
| `t` | Open a display-only Herdr transcript. |
| `e` | Eject a selected built-in profile. |
| `r` | Reload profiles and configuration. |
| `?` | Show Hub help. |
| Escape | Close the Hub. |

These commands manage profile metadata and evaluation traces:

```text
/agents enable <profile>
/agents disable <profile>
/agents eject <built-in> [user|project]
/agents doctor
/agents doctor --json
/agents trace
/agents trace --json
```

`/agents trace --json` returns redacted evaluation trace schema version 1. It excludes task text, reports, request text, ownership, and file paths.

Project ejection requires a trusted project. Ejection never replaces an existing file.

## Profile files

The manager reloads profile files on each status or dispatch call.

Discovery uses this precedence:

1. built-in profiles
2. `~/.pi/agent/subagents/agents/*.md`
3. `<cwd>/.pi/agents/*.md`, only when Pi marks the project as trusted

A higher layer replaces a profile with the same name. The Hub reports every duplicate and malformed file with its path.

Use schema version 2 in each Markdown file:

```md
---
schemaVersion: 2
name: careful-reviewer
description: Review authentication changes for correctness and regression risk.
class: review
runner: native
tools: [read, grep, find, ls]
capabilities: [work-docs-read]
skills: []
defaultContext: decisions
allowedNestedProfiles: []
maxDepth: 0
workspace: read-only
timeout: 300
turnBudget: 8
tokenBudget: 40000
costBudget: 2
infer: true
hidden: false
model: inherit
thinking: high
---
Review only the assigned angle. Cite exact files and tests. Do not edit files.
```

`timeout` uses seconds. `costBudget` uses the model provider's reported currency value.

The `tools` field can select Pi's built-in `read`, `grep`, `find`, `ls`, `bash`, `edit`, and `write` tools. The package-owned `search` tool is also available to the Researcher. Select all other extension tools through named capabilities.

The supported classes are `read`, `write`, `review`, `advisory`, and `orchestrator`. The supported runners are `native`, `rpc`, and `external`.

## Configuration

The global file is `~/.pi/agent/subagents/config.json`.

If the file exists, it must use `schemaVersion: 2`.

```json
{
  "schemaVersion": 2,
  "runtime": {
    "maxActive": 4,
    "maxSharedWriters": 1,
    "maxDepth": 2,
    "maxWallSeconds": 2700,
    "maxTurns": 128,
    "wrapUpRatio": 0.8
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
        "model": "openai-codex/gpt-5.6-luna",
        "thinking": "high"
      },
      "reviewer": {
        "model": "inherit",
        "thinking": "medium"
      }
    }
  },
  "capabilities": {},
  "runners": {},
  "validators": {
    "package-tests": {
      "command": "npm",
      "args": ["test", "--", "packages/example/test"],
      "timeoutMs": 300000,
      "maxOutputBytes": 1000000
    }
  },
  "herdr": {
    "direction": "right",
    "maxOutputBytes": 1000000
  },
  "profiles": {}
}
```

If `herdr.enabled` is omitted, Hackler enables transcript inspection only when the complete Herdr environment (`HERDR_ENV`, `HERDR_PANE_ID`, and `HERDR_SOCKET_PATH`) is present. Set `herdr.enabled` to `false` to disable it explicitly. The Agent Hub hides the transcript action when Herdr is disabled or unavailable.

A run captures its effective profile, model, thinking level, capabilities, and original limits when it starts. A later profile change does not change that run.

The runtime accepts `maxActive` from 1 through 32 and `maxSharedWriters` from 0 through 8.

`maxDepth` cannot exceed 2. `maxWallSeconds` accepts 1 through 2,700. `maxTurns` accepts 1 through 128.

`wrapUpRatio` must be greater than zero and less than one.

`subagent_collect` uses a 60-second default wait. An explicit wait must be from 10 through 3,600 seconds. Collection returns after settlement, a blocker, a timeout, or cancellation.

Use [MODEL_SELECTION.md](MODEL_SELECTION.md) to compare models and thinking levels. Use [ORCHESTRATION_EVALUATION.md](ORCHESTRATION_EVALUATION.md) to compare orchestration policies.

## Capability catalog

Only the global configuration can define capability implementation paths. A trusted project profile can select a global capability, but it cannot define an executable or extension path.

A capability can define:

- one absolute `extensionPath` or one installed `extensionPackage`
- anchored `toolPatterns`
- token-based `executableArgvPrefixes`
- skill paths
- an environment-variable name allowlist
- state access: `isolated`, `shared-read`, or `shared-write`
- approval: `allow`, `ask`, or `deny`

Example:

```json
{
  "schemaVersion": 2,
  "capabilities": {
    "work-docs-read": {
      "description": "Read Jira and Confluence through the approved extension.",
      "extensionPackage": "@company/pi-work-docs",
      "toolPatterns": ["jira_read", "jira_search", "confluence_read", "confluence_search"],
      "skills": [],
      "envAllowlist": ["JIRA_TOKEN", "CONFLUENCE_TOKEN"],
      "state": "shared-read",
      "approval": "allow"
    },
    "release-cli": {
      "description": "Run the reviewed release inspection command.",
      "executableArgvPrefixes": [["release-cli", "inspect"]],
      "envAllowlist": ["RELEASE_TOKEN"],
      "state": "shared-read",
      "approval": "allow"
    },
    "memory-write": {
      "description": "Update approved shared memory.",
      "extensionPackage": "@company/pi-memory",
      "toolPatterns": ["memory_write", "memory_update"],
      "state": "shared-write",
      "approval": "ask"
    }
  }
}
```

Tool patterns match the complete tool name. For example, `jira_*` matches `jira_read` but not `prefix_jira_read`.

An executable rule compares argument tokens. `['git', 'status']` does not authorize `git-status`.

The policy is static for a run. A child cannot add a capability while it runs.

An in-process extension runs with the user's process credentials. The capability policy is not an operating-system security boundary.

## Work systems migration

Use a separate foreground Pi session on the work laptop for Jira, Confluence, MCP, CLI, and memory migration.

1. Run `/agents doctor --json` in that session.
2. Save the report in a protected local file.
3. List each trusted extension package or absolute path.
4. List the exact tool names that each extension registers.
5. List each approved executable argument prefix.
6. List environment-variable names only. Do not copy secret values.
7. Set the state and approval policy for each capability.
8. Add capability names to the applicable user profiles.
9. Run `/agents doctor --json` again.
10. Start one read-only profile and verify its effective tools.
11. Test each `ask` policy through the Hub inbox.
12. Enable shared-write capabilities only after the read-only checks pass.

Do not put extension paths, executable paths, or tokens in project profile files. Keep the capability catalog in the user configuration.

## RPC and external runners

The `rpc` runner starts Pi directly with `shell: false`. It sends JSONL frames through stdin.

RPC profiles are limited to non-writing classes. They cannot use supervisor approvals or nested orchestration.

An `external` runner is a one-shot process. The manager sends the full task through stdin and closes stdin.

The task is not an argument. It does not enter shell history.

External profiles can select only pre-approved capabilities. At least one selected capability must provide an executable argument prefix that matches the complete configured command prefix.

The external runner definition uses the profile name as its key:

```json
{
  "schemaVersion": 2,
  "runners": {
    "company-reviewer": {
      "command": "company-review",
      "args": ["run", "--format", "text"],
      "envAllowlist": ["COMPANY_REVIEW_TOKEN"],
      "timeoutMs": 300000,
      "maxOutputBytes": 1000000
    }
  }
}
```

An external run cannot be steered or revived. Start a new run for a follow-up.

## Report-only patch validation

The optional global `validators` catalog is trusted user configuration. Project configuration cannot define it. Each entry has a `command` with a non-whitespace character, literal string-token `args`, `timeoutMs` from 1 through 600,000, and `maxOutputBytes` from 1 through 1,048,576. Command and argument tokens are not shell text. Empty arguments and leading or trailing argument whitespace are preserved. Validator entries cannot configure environment variables. Hackler starts the command directly with `shell: false`, closes stdin, and does not interpret shell metacharacters in an argument.

Validation is always an explicit `subagent_validate` call or Agent Hub `v` action. Hackler derives a SHA-256 candidate ID from the base commit and exact captured patch, creates a disposable detached worktree at that commit, applies only that patch, and runs from the equivalent relative working directory. The source checkout and the Worker's original worktree are not used as the command workspace.

Hackler globally serializes validators. It retains bounded combined stdout and stderr in manager state and in the pending request summary. The latest safe result follows the normal run or mission retention period. A cleanup quarantine protects its owning record from retention. Zero exit, nonzero exit, spawn failure, timeout, cancellation, and output overflow are report outcomes. A failed check does not apply changes and does not prevent a later manual Integrate or Keep decision after safe cleanup.

Timeout, cancellation, session switch, and shutdown escalate termination of the owned process tree before cleanup. Hackler removes the disposable worktree only after it can prove termination. This version has no Windows Job Object integration, so it cannot prove descendant termination after a Windows validator process starts. It quarantines the workspace even after the direct process exits normally. Any other uncertain termination or cleanup also retains the path and blocks integration. Restart marks unfinished validation interrupted and does not execute, retry, or apply it.

This feature is not an operating-system sandbox. A trusted validator inherits the Pi process environment and can access resources allowed to that user. On POSIX, Hackler owns the spawned process group; a command that deliberately daemonizes into another session escapes that lifecycle boundary. Configure only reviewed, non-daemonizing local commands. Validation uses no provider or paid service unless the configured command itself does so. Hackler makes no correctness claim from a pass and never automatically runs, retries, ranks, integrates, or resolves an integration request.

## Sidecar orchestrator

Run `/orchestrate` to start one sidecar mission. The command asks for a task and an exclusive scope.

The sidecar coordinates work. It does not get normal write tools.

The default mission uses a detached Git worktree. The parent checkout must be clean.

If the checkout is dirty, the command offers these choices:

1. Clean the checkout and try again.
2. Cancel the mission.
3. Use one shared-checkout writer.

The manager never stashes or copies uncommitted changes.

Mission children share the isolated mission worktree. The shared-writer limit still applies inside that worktree.

A normal top-level Worker task can request `workspace: "worktree"`. This creates a separate worktree for that run. Disjoint top-level worktree writers can run in parallel.

A sidecar does not continue after its parent closes. An unfinished mission worktree remains available for manual recovery until retention cleanup removes its orchestrator record. If Git cannot prove safe removal, Hackler quarantines the record and keeps the worktree.

The manager captures an integration candidate after a worktree run settles. It does not apply the candidate automatically.

Use the Inbox to apply or keep the candidate. The manager runs `git apply --check` before it changes the source checkout.

## Herdr

Herdr is optional and disabled by default.

When enabled, `t` opens a raw pane that follows the child JSONL transcript. The pane is display-only.

Hackler v2 does not call `herdr agent start`, `herdr agent prompt`, or terminal key injection. Closing the parent session closes all inspector panes that it owns.

The Agent Hub remains the lifecycle authority when Herdr is absent or a pane closes.

## Plan Mode

Plan Mode can use `subagent_dispatch`, `subagent_status`, `subagent_respond`, `subagent_collect`, `subagent_steer`, and `subagent_stop`.

The manager rejects write dispatch and write-session revival while Plan Mode is active. Plan Mode uses the hidden `plan-reviewer` profile for plan review.

## Validation

Run these checks from the repository root:

```bash
npm run typecheck
npm test -- packages/subagents/test packages/working-indicator/test
npm run validate:package -- subagents
```
