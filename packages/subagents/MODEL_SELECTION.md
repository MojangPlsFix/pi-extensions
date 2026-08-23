# Select models for Hackler profiles

Hackler has no universal best model policy. Select each profile with evidence from the repository, harness, and provider that you use.

This guide names evaluation criteria and benchmark families. It does not recommend one provider or model family for all users.

Evidence review date: **2026-08-21**. Review a provider-specific preset at least every 90 days because models, prices, and limits change quickly.

## Interpret the evidence

Public scores describe a tested system. That system includes the model, harness, tools, prompt, budget, benchmark version, and grader.

This guide uses two labels:

- **Measured result:** A source directly measured the stated result.
- **Role inference:** The source measured a related capability, which this guide maps to a Hackler profile.

No cited source validates the complete Hackler profile set. Confirm every role inference with local tests.

## Evidence hierarchy

Use evidence in this order:

1. Paired local tasks in the actual repository and harness
2. Role-specific agent benchmarks
3. Related task benchmarks
4. General intelligence benchmarks
5. Provider positioning and unverified claims

NIST recommends realistic test sets that represent the expected use case.[^nist]

Paired analysis on shared tasks can reduce task-difficulty variance.[^paired-evals]

This evidence supports the hierarchy, but no source defines it as a universal ranking. Use public benchmarks to create a shortlist, not a deployment verdict.

## Profile requirements

| Profile | Required capabilities |
| --- | --- |
| **Scout** | Repository localization, tool efficiency, grounded paths, concise handoffs, and low latency |
| **Researcher** | Source quality, citation precision and recall, contradiction checks, factual synthesis, and effective context use |
| **Worker** | Patch correctness, terminal use, tests, debugging, instruction adherence, and long-horizon completion |
| **Reviewer** | Defect recall and precision, false-positive control, severity ranking, fresh context, and external verification |
| **Oracle** | Difficult reasoning, contradiction detection, long-context analysis, calibrated uncertainty, and abstention |
| **Orchestrator** | Decomposition, dependency tracking, parallelism judgment, coordination efficiency, and synthesis |
| **Plan Reviewer** | Completeness, executability, constraint coverage, failure behavior, and test coverage |

Evaluate each profile separately. A model that passes Worker tasks can still fail Reviewer or Orchestrator tasks.

## Select model tier and thinking effort separately

Model tier and thinking effort are separate choices. One current provider exposes them as independent controls.[^openai-model-guide] Other providers can use different controls or labels.

First, compare model tiers at one fixed effort. Keep the prompt, tools, tasks, and budgets unchanged.

Then compare effort levels for each tier that passes. Test tier-and-effort interactions when results are close.

Use these starting points:

- Use low effort for clear, latency-sensitive, and retryable work.
- Use balanced effort for normal work. In schema v2, `medium` is the usual balanced label.
- Use high effort for ambiguous or multi-step work. Compare `high` and `xhigh` when the provider supports both.
- Use maximum effort only for rare, quality-first tasks.

Select the lowest effort that passes representative local evaluations. Higher effort is not an automatic quality guarantee.

Provider guidance can help create test conditions. Treat its performance and cost claims as provider evidence, not neutral findings.[^openai-builders]

## Match benchmarks to the profile

### Scout

**Measured result:** SWE-Explore ranks relevant code regions under a fixed line budget.[^swe-explore]

Its labels come from successful repair trajectories.

**Role inference:** Test Scouts on known-target localization and retrieval tasks.

Measure path recall, ranking, irrelevant context, tool calls, and latency.

Include local tasks where the Scout must name exact files and symbols. A repair benchmark does not measure handoff quality by itself.

### Researcher

**Measured result:** BrowseComp tests persistent web search for hard-to-find facts.[^browsecomp]

It does not test long-form synthesis or citation quality.

**Measured result:** ScholarQABench tests scientific synthesis and sentence-level citation precision and recall.[^scholarqa]

