# Notify

Notify sends a desktop or terminal notification after an assistant turn completes without pending tool results or queued messages.

It uses Windows toast notifications on Windows and WSL. On WSL, it starts Windows PowerShell through the `/init` launcher so it also works when Windows executable support is not registered through `binfmt_misc`. It uses terminal notification protocols on other supported systems.

Use `/notify-test`, `/notify-toggle`, and `/notify-status` to control and inspect the feature.

Set `PI_WINDOWS_TOAST_APP_ID` only when Windows toast registration needs a different application identity.

## WSL validation record

Validated on 2026-09-02 in the affected WSL environment:

- Direct `powershell.exe` failed because WSL tried to interpret the Windows executable as a Linux command.
- `/init /mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe -NoProfile -NonInteractive -Command 'Write-Output ok'` returned `ok`.
- The encoded WinRT toast script and the notify extension smoke test both returned exit code `0` through the `/init` invocation.

This is a host-specific smoke record. It does not replace native Windows validation.
