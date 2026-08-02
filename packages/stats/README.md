# Stats

`/stats` reports generic Pi session usage from local JSONL session files. It supports current workweek, calendar week (`/stats week`), month, and previous periods (`/stats previous` or `/stats -2`). Reports include model totals, project totals, and a subagent subset that is already included in the overall total exactly once.

Stats does not fetch provider quota data and deliberately ignores custom extension entries, including synthetic summaries. It tolerates missing, empty, and malformed session files. Normal session location follows Pi's documented `PI_CODING_AGENT_DIR` and `PI_CODING_AGENT_SESSION_DIR` configuration. Stats also scans hidden Subagent transcripts under `<agent-dir>/subagents/sessions` and unchanged legacy transcripts under `<agent-dir>/sessions/subagents`, deduplicating files discovered through overlapping roots.