Its public artifacts and static tasks can create contamination or staleness risks. Record the dataset, corpus, and retrieval dates.

**Role inference:** Test Researchers on both search and synthesis. Score factual accuracy, source quality, citation support, citation coverage, contradiction checks, and missing evidence.

Use the exact benchmark name `ScholarQABench`. `ScholarQA` can also refer to a system or product.

### Worker

**Measured result:** The Coding Agent Index combines several coding-agent evaluations.[^coding-index] Its rows represent agent variants, not bare models.

Inspect component results, harness settings, cost, tokens, and time. Do not select a Worker from the aggregate score alone.

**Measured result:** The Terminal-Bench 2.0 paper uses isolated terminal environments and executable tests.[^terminal-bench]

The official 2.1 refresh corrected 26 tasks.[^terminal-bench-2-1] Pin the benchmark release in each result.

**Measured result:** DeepSWE uses original, long-horizon tasks with behavioral verifiers.[^deepswe]

Its freshness was time-bounded at construction. Public release permits later training or evaluation exposure.

**Measured result:** SWE-bench Live adds recent repository tasks over time.[^swe-live] Public live tasks can still become stale or contaminated.

**Role inference:** Combine terminal tasks, long-horizon changes, and fresh repository work. Keep private local tasks as the final gate.

### Reviewer

**Measured result:** A code-review study tested correct and injected-bug implementations.[^review-study] It found prompt-dependent false acceptance and false rejection.

The study also found plausible but incorrect cause-level explanations. Executable counterfactual checks improved verification in its test domain.

**Role inference:** Seed realistic defects into representative changes. Also include correct changes so false-positive rates remain visible.

Measure defect recall, finding precision, false positives, severity order, and verified fixes. Use realistic pull requests in addition to synthetic defects.

### Oracle and Plan Reviewer

**Measured result:** Plancraft tests multi-step planning, efficiency, tool use, and unsolvable tasks.[^plancraft]

It does not test software plan review.

**Measured result:** ICAPS planning research separates executability, validity, and goal satisfaction.[^icaps-planning]

Local coherence did not guarantee global plan validity.

**Measured result:** HELMET found that simple retrieval tests did not predict all long-context tasks.[^helmet]

Performance also changed with task type and context length.

**Measured result:** ContraDoc tests nuanced contradictions in long documents.[^contradoc]

**Measured result:** Calibration research shows that accuracy and confidence require separate evaluation.[^calibration]

**Role inference:** Test planning, long-context use, contradictions, uncertainty, and abstention separately. Do not collapse these capabilities into one general score.

Advertised context size does not prove effective long-context reasoning. Test the expected context length with the actual prompt and tools.

### Orchestrator

**Measured result:** WorkBench tests planning and tool use through outcome-based workplace tasks.[^workbench]

The original benchmark is not a multi-agent benchmark.

**Measured result:** A 2026 multi-agent study found gains and losses across task types.[^multi-agent-study]

Task decomposability and single-agent capability changed the result.

**Measured result:** A separate study tested sequential iteration and parallel sampling.[^agent-scaling]

Neither method improved agent results reliably. Verification and context limits affected both methods.

**Role inference:** Compare orchestration with a strong parent-only baseline under matched aggregate budgets. Measure completed work, coordination cost, duplicate work, and synthesis errors.

Test functional specialization before persona-only prompts. A functional specialist has distinct authority, tools, context, ownership, and acceptance criteria. One persona-prompting study found no consistent factual-performance gain from persona system prompts.[^personas]

That study did not test Hackler-style functional controls. The cited studies do not prove that functional specialization always wins. Correlated model errors can remain despite apparent diversity.[^correlated-errors]

Compare adaptive waves with a static initial batch and fixed fan-out. Stop delegation when no substantial independent task is ready.

Plancraft and WorkBench can test component skills. They do not replace local software decomposition and dependency tests.

