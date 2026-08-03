# Usage Meter

Usage Meter is the provider-aware status meter for Pi. It supports the active
`github-copilot` and `openai-codex` providers without making either provider a
startup requirement.

## What it does

- Shows GitHub Copilot premium-request or AI-credit quota while Copilot is active.
- Shows Codex primary and secondary rate-limit windows while Codex is active.
- Shows Codex plan, reset timestamps, credits, spend-control limits, additional
  limits, and reached-limit metadata through the detailed `/usage-meter` result.
- Refreshes immediately after model selection and clears provider UI when the
  model changes or the session shuts down.
- Polls Copilot every 30 seconds and Codex every 60 seconds.
- Refreshes Copilot after completed turns and tool results, with throttling.
  Codex relies on its provider-response headers for immediate updates and does
  not perform post-tool polling.
- Treats credentials and unrecognized provider payload fields as private. No
  raw authentication or response payload is retained in the status/UI result.

## Footer and command examples

The active provider usage appears on its own right-aligned footer row while Pi's
normal directory, token, context, model, and extension-status rows remain
visible:

```text
~/projects/my-app (develop)
↑12.4k ↓3.1k R84.2k $0.842 (sub) 18.6%/128k                 github-copilot/gpt-5.4
                                                         81,055/150,000 (54% left)
```

For Codex, the same layout uses the active rate-limit windows:

```text
~/projects/my-app (develop)
↑12.4k ↓3.1k R84.2k $0.842 18.6%/128k                         openai-codex/gpt-5
                                            5h 58% left · weekly 81% left
```

Normal usage is muted, low Copilot quota and reached Codex limits are shown in
error styling, and approaching Codex limits use warning styling.

`/usage-meter` forces a refresh for the active supported provider. It reports a
concise unavailable message when authentication or provider data is absent and
shows detailed plan, reset, credit, spend, and additional-limit information
when data is available, for example:

```text
Codex · Pro
5h: 58% left · resets 2026-08-02T20:00:00.000Z
Weekly: 81% left · resets 2026-08-09T15:00:00.000Z
Credits: balance 25.00
```

Background refresh failures are silent and clear the status line.

## Authentication and endpoints

Authentication is read only when a supported provider is active. Copilot uses
Pi's `auth.json` credentials and an optional `gh auth token`. Codex uses
refreshed OAuth credentials from Pi's model registry, extracts the ChatGPT
account id from the access token, and requests:

`https://chatgpt.com/backend-api/wham/usage`

Only the trusted HTTPS `chatgpt.com` `/backend-api` or `/backend-api/codex`
provider base forms are accepted. Plaintext, custom hosts, credentials in the
URL, query strings, fragments, and unrelated ChatGPT paths are rejected.

## Integration API

The public entry point exports:

- `fetchProviderUsage(model, modelRegistry, options?)`, which returns
  `undefined` for unsupported providers and `{ provider }` for a supported but
  unavailable provider; available results include a sanitized `snapshot`.
- `formatUsage` for compact output and `formatUsageDetailed` for command/report
  output.
- `parseCodexUsage`, `parseCodexUsageHeaders`, `mergeCodexUsage`, and
  `codexUsageUrl` for tested Codex metadata handling.
- `usageProviderForModel` and provider predicates for routing.

`/stats` uses `fetchProviderUsage` and `formatUsageDetailed` to append a separate
live provider-quota section after local historical totals. The snapshot is never
added to period token, cost, response, model, or project accounting. Other
extensions should use the same router and formatter rather than reading provider
credentials or retaining raw responses themselves.

## Limitations and security

Pi extensions execute arbitrary local code. Review this package before
installing it. Usage Meter is a display aid, not an accounting authority:
provider responses can be unavailable, delayed, partial, or changed upstream.
Direct Codex usage fetches remain authoritative over transient response-header
updates. The package does not provide billing, session-summary, or generic
session accounting.
