# Subagents

Persistent Subagents launches isolated child Pi sessions with the parent model and thinking level by default. Trusted user-global definitions in `~/.pi/agent/subagents/agents` (or the configured Pi agent directory) can explicitly override a child model or thinking level.

Tools: `subagent_spawn`, `subagent_send`, `subagent_wait`, `subagent_list`, `subagent_read`, and `subagent_interrupt`. `/agents` opens the live activity viewer. Explorer children receive a reviewed read-only resource set; workers are limited by the concurrency policy and cannot start while Plan Mode is active.

## Backends and optional capabilities

RPC is the normal backend and requires no Herdr installation. If Herdr is explicitly configured with a complete environment, Subagents verifies its control plane before opening extension-owned panes. An incomplete or broken explicit Herdr configuration produces an actionable error; detection never starts Herdr processes. Only extension-owned panes are closed during cleanup.

Context Mode is optional. When safely discovered, children receive its narrow read-oriented bridge. Without it, parent and child startup continue normally and no Context Mode tools are claimed.

Subagents start separate Pi processes. They are not a security boundary: review child prompts, global agent definitions, and the resources supplied in `process.ts`.
