---
name: subagent-orchestration
description: Coordinate Hackler v2 profiles with explicit ownership, batch dispatch, supervisor requests, parked reports, and reviewed integration.
---

# Hackler Orchestration

Use Hackler for substantial independent work or specialist work. Keep decisions, review, and final verification in the parent.

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

## Make a task graph and dispatch adaptively

1. Identify the substantial independent work on the current ready frontier. Do not delegate trivial or tightly sequential steps.
2. Call `subagent_status` to query current ownership and free capacity.
3. Mark dependencies and assign one owner to each path, symbol, or topic.
4. Give each task a concrete deliverable, observable acceptance criteria, and explicit completion-or-blocker stop conditions.
5. If the frontier is larger than free capacity, rank it by dependency impact and uncertainty.
6. Dispatch the smallest justified batch, up to free capacity, in one `subagent_dispatch` call.
7. Recompute the ready frontier and capacity after each wave rather than assuming the original graph is still ready.

Never invent, split, or duplicate work merely to fill slots. Leaving capacity unused is correct when fewer substantial independent tasks are ready. Do not send the same task to two profiles or assign overlapping writer scopes.

Use one shared-checkout Worker by default. Use `workspace: "worktree"` only for a clean Git checkout and disjoint writer scopes.

## Continue parent work

After dispatch, continue only with work that no child owns.

Do not wait immediately if useful parent work remains. Use `subagent_collect` when the next step needs a child result.

The manager parks a completed child automatically. A parked child does not use active capacity.

Use `subagent_steer` for one narrow correction or follow-up. Do not replace the original ownership through steering. If a task needs repeated corrective steering, stop it, narrow the contract, and re-dispatch only the remaining justified work.

Use `subagent_stop` when a task is obsolete, unsafe, outside its ownership, or no longer has a coherent bounded contract.

## Handle supervisor requests

Children do not ask the user directly. Native children use `contact_supervisor` for these request types:

- decision
- approval
- blocker
- progress
- integration-ready

The parent agent handles pending requests with `subagent_status` and `subagent_respond`. `subagent_collect` returns when a child blocks instead of waiting indefinitely and accepts a bounded `timeoutSeconds` from 10 through 3600. Resolve pending blockers before another wait. A run can have multiple linked requests, so answer the oldest actionable request and re-check status until no blocker remains. Review the detail and tool input before you approve an action. Open `/agents` only as a manual fallback.

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

Plan Mode permits Hackler control tools. The manager rejects write dispatch and write-session revival during Plan Mode.

Use Scout, Researcher, Reviewer, Oracle, or the hidden Plan Reviewer for plan work.

## Lifecycle and UI

Use `/agents` as the lifecycle authority. The Hub shows lineage, claims, blocked requests, reports, profiles, and diagnostics.

Herdr transcript panes are display-only. They do not run or prompt children.

Parent shutdown stops active turns and parks their records. Do not expect offline child work after Pi exits.
