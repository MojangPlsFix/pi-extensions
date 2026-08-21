# Session Summary

Session Summary gives unnamed Pi sessions a short title for `/resume`. It runs after a completed TUI assistant turn when the session has at least two messages and no manual session name.

## Provider and authentication

The extension uses the fixed `github-copilot/gpt-5.6-luna` model through Pi's model registry. Authenticate GitHub Copilot in Pi before you use the extension. If the model is unavailable or authentication fails, the extension shows a warning and leaves the session unchanged.

The title request sends a bounded conversation excerpt of up to 80,000 characters. The request has a bounded output limit of 800 tokens and a 20-second timeout. The provider may return reasoning-only or truncated output. In these cases, the extension shows a diagnostic and does not persist a title. It does not select a fallback model.

## Commands

- `/session-summary` generates or refreshes the title for the current session.
- `/session-summary-cost` shows the Luna usage and cost recorded by the extension.
- `/session-summaries` backfills titles for unnamed sessions in the current project.

Set `PI_SESSION_SUMMARY=off` to disable automatic and manual title generation.

## Persistence and accounting

A successful title writes the session name and a `session-summary` custom entry to the session JSONL. Automatic summaries attach their usage to the assistant message and mark the custom entry with `usageAttached: true`. Manual and backfill summaries keep their usage in the custom entry. Stats and Usage Meter recognize this custom entry and avoid double-counting attached usage.

The extension does not provide daily exit summaries. Pi Memory is a separate feature.
