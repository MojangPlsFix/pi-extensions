# Plan Mode

Plan Mode provides `/plan`, `/plan <request>`, `/plan off`, and `/plan-implement [fresh]` for an explicit planning-to-implementation workflow. It persists branch-local state, restores it after session navigation, marks the editor border, disables known direct mutation tools, and blocks unreviewed third-party tools while active.

A decision-complete response must contain exactly one non-empty `<proposed_plan>` block. Pi offers current-session or fresh-context implementation after the proposal is settled. Subagent coordination is optional; Plan Mode works when Subagents is absent.

## Guardrail limitation

This feature is a guardrail, not an operating-system security sandbox. Its Bash policy supports reviewed RTK wrappers for token-optimized inspection while retaining the existing native read-only command allowlist as a fallback when RTK does not support a command. Shell composition, arbitrary RTK runners, and mutating native or RTK subcommands remain blocked. Read-oriented Context Mode tools remain available for repository inspection. Those tools and any newly reviewed third-party tool still depend on Pi's extension and model instruction contract. Review and extend `policy.ts` before allowing new tools.

The implementation is provider-independent and works with Codex, GitHub Copilot, and compatible providers. When `ask_user_question` is unavailable, its prompt falls back to ordinary concise questions.
