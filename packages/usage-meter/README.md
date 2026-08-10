# Usage Meter

Usage Meter shows provider quota in Pi. It supports the active `github-copilot` and `openai-codex` providers. Neither provider is required at Pi startup.

## What it does

- Shows GitHub Copilot premium-request or AI-credit quota while Copilot is active.
- Shows Codex primary and secondary rate-limit windows while Codex is active.
- Shows Codex plan, reset times, credits, spend-control limits, additional limits, and reached-limit metadata through `/usage-meter`.
- Refreshes after model selection and clears provider data when the model changes or the session ends.
- Polls Copilot every 30 seconds and Codex every 60 seconds.
- Refreshes Copilot after completed turns and tool results with throttling. Codex uses provider response headers for immediate updates and does not poll after tools.
- Treats credentials and unknown provider fields as private. It does not retain raw authentication or response payloads.

## Footer and command examples

Pi shows active provider usage on its own right-aligned footer row. Normal directory, token, context, model, and extension-status rows remain visible:

```text
~/projects/my-app (develop)
↑12.4k ↓3.1k R84.2k $0.842 (sub) 18.6%/128k                 github-copilot/gpt-5.4
                                  daily: 3,409 (50%) left - month: 142,500/150,000 (95% left)
```

For Codex, the row shows the active rate-limit windows:

```text
~/projects/my-app (develop)
↑12.4k ↓3.1k R84.2k $0.842 18.6%/128k                         openai-codex/gpt-5
                                            5h 58% left · weekly 81% left
```

Normal usage uses muted colors. Low Copilot quota and reached Codex limits use error styling. Approaching Codex limits use warning styling.

Finite Copilot AI-credit quotas include a daily remaining allowance before the monthly quota. The format is `daily: <credits> (<percent>%) left - month: <remaining>/<total> (<percent>% left)`. The daily target is the current monthly total divided by the local month’s Monday-Friday workdays. The daily amount uses the current-day checkpoint and can become negative when today’s target is exceeded. Weekends and missing or incompatible checkpoints show `daily: —`. Unlimited quotas and premium-request quotas do not include the daily label. Checkpoints are stored in the shared `<agent-dir>/copilot-credit-snapshots.json` file used by Stats.

`/usage-meter` refreshes the active supported provider. It reports a concise unavailable message when authentication or provider data is missing. It shows plan, reset, credit, spend, and additional-limit details when data is available:

```text
Codex · Pro
5h: 58% left · resets 2026-08-02T20:00:00.000Z
Weekly: 81% left · resets 2026-08-09T15:00:00.000Z
Credits: balance 25.00
```

Background refresh failures stay silent and clear the status line.

## Authentication and endpoints

Pi reads authentication only when a supported provider is active. Copilot uses Pi's `auth.json` credentials and an optional `gh auth token`. Codex uses refreshed OAuth credentials from Pi's model registry. It extracts the ChatGPT account ID from the access token and requests:

`https://chatgpt.com/backend-api/wham/usage`

The extension accepts only trusted HTTPS `chatgpt.com` `/backend-api` or `/backend-api/codex` provider base forms. It rejects plaintext, custom hosts, credentials in URLs, query strings, fragments, and unrelated ChatGPT paths.

## Integration API

The public entry point exports:

- `fetchProviderUsage(model, modelRegistry, options?)`: returns `undefined` for unsupported providers and `{ provider }` for a supported provider without data. Available results include a sanitized `snapshot`.
- `formatUsage`: formats compact output.
- `formatUsageDetailed`: formats command and report output.
- `parseCodexUsage`, `parseCodexUsageHeaders`, `mergeCodexUsage`, and `codexUsageUrl`: handle tested Codex metadata.
- `usageProviderForModel` and provider predicates: route provider requests.

`/stats` uses `fetchProviderUsage` and `formatUsageDetailed` to append live provider quota after local historical totals. It never adds the snapshot to period token, cost, response, model, or project accounting. Other extensions should use the same router and formatter. They should not read provider credentials or retain raw responses.

## Limitations and security

Pi extensions run arbitrary local code. Review this package before you install it. Usage Meter is a display aid, not an accounting authority. Provider responses can be missing, delayed, partial, or changed upstream.

Direct Codex usage requests take priority over transient response-header updates. The package does not provide billing, session-summary, or general session accounting.
