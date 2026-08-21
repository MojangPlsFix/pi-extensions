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

Test `/reload`, `/plan`, `/plan off`, plan implementation, and `/agents`. Test Session Summary with these active-provider cases:

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
