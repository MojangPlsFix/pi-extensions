# Development

## Prerequisites

- Node.js 22 or newer
- Pi 0.84 or newer for runtime checks

Install development tools with `npm install`. Pi supplies peer dependencies at run time. This package has no runtime dependencies and no install lifecycle scripts.

## Commands

```bash
npm run typecheck
npm run lint
npm test
npm run validate:package
npm run lint:docs
npm run check
```

`validate:package` checks the explicit Pi manifest, entrypoint shape, and install-safety rules.

`lint:docs` runs `uv run --no-project python scripts/ste-lint.py` and reports heuristic STE violations in the README and documentation files. It does not block Pi runtime use.

## Local runtime check

Use an isolated Pi configuration directory. This prevents local tests from changing normal settings:

```bash
PI_CONFIG_DIR="$(mktemp -d)" pi install "$(pwd)"
PI_CONFIG_DIR="$PI_CONFIG_DIR" pi
```

Test the workflow state machines with these cases:

1. Run `/plan-review` more than once on the same branch.
2. Return a complete revised plan after a review.
3. Return an invalid revision, then a valid correction.
4. Return two invalid revisions and confirm that Pi shows one warning.
5. Test current-session and fresh-session plan implementation.
6. Switch branches while a Plan review or Hackler batch is open.
7. Return to the origin branch and confirm one deferred continuation.
8. Run parallel Reviewer batches and confirm one aggregate per dispatch call.
9. Run nested orchestration and confirm that child results go to the owning orchestrator.
10. Stop a nested owner early and inspect the folded orphan evidence.
11. Trigger the Codex threshold compaction and confirm one continuation after completion.
12. Make a repository change and return the five-section implementation summary.
13. Return an invalid summary and confirm one correction plus one final warning.

Test Session Summary with these active-provider cases:

1. Use Copilot Luna without a profile file.
2. Use Codex Spark while Spark is available.
3. Make Spark unavailable and confirm the Codex Luna fallback.
4. Use an unprofiled provider and confirm that its active model handles the request.
5. Switch providers and confirm that Session Summary never sends data across providers.
6. Confirm that the first meaningful completed turn starts one automatic attempt.
7. Confirm that later turns, restarts, and `/tree` navigation do not start another automatic attempt.
8. Confirm that a greeting, a tool call, and an incomplete response do not consume the attempt.
9. Confirm that Pi's working row stays visible and that Session Summary adds no status row.
10. Confirm that an automatic failure shows one warning and does not retry.
11. Confirm that successful manual and backfill commands are silent.
12. Confirm that manual failures show a warning and mixed backfill failures show one aggregate warning.
13. Run `/session-summary`, `/session-summaries`, and `/session-summary-cost` without optional tools.

## Workflow state files

Workflow Finalization stores branch-local custom entries in the session tree. Plan Mode reads version-1 state and writes version 2 after the next state change. Hackler reads manager schema version 2 without replaying old completion messages. It writes new dispatch batches with schema version 3.

A continuation producer owns its stable request ID and persisted producer state. The coordinator owns message dispatch and the post-settlement receipt. Do not call `pi.sendMessage()` as a fallback for an automatic continuation.

The coordinator cannot reserve a turn atomically against user input or process termination. This limit requires a Pi reservation API. Tests must verify deterministic recovery instead of claiming process-level exactly-once delivery.
