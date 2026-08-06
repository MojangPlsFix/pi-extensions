# Copilot Compaction Fix

This extension fixes a Pi issue with GitHub Copilot base URLs. Some Pi versions apply the base URL to normal requests but not to compaction or branch-summary requests.

The extension runs only with `github-copilot` models. Other models keep Pi's normal compaction behavior.

Set `PI_DISABLE_COPILOT_COMPACTION_BASE_URL_FIX=1` to disable the fix after you upgrade Pi to a version that includes it.
