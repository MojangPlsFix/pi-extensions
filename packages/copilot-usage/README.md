# Copilot Usage

Displays GitHub Copilot quota in Pi status UI only while the active model provider is `github-copilot`. It refreshes after model changes and turns, removes its status immediately when switching away, and is a quiet no-op when no Copilot authentication is available.

Quota lookup is on demand only. Authentication values are never displayed or logged. `/copilot-usage` requests a refresh when a Copilot model is active.
