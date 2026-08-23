# Workflow Finalization

This extension provides two shared-tree services:

- a persisted, branch-aware, session-aware single-flight continuation queue; and
- a branch-local implementation-summary state machine.

## Continuation protocol

Producers emit `events.continuationEnqueue` with a stable `producerId`, message, optional `dedupeKey`, and optional synchronous `respond` callback. The coordinator assigns deterministic monotonic request IDs (`<producerId>:<sequence>`), persists the claim before sending one custom-context message, and emits `events.continuationReceipt` only after the triggered agent run starts and emits `agent_settled`. `continuationCancel`, named `continuationGate`, `compactionGate`, and blocking-UI events inhibit dispatch. `continuationActivity` exposes queue, in-flight, and gate state.

Requests retain their origin branch entry. Work from inactive branches remains queued until that origin is in the active branch. Persisted custom-message details are reconciled on reload: delivered requests are not resent, while a persisted dispatch claim with no delivered message returns to the queue. Runtime references and claims are invalidated on shutdown/session replacement. The queue never calls `hasPendingMessages` and uses no debounce timer.

`deterministicProducerId`, snapshot parsing, and `ContinuationCoordinator` are exported for other packages and tests.

## Implementation finalization

Successful `edit`, `write`, `apply_patch`, reviewed repository mutators, conservative likely-mutating Bash, and `events.implementationWaveAdvance` arm a new persisted wave. Read-only tools and failed mutations do not arm it. While armed, `before_agent_start` appends the summary contract.

A valid response has exactly one of each required unfenced heading, in order, with non-empty content:

1. Outcome
2. Changes
3. Validation
4. Review status
5. Risks and blockers

All assistant entries after the wave anchor are searched. The first invalid response queues one “no more changes” correction through the coordinator. The second invalid response warns once. A later mutation advances the wave and resets retry/warning state. Compaction, blocking UI, relevant Hackler batches/integration, and any open coordinator request gate evaluation.

Pure exports include `parseImplementationSummary`, `evaluateImplementationFinalization`, `advanceImplementationWave`, `assistantResponsesAfterAnchor`, `isLikelyMutatingBash`, and `shouldArmForToolResult`.

## Pi API limitation

Pi exposes `session_before_compact` and successful `session_compact`, but no event saying a later handler cancelled compaction. The coordinator therefore keeps the native compaction gate closed after a cancellation until a successful compaction event or session reload. This can defer automation longer than necessary, but cannot dispatch unsafely during a compaction whose outcome is unknown.
