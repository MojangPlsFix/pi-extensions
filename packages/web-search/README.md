# Web Search

Web Search registers one `search` tool for bounded web and programming-documentation retrieval. The active Pi provider selects the backend at run time:

- `github-copilot` uses the SDK-bundled Copilot runtime by default.
- `openai-codex` uses native `POST /codex/alpha/search` with refreshed Pi OAuth.
- Other providers return an actionable availability error.

The tool does not use a silent provider or transport fallback. GitHub does not publish a supported standalone REST API or direct GitHub MCP contract for `web_search`. The extension does not call private Copilot search endpoints.

The extension does not retain `web_search` or `code_search` aliases. Use the optional `kind: "web" | "code"` value to select the retrieval type. The input also accepts `prompt`, `query`, or `queries`, recency and domain filters, source-page inspection, an output budget, and a model override. Multiple query strings remain one search turn.

## GitHub transport and lifecycle

Set `PI_COPILOT_SEARCH_TRANSPORT=sdk|cli` to select the GitHub transport:

- `sdk` is the default. It uses the runtime that ships with `@github/copilot-sdk`.
- `cli` is the explicit legacy fallback. It starts the installed `copilot` command once per search.

Invalid values cause an actionable configuration error. The extension never retries a request on another transport. A failed SDK request is not sent again through the CLI. If the SDK connection breaks, only a later independent search can start a new runtime.

The SDK transport starts one bundled runtime lazily per Pi session. Extension registration does not start it. The extension reuses the runtime across searches, but each tool invocation gets a fresh isolated SDK session. It closes and deletes that search session after completion, failure, timeout, or cancellation. Pi session shutdown aborts active work, stops the runtime, and removes its temporary state.

Concurrent searches can share the runtime. Cancellation calls the affected SDK session only. It does not stop unrelated searches. The legacy CLI transport keeps its shell-free process, cancellation, and shutdown protections.

## Retrieval and feedback

Both general and programming-documentation searches use a retrieval-only policy. The SDK session exposes only canonical `web_search`. It also exposes `web_fetch` when `includeContent` is true. The extension denies shell, file, write, memory, custom-tool, and unrelated MCP requests. It does not return a factual answer unless a search succeeds and supplies at least one safe source URL.

Search output is bounded and marked as untrusted external content. The backend returns at most 12,000 characters or 400 lines. The extension normalizes at most 20 sources and 8,000 characters per source section. Expanded TUI output shows at most 8 URLs and a 600-character preview. Codex results contain only safe source titles, HTTPS URLs, and snippets. The extension removes duplicate URLs. It never returns credentials, signed-URL capabilities, encrypted output, unknown payload fields, raw SDK events, or raw backend responses. It marks truncation.

The TUI identifies `copilot-sdk`, `copilot-cli`, or `codex-native`. It then shows a compact completion summary. Expanded results show a bounded URL list and a short preview. Safe result details include the backend, kind, model, query and source counts, truncation state, and provider-accounted usage status.

## Authentication, model, and accounting

The extension does not contact either backend during Pi startup. The SDK-bundled runtime can authenticate with a stored Copilot login, GitHub CLI credentials, or supported token environment variables. The explicit CLI transport requires an installed and authenticated local `copilot` command.

`gpt-5.6-luna` is the default Copilot Search model unless the request supplies a model override. The SDK transport omits reasoning effort because the SDK does not support the CLI's historical `none` value. The legacy CLI transport uses effort `none`.

The timeout is an inactivity limit of 600,000 milliseconds (10 minutes) by default. Meaningful SDK events or legacy CLI output reset the timer. Set `PI_COPILOT_SEARCH_TIMEOUT_MS` to a positive integer to change the limit. Timeout and cancellation stop the current search and run bounded session cleanup.

For Codex, authenticate with `/login openai-codex`. Pi refreshes OAuth immediately before the native request. It sends the credential only to the trusted HTTPS `chatgpt.com` endpoint. Authentication failures, unsafe endpoint overrides, HTTP failures, malformed responses, empty results, and unsupported providers produce clear errors. The extension does not expose credentials, request headers, OAuth claims, or raw backend payloads.

Both providers can charge retrieval against provider subscription quota. The backends do not report token or monetary usage for this retrieval. Search therefore omits Pi `usage` and cost values and marks consumption as `provider-accounted`. Pi excludes this consumption from local cost totals.
