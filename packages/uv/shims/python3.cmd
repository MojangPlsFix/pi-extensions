@echo off
for %%A in (%*) do (
  if /I "%%~A"=="pip" goto blockedPip
  if /I "%%~A"=="venv" goto blockedVenv
)
uv run python %*
exit /b %ERRORLEVEL%
:blockedPip
>&2 echo Error: pip is disabled. Use uv instead.
exit /b 1
:blockedVenv
>&2 echo Error: python -m venv is disabled. Use uv venv.
exit /b 1