## Reviewer cautions

A model can produce a persuasive but incorrect review rationale.[^review-study]

Fluent explanations increased reliance without an accuracy gain in the paper's visual tasks.[^persuasion]

The explanations helped its language task. The study did not test code review.

Tests, static checks, and reproducible commands give stronger evidence than self-review. These checks still depend on their coverage and correctness.

Same-family reviewers can share blind spots. Broad model studies found correlated errors within providers and architectures.[^correlated-errors]

**Role inference:** Do not use model diversity as a substitute for a Reviewer that passes local tests.

A nine-model judge panel gave much less independent evidence than its size suggested.[^apple-panels]

The panel study did not test code review.

Use fresh Reviewer context when practical. Fresh context reduces direct anchoring, but it does not guarantee independent errors.

## Orchestration cautions

Multi-agent systems can help parallel, decomposable work. They can hurt sequential or tightly coupled work.[^multi-agent-study]

**Measured result:** Communication grew faster than agent count in one tested architecture.[^multi-agent-study]

Other communication designs can behave differently. Measure tokens, latency, duplicated work, handoffs, and verification cost.

**Role inference:** Use a strong model for the Orchestrator because decomposition errors affect all children. Confirm this choice with local tests.

Do not assume that the most expensive or strongest overall model must orchestrate. Test Orchestrator and Worker strength separately.

Delegate only independent work with clear ownership, deliverables, acceptance criteria, and stop conditions. Keep dependent work sequential until its inputs are ready.

Prefer sparse task-specific communication. Recompute the ready frontier after each wave instead of filling every slot.

Use [ORCHESTRATION_EVALUATION.md](ORCHESTRATION_EVALUATION.md) for the matched five-policy comparison across four task strata. That guide defines runtime trace use, private local gates, and future-profile admission.

## Run a local evaluation

Use this procedure for one profile at a time:

1. Freeze the prompt, tools, repository revision, task context, budgets, and grader.
2. Select representative tasks for one profile.
3. Run paired model and effort conditions on the same tasks.
4. As a local screening rule, run each condition at least five times.
5. Randomize the condition order.
6. Measure task success, evidence quality, false positives, latency, tokens, quota use, and tool calls.
7. Prefer deterministic tests or blinded human review over an LLM judge.
8. Increase the repetitions when results are close or variable.
9. Record the model snapshot, provider, harness version, and evaluation date.
10. Run the evaluation again after a material runtime change.

Five repetitions are a local heuristic, not an evidence-based adequacy threshold.

Keep paired task-level results and report uncertainty when you compare close conditions.[^paired-evals] Use a power analysis for consequential decisions.

Keep private local task distributions out of the repository. Continuous integration must use deterministic fixtures, not paid live-provider runs.

Use pass criteria before you inspect model names. Include severe failures even when the average score is high.

## Record the result

Record at least these fields:

| Area | Fields |
| --- | --- |
| Task | Profile, task-set version, repository revision, and hidden-holdout status |
| Runtime | Prompt hash, tools, capabilities, harness version, limits, and retry policy |
| Model | Provider, immutable model snapshot, model tier, thinking effort, and access date |
| Outcome | Pass or fail, evidence score, false positives, false negatives, and severe failures |
| Resources | Wall time, tokens, quota use, tool calls, retries, and reported cost |
| Review | Grader type, reviewer identity or blinding method, evaluation date, and uncertainty |

Keep current price and quota data with the evaluation record. Provider pages change too often for fixed values in this guide.[^openai-pricing]

## Re-evaluate the preset

Review each provider-specific preset at least every 90 days.

Run the evaluation again after any major change to:

- a model or model snapshot
- a provider or authentication path
- pricing, quota, or rate limits
- context size or context handling
- the agent harness, prompt, tools, or permissions
- repository languages, tests, or task mix
- a benchmark version or grader

