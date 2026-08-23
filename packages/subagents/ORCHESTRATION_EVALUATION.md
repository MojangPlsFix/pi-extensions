# Evaluate Hackler orchestration

Use this guide to compare orchestration policies. It does not report a Hackler benchmark result.

Hackler does not publish private local task distributions. The repository also does not run paid live-provider evaluations in continuous integration (CI).

Treat all current runtime defaults as pilots. The limits supply bounded starting points, not universal optima.

## Interpret the evidence

Multi-agent gains depend on the task and the tested topology. One peer-reviewed study found gains and losses across different task types.[^collaboration]

A separate study found that parallel sampling and sequential iteration did not improve agent results reliably.[^scaling]

Communication cost can increase faster than agent count in some topologies.[^collaboration] This result does not cover every communication design.

These findings support conditional evaluation. They do not prove that one Hackler policy is best.

Hackler treats functional specialization as a stronger control than persona-only prompts. A functional specialist has distinct authority, tools, context, ownership, and acceptance criteria.

A persona-prompting study found no consistent factual-performance gain from adding personas to system prompts.[^personas] It did not test Hackler-style functional controls. Treat this policy as an evaluation hypothesis, not a measured universal result. Prompted or model diversity can still produce correlated errors.[^correlated-errors]

One judge-panel study also found much less effective independence than the panel size suggested.[^panels]

Hackler also favors adaptive waves and sparse communication over fixed fan-out. Dispatch only the ready work that has a substantial independent scope.

Recompute the frontier after each wave. Stop delegation when no eligible task remains or when further delegation cannot pass its expected cost threshold.

The cited studies motivate these controls but do not validate this policy for Hackler. Test the policy on the target repository.

## Verify outcomes

Use tests, executable checks, and primary evidence as the main verification sources. Use model self-review only as supporting evidence.

NIST recommends test sets that represent the expected use case.[^nist]

A code-review study found plausible but incorrect model explanations.[^review] Executable counterfactual checks improved verification in the tested domain.

A passing check only supports behavior that the check covers. Record missing coverage and manual judgments.

For a pending isolated patch, a trusted local validator can collect this evidence through an explicit `subagent_validate` call or Agent Hub action. It runs the exact stored patch once in a disposable detached worktree with bounded time and output. It does not run automatically, retry, rank, integrate, or call a provider. Record nonzero exits, spawn failures, timeout, cancellation, output overflow, and retained cleanup quarantine as outcomes rather than converting them into scores. Do not integrate while the validator is active or cleanup is unproven. The validator is not an OS sandbox, and a passing result does not establish correctness beyond the check's coverage.

Evaluate this action with paired local candidates before claiming that it improves decisions or correctness. Predeclare the candidate set, validator command, defect oracle, integration decision metric, time budget, output cap, and cleanup guardrail. Compare the same candidates with and without the validation report while keeping the parent, prompt, and other evidence fixed. Report ordinary failures, unsupported candidates, and quarantines separately. Do not use validator exit status as the defect oracle.

### Validator design screen (2026-08-23)

