# Copilot compaction fix

Provider-scoped workaround for Pi versions where GitHub Copilot credential base URLs are applied to normal requests but not compaction or branch-summary requests. It runs only for `github-copilot` models and otherwise leaves Pi's normal compaction behavior untouched.

Set `PI_DISABLE_COPILOT_COMPACTION_BASE_URL_FIX=1` to disable the workaround after upgrading to a Pi version where it is no longer needed.
