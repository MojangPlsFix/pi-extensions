# Workflow Finalization

This extension provides two shared-tree services:

- a persisted, branch-aware, session-aware single-flight continuation queue; and
- a branch-local implementation-summary state machine.

## Continuation protocol

Producers emit `events.continuationEnqueue` with a stable `producerId` and message. They can also set a canonical `requestId`, a deduplication key, and an origin entry. The synchronous `respond` callback returns the accepted or reconciled request ID.

The coordinator persists each claim before it sends one custom-context message. It preserves the producer custom type and renderer details. It adds a `workflowContinuation` receipt envelope to the message details. The coordinator emits `events.continuationReceipt` only after the matching run starts and settles.

`continuationCancel`, named `continuationGate`, `compactionGate`, and blocking UI events stop dispatch. `continuationActivity` reports active-branch queue, in-flight, and gate state.

Each request retains its origin branch entry. A request waits while its branch is inactive. Reload reconciliation follows entry ancestry, so sibling assistant messages cannot complete the request. The coordinator does not resend a delivered custom message. A persisted claim without a delivered message returns to the queue.

Shutdown and session replacement clear all runtime references. The queue never calls `hasPendingMessages` and uses no debounce timer.

`deterministicProducerId`, snapshot parsing, and `ContinuationCoordinator` are exported for other packages and tests.

## Implementation finalization

Successful `edit`, `write`, `apply_patch`, reviewed repository mutators, project-confined Context execution tools, conservative likely-mutating Bash, and `events.implementationWaveAdvance` arm a new persisted wave. Read-only tools and failed mutations do not arm it. A Reviewer completion advances only a wave that implementation work already armed. While armed, `before_agent_start` appends the summary contract.

A valid response has exactly one of each required level-two heading. The headings stay outside fenced examples, use this order, and have non-empty unfenced content:

1. Outcome
2. Changes
3. Validation
4. Review status
5. Risks and blockers

All assistant entries after the wave anchor are searched. The first invalid response queues one “no more changes” correction through the coordinator. The second invalid response warns once. A later mutation advances the wave and resets retry/warning state. Compaction, blocking UI, relevant Hackler batches/integration, and any open coordinator request gate evaluation.

Pure exports include `parseImplementationSummary`, `evaluateImplementationFinalization`, `advanceImplementationWave`, `assistantResponsesAfterAnchor`, `isLikelyMutatingBash`, and `shouldArmForToolResult`.

The Bash classifier detects reviewed mutation patterns. These include file commands, output redirection, Git changes, dependency changes, and formatter write flags. It does not classify arbitrary third-party commands. Producers must emit `implementationWaveAdvance` when another reviewed integration changes the checkout.

## State and migration

The extension stores continuation snapshots and implementation waves as version-1 custom entries. It merges continuation request revisions across the session tree. It restores implementation waves only from the active branch. Malformed or unknown state versions do not start work.

A producer owns its canonical request ID and producer state. The coordinator owns dispatch, custom-message correlation, and settlement receipts. A producer must not send the same automatic continuation directly as a fallback.

## Pi API limitation

Pi exposes `session_before_compact` and successful `session_compact`. Compaction producers use separate operation IDs for overlapping work. A successful close can resume queued work; a failure close does not dispatch from inside the failure callback. Pi does not report when an unrelated later handler cancels compaction. Without a producer close event, the native fallback gate stays closed until a later lifecycle event or session reload.

Pi also has no atomic extension turn reservation. User input or process termination can occur between the persisted claim and Pi message dispatch. Stable IDs and reload reconciliation reduce duplicates, but they cannot make this process-level window atomic.