The implementation review pinned [OpenCode v1.18.9](https://github.com/anomalyco/opencode/tree/v1.18.9), [OpenAI Codex `rust-v0.98.0`](https://github.com/openai/codex/tree/rust-v0.98.0), and [oh-my-pi `15b5c139`](https://github.com/can1357/oh-my-pi/tree/15b5c1397fc059673e3b0bcbc50b074e6dc1f9d8). OpenCode supplied conceptual process-group and no-sandbox precedents. Codex supplied an explicit review-action precedent. Oh-my-pi supplied the closest detached-worktree and interrupted-recovery precedent. No harness combined trusted checks, exact stored patches, report-only output, and the required cleanup lifecycle. The implementation is independent and uses these sources as design constraints, not as effectiveness evidence. No scholarly search was necessary for the deterministic conformance decisions in this feature.

## Compare five policies

Compare these policies under matched aggregate budgets:

1. **Strong parent-only baseline.** One capable parent does all task work, review, and synthesis.
2. **One best-fit specialist.** The parent delegates one bounded slice to the best functional specialist.
3. **Static initial batch.** The parent dispatches one initial ready batch and does not dispatch a later wave.
4. **Adaptive waves.** The parent dispatches the smallest justified ready batch and recomputes the frontier after each wave.
5. **Fixed fan-out.** The parent targets a fixed child count whenever capacity permits, even when the frontier is smaller.

Do not give one policy more aggregate model resources. Match the total token, turn, and reported-cost ceilings.

Also match the repository revision, task input, tool policy, provider snapshots, test window, and grader. Keep the parent model fixed across child policies.

If a condition uses a different specialist model, report that difference. Separate topology effects from model-selection effects with another matched comparison.

Record actual resource use as well as each ceiling. A policy that stops early must keep that efficiency benefit.

## Use four task strata

Run all five policies on matched tasks from each stratum:

1. **Wide independent frontier.** Many substantial slices are ready and have disjoint ownership.
2. **Mixed dependency DAG.** Some slices are ready while other slices depend on earlier results.
3. **Mostly sequential work.** Most useful work depends on the previous result.
4. **Writer/approval-constrained work with a straggler.** Ownership, approval, and one slow task limit useful parallel work.

Keep task difficulty balanced within each stratum. Pair each policy on the same task instance.

The strata test topology fit. They do not predict a winner.

## Define success before each run

Set the primary success rule before you inspect outputs. Use repository tests or another executable task oracle when possible.

Also score these failure and resource measures:

- severe regression or unsafe change
- acceptance-criteria completion
- ownership violation or duplicate work
- unsupported claim or missed primary evidence
- parent synthesis error
- wall time and critical-path time
- child and parent tokens, turns, tool calls, and reported cost
- blocked time and supervisor response time
- slot use, eligible idle capacity, and communication volume
- retries, steering events, revivals, and limit terminations

A parked run is not proof of task success. Grade its result against the task oracle and acceptance criteria.

Randomize policy order. Use paired task-level analysis and report uncertainty.[^paired]

Five repetitions per condition are a local screening rule, not a statistical adequacy rule. Use a power analysis for consequential decisions.

## Keep local tasks private

Use private local tasks as the final gate. Do not publish the task distribution, hidden cases, prompts, or per-task outputs.

Publish only aggregate results when disclosure is safe. Remove repository paths, task text, reports, request text, and secrets.

Public benchmarks can help create a shortlist. They cannot replace the private local gate.

## Collect a runtime trace

Run this command in the parent Pi session:

```text
/agents trace --json
```

Use `/agents trace` for a short metric summary. Trace schema version 1 contains redacted run, lease, capacity, request, and activity metadata.

The trace excludes task text, reports, request text, ownership, and file paths. Review the JSON before you export it.

The trace reports metrics only when their source data is complete. Read an unavailable value as missing data, not as zero.

The trace can calculate makespan, slot use, blocked dwell, answered-request latency, wrap lead time, limit-hit rate, and child resources. Eligible capacity, schedulable idle, and critical path require an explicit benchmark readiness fixture.

The command does not grade correctness. Join the trace to a separate blinded or executable outcome record with a random evaluation identifier.

## Current runtime controls

The current global defaults are four active runs, one shared-checkout writer, and nesting depth two. Configuration accepts 1 through 32 active runs and 0 through 8 shared writers.

Nesting depth cannot exceed two. A profile can set a smaller depth.

The default wall limit is 2,700 seconds. Configuration can set 1 through 2,700 seconds.

The default turn limit is 128. Configuration can set 1 through 128 turns.

The default wrap threshold is `0.8`. Configuration requires a value greater than zero and less than one.

Each non-external run uses the minimum of the global turn limit and the profile turn budget. External runs do not have a model-turn limit.

Each run uses the minimum of the global wall limit, profile timeout, and external-runner timeout. The wall lease includes startup and finalization.

Profile token and cost budgets also apply when present. The manager checks reported token and cost totals after usage events.

A wrap threshold applies to wall and turn limits. At the threshold, Hackler queues or sends a private wrap request to a native or RPC child.

The request tells the child to stop exploration and report. The hard deadline still ends the run.

An external runner receives no private wrap request because it is a one-shot process.

### Built-in pilot roster

| Profile | Class | Timeout | Turn budget |
| --- | --- | ---: | ---: |
| `scout` | `read` | 600 seconds | 60 |
| `researcher` | `advisory` | 1,800 seconds | 64 |
| `worker` | `write` | 1,800 seconds | 110 |
| `reviewer` | `review` | 2,100 seconds | 40 |
| `oracle` | `advisory` | 2,100 seconds | 72 |
| `orchestrator` | `orchestrator` | 2,700 seconds | 128 |
| `plan-reviewer` | `review` | 2,100 seconds | 40 |

The hidden `plan-reviewer` supports Plan Mode. These values are pilot defaults.

### Dispatch and stop contracts

Every dispatch must include a unique key, profile, self-contained task, owned scope, deliverable, acceptance criteria, and stop conditions. The manager rejects an empty acceptance rule or stop list.

Dispatch only substantial work from the ready frontier. Stop a task after it meets acceptance criteria or reaches a declared blocker.

Stop a run when its scope becomes obsolete, unsafe, or incoherent. Do not steer repeatedly to replace a poor contract.

`subagent_collect` defaults to a 60-second wait. An explicit `timeoutSeconds` must be from 10 through 3,600 seconds.

Collection returns after the selected settlement condition, a blocker, a timeout, or cancellation. Resolve a blocker before another wait.

### Leases, revival, and telemetry

Each start or revival opens a wall lease. A revival keeps the original profile and capability policy.

A later configuration can only tighten the original wall, turn, and wrap limits. Turn use stays cumulative across revivals.

Only a parked native or RPC run with a persisted session can revive. External runs cannot revive.

A hard-limit failure cannot revive. A run also cannot revive after it exhausts its cumulative turn limit.

The Hub and status tool show capacity, lease time, turns, current operation, blockers, and termination reasons. The runtime records status transitions, usage, lease generations, wrap causes, and structured stop reasons.

## Treat external defaults as precedents

External systems can supply safety precedents for bounded concurrency, turns, or communication. They do not establish a Hackler optimum.

For example, Anthropic reports high token use for its research multi-agent system.[^anthropic-system]

That system used a lead agent and delegated parallel research.

Its workload and harness differ from Hackler software tasks. Use such reports to select safe pilot bounds, then test local alternatives.

## Admit a future profile

Add or enable a future built-in profile only when it meets all of these criteria:

1. It addresses a recurring need across projects.
2. It has distinct tools, authority, context, or workspace that the nearest existing profile does not supply.
3. Its dispatch trigger is explicit and does not overlap an existing profile trigger.
4. It passes private local tasks in every target stratum.
5. It improves a predeclared primary outcome over the nearest existing profile under a matched aggregate budget.
6. It does not increase severe failures beyond the predeclared limit.
7. Its latency, token, cost, and communication use stay within predeclared limits.
8. Repeated runs show that the gain is not one task or one model snapshot.
9. Tests cover dispatch, limits, lifecycle, policy, telemetry, and bounded failure behavior.
10. Documentation labels its runtime values as pilots until later evidence supports a stable default.

Do not admit a profile from public benchmark rank, provider claims, or persona preference alone.

## CI policy

CI uses deterministic tests and fixtures. It does not call paid live providers.

Run live-provider evaluations manually in an approved environment. Record the provider, immutable model snapshot, prices, quota policy, harness revision, and evaluation date.

Do not commit credentials, private tasks, raw transcripts, or local result distributions.

## Source notes

The citations below scope claims to the tested systems. No source validates the complete Hackler orchestration policy.

[^collaboration]: [Capable language models can outgrow the benefits of collaboration](https://doi.org/10.1038/s42256-026-01268-y), *Nature Machine Intelligence*, July 24, 2026.
[^scaling]: [Benchmark Test-Time Scaling of General LLM Agents](https://arxiv.org/abs/2602.18998), revision available February 22, 2026. Preprint.
[^personas]: [When “A Helpful Assistant” Is Not Really Helpful: Personas in System Prompts Do Not Improve Performances of Large Language Models](https://aclanthology.org/2024.findings-emnlp.888/), Findings of EMNLP 2024, November 2024.
[^correlated-errors]: [Correlated Errors in Large Language Models](https://proceedings.mlr.press/v267/kim25e.html), ICML 2025, accessed August 21, 2026.
[^panels]: [Nine Judges, Two Effective Votes](https://doi.org/10.48550/arXiv.2605.29800), revision available May 28, 2026. Preprint.
[^nist]: [NIST AI Risk Management Framework 1.0](https://doi.org/10.6028/NIST.AI.100-1), January 26, 2023.
[^review]: [Are LLMs reliable code reviewers?](https://doi.org/10.1007/s10515-026-00638-5), *Automated Software Engineering*, June 26, 2026.
[^paired]: [Adding Error Bars to Evals](https://www.anthropic.com/research/statistical-approach-to-model-evals), November 19, 2024. Provider-authored statistical guidance.
[^anthropic-system]: [How we built our multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system), Anthropic Engineering, June 13, 2025. Provider-authored system report, accessed August 21, 2026.
