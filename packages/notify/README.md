# Notify

Notify sends a desktop or terminal notification after an assistant turn completes without pending tool results or queued messages.

It uses Windows toast notifications on Windows and WSL. It uses terminal notification protocols on other supported systems.

Use `/notify-test`, `/notify-toggle`, and `/notify-status` to control and inspect the feature.

Set `PI_WINDOWS_TOAST_APP_ID` only when Windows toast registration needs a different application identity.
