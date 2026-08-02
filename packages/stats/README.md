# Stats

`/stats` reports generic Pi session usage from local JSONL session files. It supports the current workweek, calendar week (`/stats week`), month, and previous periods (`/stats previous` or `/stats -2`). Reports include model totals, project totals, and a Subagent subset that is already included in the overall total exactly once.

Each report also appends a **current provider quota** section. This is a live, process-local snapshot fetched concurrently for active GitHub Copilot and OpenAI Codex models through Usage Meter. It is explicitly separate from the selected historical period: provider quotas, balances, percentages, and limits are never added to local tokens, costs, response counts, or model/project totals. Unsupported providers are identified, and authentication, timeout, or provider failures show a concise unavailable line without preventing the local report from rendering.

Stats deliberately ignores custom extension entries, including synthetic summaries. It tolerates missing, empty, and malformed session files. Normal session location follows Pi's documented `PI_CODING_AGENT_DIR` and `PI_CODING_AGENT_SESSION_DIR` configuration. Stats also scans hidden Subagent transcripts under `<agent-dir>/subagents/sessions` and unchanged legacy transcripts under `<agent-dir>/sessions/subagents`, deduplicating files discovered through overlapping roots.
