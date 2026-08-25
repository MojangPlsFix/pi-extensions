# Codex Compaction

This extension adds OpenAI Codex native remote compaction to Pi 0.84 or newer.

It activates only when both model fields have these exact values:

```text
provider: openai-codex
api: openai-codex-responses
```

GitHub Copilot, OpenAI API, Anthropic, and all other providers keep Pi's standard behavior.

## Installation

This extension is part of `@mojangplsfix/pi-extensions`. Install the repository package:

```bash
pi install git:github.com/MojangPlsFix/pi-extensions
```

Run `/reload` after installation.

## Behavior

The extension uses OpenAI's opaque remote-compaction checkpoint. It does not generate a readable text summary.

Pi can start native compaction for these reasons:

- The built-in `/compact` command.
- Pi's context threshold.
- Pi's overflow recovery.
- This extension's turn-boundary threshold.

The turn-boundary threshold is 90% by default. At that threshold, the extension uses this sequence:

1. It synchronously raises the shared compaction gate and stops the active run after `turn_end`.
2. It waits for `agent_settled`.
3. It starts Pi's normal compaction lifecycle.
4. After success, it submits one durable `Compaction completed. Continue.` request to the workflow continuation coordinator.
5. It closes all overlapping threshold and native operation gates on completion, failure, or runtime reset. A successful final close resumes queued coordinator work.

The continuation request ID is deterministic for the session and active branch/compaction anchor. Duplicate completion callbacks therefore cannot create duplicate automatic turns, and the workflow coordinator reconciles the explicit ID with any request it already persisted. The coordinator, rather than this extension, decides when the gated request can run; this extension never sends an automatic user message directly.

A standalone manual compaction does not reserve a continuation. Pi's overflow recovery also does not use this continuation; Pi retries the overflow request without adding a duplicate turn.

Pi stores a short local marker because each `CompactionEntry` requires a summary. Requests to the matching Codex model exclude this marker. They contain recent user messages, one opaque checkpoint, and messages after that checkpoint.

Repeated compaction replaces the old opaque item. It does not nest opaque checkpoints.

## Manual compaction

`/compact [instructions]` starts native compaction for a matching Codex model.

A standalone `/compact` does not enqueue a continuation or start a new run after compaction. Pi remains idle unless another input is queued.

The optional focus instructions cannot control a readable summary. Native compaction does not create one.

## Configuration

The default configuration is:

```json
{
  "autoCompact": true,
  "thresholdRatio": 0.9
}
```

The extension reads configuration in this order:

1. The default values.
2. `~/.pi/agent/pi-codex-compaction.json`.
3. A trusted project `.pi/pi-codex-compaction.json`.

A project file takes precedence over the global file. The extension does not read this file from an untrusted project.

`autoCompact` must be a Boolean value. `thresholdRatio` must be greater than 0 and less than 1. The extension ignores malformed files and invalid values.

Pi's `compaction.reserveTokens` setting still controls Pi's built-in threshold.

## Checkpoints and sessions

The extension stores each checkpoint in `CompactionEntry.details`. The data includes a format version and the exact `provider:api:model` key.

Resume, fork, and tree navigation use the newest checkpoint on the active branch. A newer standard Pi compaction takes precedence over an older native checkpoint.

A checkpoint works only with the exact model that created it. The extension stops the next Codex request if the checkpoint is malformed or belongs to another model.

## Provider changes

A native checkpoint has no portable text summary. Switch back to the exact Codex model before you continue work that depends on compacted history.

When another provider is active, this extension does not change its context, headers, requests, or compaction lifecycle. That provider receives only the context that Pi can build from the local session boundary.

## Failure behavior

Native compaction fails closed. If the remote request fails, the extension cancels Pi's compaction. It closes only the matching native and threshold gates. It keeps the existing history. It does not fall back to Pi text summarization.

Pi 0.84.3 emits the `session_compact_failed` lifecycle event for failures and aborts after `session_before_compact` returns a native result. The extension retains each native attempt until that terminal event. This closes the correct gate and writes one terminal status marker after a post-hook failure or abort.

The hook finalizes native request failures. Pi's later generic cancellation event then does not duplicate the status or notification. Older Pi 0.84.x releases can register the event name but do not emit it. The existing native-request catch and `ctx.compact({ onError })` fallback handling remains active.

Failed or aborted compactions never enqueue the `Compaction completed. Continue.` continuation. The threshold reservation stays in memory until successful compaction emits the synchronous coordinator request. The process has no timer-based recovery or cross-extension transaction. If the process dies after it commits the checkpoint but before the coordinator handles the event, the extension cannot rebuild the pending reservation after restart. The workflow coordinator owns durable reconciliation and delivery after it handles the event.

Pi's failure event has no compaction operation ID. Local generation and attempt identity protect normal resets and overlapping in-flight requests. Complete attribution of arbitrarily reordered same-session terminal events needs a future Pi operation identifier.

The extension retries transport failures, incomplete streams, HTTP 408, HTTP 409, HTTP 429, and server errors up to two times.

In TUI mode, the session shows these display-only entries:

- `OpenAI compaction running…`
- `OpenAI compaction complete`
- `OpenAI compaction failed: …`

These entries do not enter model context.

## Data handling

The extension sends the effective conversation, current system instructions, and active tool definitions to the model's Codex Responses endpoint.

OpenAI returns an opaque `encrypted_content` value. Pi stores this value in the local session JSONL and sends it again on later requests to the same model.

The extension uses Pi's OAuth resolution. Run `/login openai-codex` before native compaction.

## Request compatibility

Pi does not expose the final provider payload during `session_before_compact`. The extension uses the latest observed Codex request shape and converts Pi history to Responses items.

An extension that changes provider payloads later in load order can cause order-dependent behavior.
