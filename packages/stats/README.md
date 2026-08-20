# Stats

`/stats` restores the Bitbucket-style local Pi usage report while retaining this checkout's
session-root discovery and de-duplication. Reports cover every workspace found in persisted JSONL
sessions and include:

- `SUMMARY` totals for cost, responses, sessions, total tokens, and input/output/cache breakdown;
- `SUBAGENTS (included above)` as a subset of the overall totals;
- complete `DAILY` rows for the selected Monday-Friday workweek or Monday-Sunday calendar week;
- monthly `WEEKLY` rows, with calendar-week buckets clipped to the selected month;
- model and project rows sorted by cost, then tokens, with responses, sessions, money formatting,
  and shortened home-relative project paths.

## Commands and aliases

```text
/stats                 Current Monday-Friday workweek
/stats workweek        Same as /stats
/stats week            Alias for workweek
/stats all             Current Monday-Sunday calendar week
/stats month           Current local calendar month
/stats previous        Previous selected week or month
/stats -1              One selected period ago
/stats month -2        Two calendar months ago
```

Negative offsets are historical only; `/stats all -2` addresses the calendar week two weeks ago,
while `/stats month -2` addresses the calendar month two months ago.

In the TUI, `/stats` opens a read-only modal overlay. `↑`/`↓`, PageUp/PageDown, Home, and End
scroll; `←`/`→` browse historical weeks or months; `m` switches to the month view; `w` switches
to the workweek view; and `Esc` or `q` closes the viewer. RPC and other non-interactive modes use
the report as a widget fallback.

## Accounting and optional Copilot history

Stats reads usage recorded by Pi in assistant messages, tool results, compaction entries, branch
summaries, and compatible historical `session-summary` custom entries. A `session-summary` with
`data.usageAttached: true` is skipped because its usage is already attached to a provider message.
Other custom entries are ignored. Malformed, empty, missing, and unreadable files do not prevent a
report from rendering. The normal session root follows `PI_CODING_AGENT_DIR` and
`PI_CODING_AGENT_SESSION_DIR`; hidden Subagent roots and the legacy nested Subagent root are
scanned once, so Subagent usage is included in the overall totals exactly once and shown separately
as a subset. Parent Subagent control-tool results can contain a nested usage attachment for Pi's
live footer; Stats recognizes that marker and skips the attachment because the child session is the
canonical usage source.

When the active model is `github-copilot`, Stats makes one best-effort daily Copilot quota
checkpoint in the shared store at:

```text
<agent-dir>/copilot-credit-snapshots.json
```

`<agent-dir>` follows `PI_CODING_AGENT_DIR` and defaults to `~/.pi/agent`. The daily table shows
the checkpoint's cumulative account-level usage in `Start Credits`. Copilot credits are not Pi
input/output/cache tokens and are never added to Pi costs, responses, sessions, model totals, or
project totals. Snapshot retrieval and storage fail open, and non-Copilot active models do not
invoke Copilot authentication or network calls. Usage Meter uses the same file for its daily
allowance baseline. It requires a current-day checkpoint with the same unit and total, so a month
or plan change is not treated as a valid baseline.

The live `/usage-meter` extension remains separate. Stats does not include live Codex or Copilot
quota in its historical report; it only reads the optional Copilot checkpoint file described above.
