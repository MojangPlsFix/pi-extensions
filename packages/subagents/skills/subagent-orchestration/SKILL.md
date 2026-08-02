---
name: subagent-orchestration
description: Coordinate isolated Explorer and Worker Subagents for parallel investigation, implementation, follow-up, reports, and cleanup.
---

# Subagent Orchestration

Use Subagents to delegate independent work while keeping the parent responsible for decisions and integration.

## Choose the role deliberately

- **Explorer** is the default for read-only code investigation, documentation lookup, architecture analysis, and web research.
- **Worker** is only for delegated work that must modify files. Workers are unavailable while Plan Mode is active.
- Roles may resolve to separate configured models and thinking levels. Treat the requested/effective model shown by the tools as diagnostic information, not as a reason to change role semantics.
- Only use custom role names returned by `subagent_list`; never invent one.

## Coordinate without serializing everything

- Up to four Subagents may remain open, with at most one open Worker.
- A completed Subagent remains open for follow-ups and still consumes capacity.
- After spawning, continue independent parent work when useful instead of immediately waiting.
- Use `subagent_read` for a settled report, `subagent_send` for a follow-up, and `subagent_wait` only when progress truly depends on completion.
- Read reports and call `subagent_close` when follow-ups are unnecessary.

## Visibility and lifecycle

- The inline task-first activity block shows at most four relevant agents.
- `/agents` shows complete task history, status, reports, usage, Herdr focus, and close controls. Use `/agents help` for controls.
- Running and completed agents are open. Failed and interrupted agents release capacity immediately. Closed agents retain readable reports but have no transport.
- Herdr panes never steal focus automatically; use `/agents` focus when needed.

## Child boundaries

Children are isolated Pi sessions. They cannot spawn recursive Subagents or ask the user directly. They must return questions and blockers to the parent. Explorer resources are read-only; Worker resources permit the reviewed modification tools. The parent remains responsible for reviewing output, resolving conflicts, and validating the integrated result.
