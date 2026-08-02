# Provider-Aware Search

Registers one `search` tool for bounded web and programming-documentation retrieval. The active Pi model provider selects the backend at execution time:

- `github-copilot` uses an installed, authenticated local `copilot` CLI.
- `openai-codex` uses Codex native `POST /codex/alpha/search` with Pi's refreshed OAuth credential.
- Other providers return an actionable availability error; there is no silent fallback.

`web_search` and `code_search` are intentionally not retained as aliases. Use optional `kind: "web" | "code"` to select the retrieval style. The unified input also accepts `prompt`, `query`, or `queries`, plus recency/domain filters, source-page inspection, an output budget, and a model override. `reasoningEffort` applies only to the Copilot CLI backend.

## Retrieval and feedback

Search output is bounded and explicitly labeled as untrusted external content. Backend text is limited to 12,000 characters or 400 lines. At most 20 normalized sources and an 8,000-character source section are returned; expanded TUI output shows at most 8 URLs and a 600-character preview. Codex structured results are reduced to safe source titles, HTTP(S) URLs, and snippets; duplicate URLs are removed. Credentials, signed-URL capabilities, encrypted output, unknown payload fields, and raw backend responses are never returned. Output and source truncation are marked explicitly so the parent model knows when evidence is incomplete.

The TUI immediately identifies the selected backend, then shows a compact completion summary. Expanded results show a bounded URL list and short preview. Safe result details include backend, kind, model, query/result/source counts, truncation state, and provider-accounted usage status.

## Authentication and accounting

The extension does not contact either backend during Pi startup.

For Copilot, install the CLI and run `copilot login`. Its inexpensive retrieval defaults remain `--model gpt-5.6-luna --effort none`; arguments are validated, passed without a shell, and cancellation reaches the child process.

For Codex, authenticate with `/login openai-codex`. Pi resolves and refreshes OAuth immediately before the native request, and sends that credential only to the trusted HTTPS `chatgpt.com` endpoint. Authentication failures, unsafe endpoint overrides, HTTP failures, malformed responses, empty results, and unsupported providers produce explicit errors without exposing credentials, request headers, OAuth claims, or backend payloads.

Both backends may consume provider subscription quota, but neither reports token or monetary usage for this retrieval operation. Search results therefore omit Pi `usage` and cost values and mark consumption as `provider-accounted`; it is not included in Pi's local cost totals.
