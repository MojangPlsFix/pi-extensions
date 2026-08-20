# Subagents v2

Subagents v2 runs child Pi sessions through the Pi SDK. It does not type prompts into a shell or a terminal.

The parent Pi session owns every child, decision, review, and integration. A child stops when its parent session stops.

## What changed

Version 2 is a clean break. It does not register the version 1 tools or read the version 1 configuration schema.

Read [MIGRATION.md](MIGRATION.md) before you replace an existing setup.

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

| Profile | Class | Use |
| --- | --- | --- |
| `scout` | `read` | Map code, architecture, constraints, and risks. |
| `researcher` | `advisory` | Research current web sources and primary documentation. |
| `worker` | `write` | Change one owned code slice and run local checks. |
| `reviewer` | `review` | Review one angle without file changes. |
| `oracle` | `advisory` | Check decisions, assumptions, and consistency. |
| `orchestrator` | `orchestrator` | Coordinate one explicit mission and its child task graph. |

The hidden `plan-reviewer` profile supports Plan Mode reviews.

A profile class sets an authority ceiling. A read, review, advisory, or orchestrator profile cannot select mutation tools.

## Parent tools

| Tool | Purpose |
| --- | --- |
| `subagent_dispatch` | Start one batch of independent tasks with explicit ownership. |
| `subagent_status` | Show profiles, task claims, capacity, requests, and diagnostics. |
| `subagent_respond` | Resolve a pending supervisor request so a blocked child can continue. |
| `subagent_collect` | Read reports or wait for selected runs; returns early when a child needs supervisor input. |
| `subagent_steer` | Guide an active run or revive a parked native or RPC run. |
| `subagent_stop` | Stop runs and their descendants. |

Child model usage is retained per run. `subagent_collect`, `subagent_stop`, and steering a persisted run attach newly observed child usage to the parent tool result, so Pi's normal session cost display includes it once and keeps it after reload. `/stats` scans the child sessions separately and avoids counting those parent attachments twice.

The parent agent handles pending supervisor requests with `subagent_status` followed by `subagent_respond`. `subagent_collect` returns as soon as a selected child becomes blocked, so the parent can resolve the request instead of waiting in a deadlock. `/agents` remains available as a manual UI fallback.

Batch all ready independent tasks in one `subagent_dispatch` call. Give each task a unique key, owned scope, and deliverable.

The manager rejects these cases before it starts a child:

- duplicate normalized task text
- overlapping writer paths or symbols
- more than one shared-checkout writer by default
- an unknown or disabled profile
- a nested profile that the parent profile does not allow
- a write profile while Plan Mode is active
- a capability above the profile class ceiling

## Native transport and lifecycle

The default `native` runner creates an in-process `AgentSession`. It calls `prompt()`, `steer()`, `followUp()`, `abort()`, and `dispose()` directly.

The task does not enter shell history. The runner does not need a simulated Enter key.

Each child gets a separate session manager, settings manager, resource loader, transcript directory, and extension runtime. Children do not share a session file. Native children use the parent model runtime for the authenticated provider catalog. Trusted capability extensions must not mutate shared provider registration.

A normal run follows these states:

1. `starting`
2. `running`
3. `blocked`, if it waits for the supervisor
4. `parked`, after it settles

A parked run has no live model session. Its report and transcript remain available for follow-up.

Other terminal states are `failed` and `stopped`. Parent shutdown aborts active turns and parks their records. An active isolated run keeps its worktree so that the run can be revived or recovered. Retention cleanup removes an expired worktree.

The default limits are four active runs, one shared-checkout writer, and nesting depth two. The manager keeps history for 30 days and at most 200 records.

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
| `s` | Steer the selected run. |
| `x` | Stop the selected active run and its descendants. |
| `t` | Open a display-only Herdr transcript. |
| `e` | Eject a selected built-in profile. |
| `r` | Reload profiles and configuration. |
| `?` | Show Hub help. |
| Escape | Close the Hub. |

These commands also manage profile metadata:

```text
/agents enable <profile>
/agents disable <profile>
/agents eject <built-in> [user|project]
/agents doctor
/agents doctor --json
```

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
  "herdr": {
    "enabled": false,
    "direction": "right",
    "maxOutputBytes": 1000000
  },
  "profiles": {}
}
```

A run captures its effective profile, model, thinking level, and capabilities when it starts. A later file change does not change that run.

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

A sidecar does not continue after its parent closes. An unfinished mission worktree remains available for manual recovery until retention cleanup removes its orchestrator record.

The manager captures an integration candidate after a worktree run settles. It does not apply the candidate automatically.

Use the Inbox to apply or keep the candidate. The manager runs `git apply --check` before it changes the source checkout.

## Herdr

Herdr is optional and disabled by default.

When enabled, `t` opens a raw pane that follows the child JSONL transcript. The pane is display-only.

Subagents v2 does not call `herdr agent start`, `herdr agent prompt`, or terminal key injection. Closing the parent session closes all inspector panes that it owns.

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
