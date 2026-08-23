# Development

## Prerequisites

- Node.js 22 or newer
- Pi 0.84 or newer for runtime checks

Install development tools with `npm install`. Pi supplies peer dependencies at run time. This package has no runtime dependencies and no install lifecycle scripts.

## Commands

```bash
npm run typecheck
npm run lint
npm test
npm run validate:package
npm run lint:docs
npm run check
```

`validate:package` checks the explicit Pi manifest, entrypoint shape, and install-safety rules.

`lint:docs` runs `uv run --no-project python scripts/ste-lint.py` and reports heuristic STE violations in the README and documentation files. It does not block Pi runtime use.

## Feature development workflow

Use this workflow as the canonical path for feature decisions. Keep the result proportional to the change and its risk.

### Change classification

Use the standard engineering path for:

- typos, formatting, and generated-file changes
- color-only changes without a usability claim
- behavior-neutral refactors
- dependency maintenance without intended behavior changes
- clear regression fixes with a deterministic oracle
- conformance to an authoritative specification

The standard path still requires local inspection, applicable tests, documentation updates, and normal review.

For a standard change, record its scope and deterministic oracle. Then continue at [Implementation and validation](#implementation-and-validation).

Use the substantive path for:

- new behavior or agent workflows
- retrieval, ranking, prompting, or memory choices
- UX or accessibility choices
- performance choices
- safety or privacy choices
- evaluation design or effectiveness claims

Use the substantive path when classification is uncertain. A small diff can still contain a substantive product decision.

### Substantive feature contract

The feature contract through local evaluation applies only to substantive-path changes.

Before substantive implementation, record these items in the plan or package documentation:

- goals, non-goals, target users, and deployment context
- public and internal interfaces
- input, output, state, and external-service data flow
- compatibility with supported Pi versions, providers, platforms, and stored state
- observable acceptance criteria
- failure, cancellation, timeout, cleanup, and retry behavior
- security, credential, privacy, and retention limits
- performance budgets and resource limits
- accessibility requirements for user interfaces
- rollback and migration behavior

Before implementation, define applicable baselines, metrics, thresholds, guardrails, budgets, and stop conditions.

Inspect the current local code and tests. Then inspect the target Pi version's documentation, examples, APIs, and relevant source.

Screen the three core harnesses in the [harness catalog](harnesses.md). Compare their cross-harness behavior and record irrelevant or unavailable precedents.

Deeply inspect at least one relevant harness when a precedent exists. Pin a release, tag, or commit before detailed source study.

### Research decision gate

Decide whether external evidence can change a feature decision after local and harness inspection.

Research is usually worthwhile when a decision lacks a deterministic oracle. It is also worthwhile for high-risk or disputed outcome claims.

Research is usually not worthwhile for mechanical conformance to authoritative local behavior. Record the reason and continue with the standard path.

For a research-worthy decision, define the decision, provisional hypotheses, scope, budget, and invalidation rule. Then apply the approval states below.

Do not use paper review as a substitute for local evaluation. A source can motivate a design without validating it in this repository.

### Research approval

- One explicit approval covers one bounded feature research pass.
- An explicit user research request counts as approval.
- Follow-up queries within that pass do not require another question.
- Declined, absent, canceled, unavailable, failed, or noninteractive research proceeds with documented limits.
- Research blocks implementation only when the user made it an acceptance requirement.
- Without applicable local evaluation, describe the design as evidence-informed rather than scientifically validated.
- Do not make unsupported productivity, usability, reliability, safety, or effectiveness claims.

Official Pi and harness documentation review does not require paper-search approval. Keep each approved pass within its named feature and decision scope.

### Research protocol

Use a decision-focused protocol for an approved research pass:

1. State the decision question and provisional hypotheses.
2. Declare the search budget, saturation rule, and invalidation stop rule.
3. Log exact queries, databases, filters, search dates, and source versions.
4. Prefer primary and peer-reviewed evidence when it is available.
5. Traverse key citations backward and forward when they can change the decision.
6. Record inclusion and exclusion reasons for candidate sources.
7. Capture supporting, contradictory, negative, and null evidence.
8. Extract study design, baseline, outcome, uncertainty, bias, and transfer limits.
9. Separate measured findings, author interpretation, and repository inference.
10. Stop at the declared budget, search saturation, or hypothesis invalidation point.

Use the ACM SIGSOFT empirical standards to plan and report software studies.[^sigsoft]

Use Wohlin's snowballing guidance when citation traversal forms part of the search.[^wohlin]

Use the NIST AI RMF and CAISI guidance to frame risk, measurement, and deployment-context limits.[^nist][^caisi]

Use PRISMA when claiming review completeness. Do not label a bounded scan as a systematic review.[^prisma]

Use ISO 9241-11 concepts for applicable usability studies.[^iso-usability]

LLM outputs can vary under matched settings. Record exact conditions, use repetitions, and report distributions.[^llm-variance]

The following values are repository heuristics, not universal scientific thresholds:

- Set 30 to 90 minutes for an initial bounded search.
- Review 5 to 12 credible sources when that many relevant sources exist.
- Stop after two well-targeted query variants add no decision-changing evidence.
- Increase the budget for consequential, heterogeneous, or unstable evidence.

A declared budget bounds effort. It does not prove completeness or statistical adequacy.

### Local evaluation template

Predeclare the applicable fields before running an evaluation. Mark an inapplicable field instead of silently omitting it.

| Area | Required record |
| --- | --- |
| Claim | Target claim and deployment context |
| Baselines | Current-main, simple, and strong-alternative baselines |
| Measures | Metrics, thresholds, guardrails, and resource budgets |
| Tasks | Sampling method, task mix, exclusions, and representativeness limits |
| Versions | Exact model, provider, prompt, tools, harness, repository, and dataset versions |
| Design | Pairing, randomization, repetitions, retries, and timeout behavior |
| Judgment | Oracle, grader, blinding, leakage checks, and grader-gaming checks |
| Outcomes | Raw outcomes, distributions, uncertainty, failures, and resource use |
| Validity | Internal, external, construct, and conclusion-validity threats |
| Decision | Ship, revise, reject, or inconclusive, with the stated reason |
| Operations | Monitoring triggers, rollback conditions, owner, and review date |

Use current main as a baseline even when the feature has no previous dedicated implementation.

Prefer deterministic oracles and blinded human review. Treat an LLM grader as another measured component, not as ground truth.

Keep task conditions paired when possible. Randomize condition order and retain severe failures outside aggregate scores.

Do not run paid-provider evaluations in normal offline checks. Make each necessary live test explicit and opt-in.

### Implementation and validation

After standard-path classification or the substantive decision gate:

1. Implement the smallest coherent change that meets its recorded scope and applicable feature contract.
2. Add deterministic tests for applicable behavior, failure, cancellation, and cleanup.
3. Add opt-in live tests only when an offline oracle cannot cover a required behavior.
4. Update the package README and shared canonical documentation.
5. Update `THIRD_PARTY_NOTICES.md` after material reference, copying, or adaptation.
6. Run focused checks for every changed package.
7. Run `npm run check`.
8. Run `npm run lint:docs` when Markdown changes and review each finding.
9. Record skipped or unavailable checks and the resulting claim limits.

### Evidence storage

Keep durable evidence with the feature that uses it:

- Add a dated package README section for a small durable decision.
- Add a linked package-local `*_EVALUATION.md` for a substantial or high-risk evaluation.
- Record ISO dates and immutable source, harness, repository, dataset, prompt, and model revisions.
- Revalidate fast-changing model, provider, price, benchmark, and harness evidence before reuse.
- Use [`MODEL_SELECTION.md`](../packages/subagents/MODEL_SELECTION.md) and [`ORCHESTRATION_EVALUATION.md`](../packages/subagents/ORCHESTRATION_EVALUATION.md) as existing examples.

Do not create a central evidence directory. Do not backfill historical features without a current feature need.

Keep evidence findings out of `THIRD_PARTY_NOTICES.md`. That file remains the attribution and license ledger.

## Local runtime check

Use an isolated Pi configuration directory. This prevents local tests from changing normal settings:

```bash
PI_CONFIG_DIR="$(mktemp -d)" pi install "$(pwd)"
PI_CONFIG_DIR="$PI_CONFIG_DIR" pi
```

Test the workflow state machines with these cases:

1. Run `/plan-review` more than once on the same branch.
2. Return a complete revised plan after a review.
3. Return an invalid revision, then a valid correction.
4. Return two invalid revisions and confirm that Pi shows one warning.
5. Test current-session and fresh-session plan implementation.
6. Switch branches while a Plan review or Hackler batch is open.
7. Return to the origin branch and confirm one deferred continuation.
8. Run parallel Reviewer batches and confirm one aggregate per dispatch call.
9. Run nested orchestration and confirm that child results go to the owning orchestrator.
10. Stop a nested owner early and inspect the folded orphan evidence.
11. Trigger the Codex threshold compaction and confirm one continuation after completion.
12. Make a repository change and return the five-section implementation summary.
13. Return an invalid summary and confirm one correction plus one final warning.

Test Session Summary with these active-provider cases:

1. Use Copilot Luna without a profile file.
2. Use Codex Spark while Spark is available.
3. Make Spark unavailable and confirm the Codex Luna fallback.
4. Use an unprofiled provider and confirm that its active model handles the request.
5. Switch providers and confirm that Session Summary never sends data across providers.
6. Confirm that the first meaningful completed turn starts one automatic attempt.
7. Confirm that later turns, restarts, and `/tree` navigation do not start another automatic attempt.
8. Confirm that a greeting, a tool call, and an incomplete response do not consume the attempt.
9. Confirm that Pi's working row stays visible and that Session Summary adds no status row.
10. Confirm that an automatic failure shows one warning and does not retry.
11. Confirm that successful manual and backfill commands are silent.
12. Confirm that manual failures show a warning and mixed backfill failures show one aggregate warning.
13. Run `/session-summary`, `/session-summaries`, and `/session-summary-cost` without optional tools.

## Workflow state files

Workflow Finalization stores branch-local custom entries in the session tree. Plan Mode reads version-1 state and writes version 2 after the next state change. Hackler reads manager schema version 2 without replaying old completion messages. It writes new dispatch batches with schema version 3.

A continuation producer owns its stable request ID and persisted producer state. The coordinator owns message dispatch and the post-settlement receipt. Do not call `pi.sendMessage()` as a fallback for an automatic continuation.

The coordinator cannot reserve a turn atomically against user input or process termination. This limit requires a Pi reservation API. Tests must verify deterministic recovery instead of claiming process-level exactly-once delivery.

## Method sources

[^sigsoft]: [ACM SIGSOFT Empirical Standards for Software Engineering Research](https://www2.sigsoft.org/EmpiricalStandards/), living standards, accessed 2026-08-23. See also the [2020 report](https://arxiv.org/abs/2010.03525).
[^wohlin]: Claes Wohlin, [Guidelines for snowballing in systematic literature studies and a replication in software engineering](https://doi.org/10.1145/2601248.2601268), EASE 2014.
[^nist]: NIST, [Artificial Intelligence Risk Management Framework 1.0](https://doi.org/10.6028/NIST.AI.100-1), NIST AI 100-1, January 2023.
[^caisi]: NIST CAISI, [Practices for Automated Benchmark Evaluations of Language Models](https://doi.org/10.6028/NIST.AI.800-2.ipd), NIST AI 800-2 Initial Public Draft, January 2026.
[^prisma]: Page et al., [The PRISMA 2020 statement](https://doi.org/10.1136/bmj.n71), *BMJ*, March 2021. PRISMA guides reporting rather than review conduct or quality appraisal.
[^iso-usability]: [ISO 9241-11:2018, Usability: Definitions and concepts](https://www.iso.org/standard/63500.html), edition 2, confirmed current in 2023. ISO does not prescribe one evaluation method.
[^llm-variance]: Atıl et al., [Non-Determinism of “Deterministic” LLM System Settings in Hosted Environments](https://doi.org/10.18653/v1/2025.eval4nlp-1.12), Eval4NLP 2025. The tested hosted systems do not represent every model or local runtime.
