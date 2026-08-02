# Stats

`/stats` reports generic Pi session usage from local JSONL session files. It supports current workweek, calendar week (`/stats week`), month, and previous periods (`/stats previous` or `/stats -2`). Reports include model totals, project totals, and a subagent subset that is already included in the overall total exactly once.

Stats does not fetch provider quota data and deliberately ignores custom extension entries, including synthetic summaries. It tolerates missing, empty, and malformed session files. Session location follows Pi's documented `PI_CODING_AGENT_DIR` and `PI_CODING_AGENT_SESSION_DIR` configuration.
