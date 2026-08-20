---
name: subagent-orchestration
description: Coordinate Subagents v2 profiles with explicit ownership, batch dispatch, supervisor requests, parked reports, and reviewed integration.
---

# Subagent Orchestration

Use Subagents for substantial independent work or specialist work. Keep decisions, review, and final verification in the parent.

## Select a profile

Call `subagent_status` before you use a custom profile name.

Use the built-in profiles as follows:

- Use `scout` for fast read-only repository mapping.
- Use `researcher` for current web sources and primary documentation.
- Use `worker` for one owned implementation slice.
- Use `reviewer` for one evidence-based review angle.
- Use `oracle` for decision consistency and hidden assumptions.
- Use `/orchestrate` for one explicit sidecar mission.

Do not invent a profile name.

## Make a task graph

1. List all ready work.
2. Mark each dependency.
3. Assign one owner to each path, symbol, or topic.
4. Give each task one concrete deliverable.
5. Put all independent ready tasks in one `subagent_dispatch` call.

Do not send the same task to two profiles. Do not assign overlapping writer scopes.

Use one shared-checkout Worker by default. Use `workspace: "worktree"` only for a clean Git checkout and disjoint writer scopes.

## Continue parent work

After dispatch, continue only with work that no child owns.

Do not wait immediately if useful parent work remains. Use `subagent_collect` when the next step needs a child result.

The manager parks a completed child automatically. A parked child does not use active capacity.

Use `subagent_steer` for a narrow correction or follow-up. Do not replace the original ownership through steering.

Use `subagent_stop` when a task is obsolete, unsafe, or outside its ownership.

## Handle supervisor requests

Children do not ask the user directly. Native children use `contact_supervisor` for these request types:

- decision
- approval
- blocker
- progress
- integration-ready

The parent agent handles pending requests with `subagent_status` and `subagent_respond`. `subagent_collect` returns when a child blocks instead of waiting indefinitely. Review the detail and tool input before you approve an action. Open `/agents` only as a manual fallback.

Do not claim that a pending child succeeded. Read its settled report first.

## Review and integrate

For each report:

1. Check that the child stayed inside its ownership.
2. Check its file and symbol evidence.
3. Check its validation output.
4. Inspect each changed file.
5. Resolve conflicts and open questions.
6. Run final checks in the integrated checkout.

A worktree candidate requires an Inbox response. The parent agent can answer the integration request with `subagent_respond`; the manager never applies it automatically.

## Plan Mode

Plan Mode permits Subagent control tools. The manager rejects write dispatch and write-session revival during Plan Mode.

Use Scout, Researcher, Reviewer, Oracle, or the hidden Plan Reviewer for plan work.

## Lifecycle and UI

Use `/agents` as the lifecycle authority. The Hub shows lineage, claims, blocked requests, reports, profiles, and diagnostics.

Herdr transcript panes are display-only. They do not run or prompt children.

Parent shutdown stops active turns and parks their records. Do not expect offline child work after Pi exits.
