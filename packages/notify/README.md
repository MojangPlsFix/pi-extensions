# Notify

Sends a desktop or terminal notification when a completed assistant turn has no pending tool results or queued messages. It uses Windows toast notifications on Windows/WSL and terminal notification protocols elsewhere. `/notify-test`, `/notify-toggle`, and `/notify-status` control and inspect the feature.

Set `PI_WINDOWS_TOAST_APP_ID` only when Windows toast registration requires a different application identity.
