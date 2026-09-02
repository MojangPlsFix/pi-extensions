---
name: harness-feature-gap-research
description: Repeat the dated repository research for missing coding-harness features. Use only through /skill:harness-feature-gap-research when the user requests a new evidence-backed feature-gap report.
compatibility: Requires a trusted Git project, Pi 0.84 or later, and access to configured repository research tools.
disable-model-invocation: true
---

# Harness Feature-Gap Research

## Purpose

Repeat research in this repository for useful coding-harness features that are still missing. Write one dated decision report under `docs/`.

Do not implement a candidate feature during this workflow.

## Default scope

Use these defaults unless the user gives different constraints:

- Exclude sandboxes, virtual machines, and worktree isolation.
- Exclude new model providers and vendors.
- Exclude new paid APIs, hosted services, and paid search systems.
- Exclude features that Pi or this repository already supplies.
- Prefer provider-neutral features that Pi can support as an extension.

Ask a structured user question when a missing requirement changes the research scope. Do not ask for information that repository inspection can answer.

## Authority and policy

Before research, read these files completely:

1. `AGENTS.md`
2. `docs/development.md`
3. `docs/harnesses.md`
4. The README for each applicable package
5. The installed Pi documentation for each relevant API

Treat the installed Pi version as implementation authority. External harnesses show precedent only.

Follow the repository substantive-feature workflow. Starting this skill approves the bounded research pass. It does not approve implementation.

## Output

Use the local ISO date for the report name:

```text
docs/YYYY-MM-DD-harness-feature-gap-report.md
```

Find the newest earlier file that matches `docs/*-harness-feature-gap-report.md`. Use it as a comparison baseline, not as current evidence.

If the same-date path exists, ask before replacement. Do not overwrite it silently.

When Plan Mode is active, complete read-only research and return a file-writing plan. Do not create or change files in Plan Mode.

Outside Plan Mode, write the report after the evidence and ranking are stable.

## Research workflow

### 1. Set the decision frame

Record these items before broad search:

- goal
- exclusions
- intended users
- current Pi version
- candidate ranking criteria
- search budget
- stop conditions

Use an ordinal ranking. Do not invent a numeric score without measured inputs.

Rank these factors:

1. released cross-harness use
2. confirmed local gap
3. Pi feasibility
4. dependency and operating cost
5. failure and rollback risk
6. direct evidence quality

### 2. Inspect the local repository

Read `package.json`, the root README, applicable package READMEs, and related tests.

Build a current capability map. Verify each claimed gap with source searches. Distinguish a complete gap from partial overlap.

Check Pi core before recommending a new extension. Remove candidates already covered by Pi sessions, tools, JSON mode, RPC mode, output handling, or project trust.

### 3. Inspect Pi

Pin the installed Pi package version. Read its documentation and examples completely for each relevant API.

Verify these points when applicable:

- event and tool hooks
- session and branch behavior
- project trust
- headless behavior
- state persistence
- cancellation and cleanup
- active-tool behavior

Do not infer support from a newer default branch.

### 4. Screen the core harnesses

Screen every core reference from `docs/harnesses.md`:

- OpenCode
- OpenAI Codex CLI
- oh-my-pi

Pin a stable release, tag, or commit before detailed source inspection. Use official source, documentation, release records, and tests.

Use managed repository references when source search cannot verify an exact pin. Resolve and record the full commit hash. Clean up every managed reference after review.

Separate these evidence classes:

- released and active behavior
- released but disabled behavior
- experimental behavior
- source code without a confirmed runtime path
- issue or proposal
- parent inference

### 5. Screen task-specific references

Use Cline, Gemini CLI, or another catalog entry only when it directly matches a candidate.

Do not screen extra harnesses to inflate prevalence. Record why each task-specific source applies.

Recheck the license at the pinned revision before suggesting copied or adapted code. Citation alone does not require a notice change.

### 6. Use external research carefully

Use serious primary evidence when it can change the decision. Prefer peer-reviewed proceedings, publisher pages, author manuscripts, and released datasets.

For each study, record:

- sample and task domain
- measured variables
- tested intervention, if any
- findings
- transfer limits
- claims the study does not support

Do not convert association into causation. Do not claim that a harness feature improves results without a matching evaluation.

Stop broad search after two focused query variants add no decision-changing evidence. State that this is a bounded review, not a systematic review.

### 7. Use Hackler only for independent work

Check `subagent_status` before each wave. Dispatch only independent ready tasks with disjoint ownership.

A suitable first wave can include:

- one local Pi and repository gap audit
- one OpenCode screen
- one Codex screen
- one oh-my-pi screen

Run candidate-specific deep reviews only after the first wave identifies a real gap. Use task-specific harness screens only when needed.

The parent must verify child reports against exact pinned source. Resolve contradictions before ranking. Do not copy a child report directly into the final document.

### 8. Compare with the prior report

When an earlier report exists, add a `Changes since the prior report` section.

Record:

- candidates added or removed
- rank changes
- local features that closed an old gap
- changed harness behavior
- changed evidence confidence
- sources that became stale or unavailable

Revalidate old claims. Do not reuse an old release pin as current evidence.

### 9. Write the report

Use this section order:

1. title and research metadata
2. scope and exclusions
3. method
4. version pins
5. changes since the prior report, when applicable
6. current local coverage
7. ranked result
8. one section for each ranked candidate
9. applicable research evidence
10. candidates not advanced
11. recommendation
12. revalidation triggers
13. repeat instructions
14. research limits

For each candidate, include:

- released precedent
- local gap or overlap
- dependency options
- operating cost
- failure and security boundaries
- evidence confidence

Use immutable source links where possible. Keep statements short and factual. Use STE-flavored technical prose.

Do not add implementation code. Keep scientific evidence out of `THIRD_PARTY_NOTICES.md`.

## Validation

After writing the report, run:

```bash
uv run --no-project python scripts/ste-lint.py \
  docs/YYYY-MM-DD-harness-feature-gap-report.md \
  .agents/skills/harness-feature-gap-research/SKILL.md
npm run lint:docs
npm run check
git diff --check
```

Replace the date placeholder with the actual report path.

Review every linter finding. Fix relevant prose findings. Do not change code, identifiers, or source quotations only to lower a heuristic score.

Use `DefaultResourceLoader` from Pi to verify this skill. Follow the installed `examples/sdk/04-skills.ts` example.

Verify these conditions:

- Pi discovers `harness-feature-gap-research`.
- The discovered path is this project skill.
- Pi reports no diagnostic for this skill.
- `disable-model-invocation` is true.

## Completion

Report every command and result. Report skipped or failed checks accurately.

Stop after the dated report and research summary. Do not implement a ranked candidate without a separate user decision.