Keep old results for comparison. Do not overwrite the model snapshot, harness version, or evaluation date.

## Schema v2 template

Replace every angle-bracket model ID before you use this template. Keep `inherit` when a custom profile must use its parent model or effort.

```json
{
  "schemaVersion": 2,
  "runtime": {
    "maxActive": 4,
    "maxSharedWriters": 1,
    "maxDepth": 2
  },
  "retention": {
    "days": 30,
    "entries": 200
  },
  "models": {
    "default": {
      "model": "inherit",
      "thinking": "inherit"
    },
    "overrides": {
      "scout": {
        "model": "<provider>/<scout-model>",
        "thinking": "inherit"
      },
      "researcher": {
        "model": "<provider>/<researcher-model>",
        "thinking": "inherit"
      },
      "worker": {
        "model": "<provider>/<worker-model>",
        "thinking": "inherit"
      },
      "reviewer": {
        "model": "<provider>/<reviewer-model>",
        "thinking": "inherit"
      },
      "oracle": {
        "model": "<provider>/<oracle-model>",
        "thinking": "inherit"
      },
      "orchestrator": {
        "model": "<provider>/<orchestrator-model>",
        "thinking": "inherit"
      },
      "plan-reviewer": {
        "model": "<provider>/<plan-reviewer-model>",
        "thinking": "inherit"
      }
    }
  },
  "capabilities": {},
  "runners": {},
  "herdr": {
    "direction": "right",
    "maxOutputBytes": 1000000
  },
  "profiles": {}
}
```

Hackler accepts `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, and `inherit` as thinking values.

## Source notes

The source list favors primary, peer-reviewed, and official methodology pages. Some 2026 benchmark papers remain preprints.

Provider and commercial sources can describe interfaces or benchmark methods. They do not establish universal model rankings.

- NIST AI RMF gives general evaluation guidance, not a model-selection recipe.[^nist]
- The paired-evaluation article gives statistical guidance, but it does not establish benchmark validity.[^paired-evals]
- SWE-Explore and DeepSWE were preprints on the review date.[^swe-explore][^deepswe]
- DeepSWE freshness depends on the model-training and benchmark-release dates.[^deepswe]
- BrowseComp is provider-authored and grades short factual answers.[^browsecomp]
- The Coding Agent Index is commercial and can change its components.[^coding-index]
- Terminal-Bench 2.1 corrected tasks from the cited 2.0 paper.[^terminal-bench-2-1]
- The seeded review benchmark uses algorithmic programs, not production pull requests.[^review-study]
- Plancraft uses a game-planning domain. Its official repository reports a fixed environment bug.[^plancraft-fix]
- The persuasion study found task-dependent effects outside code review.[^persuasion]
- WorkBench uses a synthetic workplace sandbox.[^workbench]
- Multi-agent results remain domain-dependent.[^multi-agent-study][^agent-scaling]
- We reviewed a July 2026 public model snapshot only as shortlist evidence.[^aa-model-snapshot]

[^nist]: [NIST AI Risk Management Framework 1.0](https://doi.org/10.6028/NIST.AI.100-1), January 26, 2023.
[^paired-evals]: [Adding Error Bars to Evals](https://www.anthropic.com/research/statistical-approach-to-model-evals), November 19, 2024.
[^openai-model-guide]: [OpenAI API model guidance](https://developers.openai.com/api/docs/guides/latest-model), accessed August 21, 2026.
[^openai-builders]: [The builder's guide to GPT-5.6](https://openai.com/index/builders-guide-to-gpt-5-6/), August 13, 2026.
[^openai-pricing]: [OpenAI API pricing](https://openai.com/api/pricing/), accessed August 21, 2026. This is one example of volatile provider data.
[^swe-explore]: [SWE-Explore: Benchmarking How Coding Agents Explore Repositories](https://arxiv.org/abs/2606.07297), June 5, 2026.
[^browsecomp]: [BrowseComp: a benchmark for browsing agents](https://openai.com/index/browsecomp/), April 10, 2025.
[^scholarqa]: [Synthesizing scientific literature with retrieval-augmented language models](https://doi.org/10.1038/s41586-025-10072-4), Nature, February 4, 2026.
[^coding-index]: [Coding Agent Index Methodology, version 1.3](https://artificialanalysis.ai/methodology/coding-agents-benchmarking), July 2026.
[^terminal-bench]: [Terminal-Bench: Benchmarking Agents on Hard, Realistic Tasks in Command Line Interfaces](https://arxiv.org/abs/2601.11868), ICLR 2026.
[^terminal-bench-2-1]: [Terminal-Bench 2.1 official repository](https://github.com/harbor-framework/terminal-bench-2-1), accessed August 21, 2026.
[^deepswe]: [DeepSWE: Measuring Frontier Coding Agents on Original, Long-Horizon Engineering Tasks](https://arxiv.org/abs/2607.07946), July 8, 2026.
[^swe-live]: [SWE-bench Goes Live!](https://papers.nips.cc/paper_files/paper/2025/hash/d83c4a745789690f82e86d0ef752ae7c-Abstract-Datasets_and_Benchmarks_Track.html), NeurIPS 2025.
[^review-study]: [Are LLMs reliable code reviewers?](https://doi.org/10.1007/s10515-026-00638-5), Automated Software Engineering, June 26, 2026.
[^persuasion]: [The Persuasion Paradox](https://arxiv.org/abs/2604.03237), 2026 preprint.
[^personas]: [When “A Helpful Assistant” Is Not Really Helpful: Personas in System Prompts Do Not Improve Performances of Large Language Models](https://aclanthology.org/2024.findings-emnlp.888/), Findings of EMNLP 2024, November 2024.
[^correlated-errors]: [Correlated Errors in Large Language Models](https://proceedings.mlr.press/v267/kim25e.html), ICML 2025.
[^apple-panels]: [Nine Judges, Two Effective Votes](https://doi.org/10.48550/arXiv.2605.29800), May 28, 2026 preprint.
[^plancraft]: [Plancraft: an evaluation dataset for planning with LLM agents](https://openreview.net/pdf?id=nSV8Depcpx), COLM 2025.
[^plancraft-fix]: [Plancraft official repository correction notice](https://github.com/gautierdag/plancraft), accessed August 21, 2026.
[^icaps-planning]: [Chasing Progress, Not Perfection](https://doi.org/10.1609/icaps.v35i1.36119), ICAPS 2025.
[^helmet]: [HELMET: How to Evaluate Long-context Models Effectively and Thoroughly](https://proceedings.iclr.cc/paper_files/paper/2025/hash/f5332c8273d02729730a9c24dec2135e-Abstract-Conference.html), ICLR 2025.
[^contradoc]: [ContraDoc: Understanding Self-Contradictions in Documents with Large Language Models](https://aclanthology.org/2024.naacl-long.362/), NAACL 2024.
[^calibration]: [How Can We Know When Language Models Know?](https://doi.org/10.1162/tacl_a_00407), TACL 2021.
[^workbench]: [WorkBench: a Benchmark Dataset for Agents in a Realistic Workplace Setting](https://arxiv.org/abs/2405.00823), COLM 2024.
[^multi-agent-study]: [Capable language models can outgrow the benefits of collaboration](https://doi.org/10.1038/s42256-026-01268-y), Nature Machine Intelligence, July 24, 2026.
[^agent-scaling]: [Benchmark Test-Time Scaling of General LLM Agents](https://arxiv.org/abs/2602.18998), February 22, 2026 preprint.
[^aa-model-snapshot]: [GPT-5.6 benchmarks across Intelligence, Speed and Cost](https://artificialanalysis.ai/articles/gpt-5-6-has-landed), July 9, 2026.
