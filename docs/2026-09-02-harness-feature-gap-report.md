# Harness Feature-Gap Research Report

- **Research date:** 2026-09-02
- **Status:** Decision support. No candidate has approval for implementation.
- **Installed Pi target:** `@earendil-works/pi-coding-agent` 0.84.0
- **Previous dated report:** None

## Scope

This report identifies useful coding-harness features that this repository lacks. It applies these exclusions:

- No sandbox or virtual-machine feature.
- No new model provider or vendor.
- No new paid API, search service, or hosted dependency.
- No duplicate of a feature already supplied by Pi or this repository.

The report ranks feature gaps. It does not claim that common use proves effectiveness.

## Method

The research used the workflow in [development.md](development.md) and the reference catalog in [harnesses.md](harnesses.md).

The review had five stages:

1. Inspect the local extension manifest, feature documentation, tests, and installed Pi package.
2. Screen Pi as the implementation authority.
3. Screen OpenCode, OpenAI Codex, and oh-my-pi as core references.
4. Screen Cline and Gemini CLI only for directly relevant candidates.
5. Check applicable peer-reviewed evidence and separate association from tested intervention.

Detailed source review used pinned releases or commits. Proposals and issue-only behavior did not count as released features. Two focused query variants found no later evidence that changed the final ranking.

The ranking is ordinal. It weighs these factors:

- released use across harnesses
- confirmed local gap
- Pi 0.84 feasibility
- dependency and operating cost
- failure and rollback risk
- direct evidence quality

## Version pins

| Reference | Pinned revision |
| --- | --- |
| Pi | Installed package 0.84.0 |
| OpenCode | `v1.18.18`, `31406ccc51b4bd2a4e1e086b2bcaa5f7f804f26d` |
| OpenAI Codex CLI | `rust-v0.144.4`, `8c68d4c87dc54d38861f5114e920c3de2efa5876` |
| oh-my-pi | `v15.5.7`, `b87cd8f93f520f35f199122c2a7a28c7676961be` |
| Cline | `v3.85.0`, `9ee618111d58630fea30b27439216448225458e0` |
| Gemini CLI | `v0.58.0`, `ac9431c9e2290d68af31a77614ff2fddb2391ca3` |

## Current local coverage

This repository already has strong workflow controls. The relevant partial overlaps are:

- [Plan Mode](../packages/plan-mode/README.md) controls tools while Plan Mode is active.
- [Hackler](../packages/subagents/README.md) controls child capabilities and approvals.
- Hackler has `reviewer` and hidden `plan-reviewer` profiles.
- Plan Mode has `/plan-review`, which reviews plans rather than code changes.
- Pi stores session trees and supports resume, fork, and tree navigation.
- Pi has JSON and RPC modes for noninteractive use.
- Pi bounds built-in tool output to 2,000 lines or 50 KiB.
- The current web-search package already uses configured provider routes.

The repository has no unified policy for ordinary parent-session tool calls. It also lacks a general code-review command, a repeated-call warning, post-edit diagnostics, and ordinary workspace restoration.

## Ranked result

| Rank | Candidate | Released precedent | Local gap | Cost | Confidence |
| ---: | --- | --- | --- | --- | --- |
| 1 | Normal-session tool policy | All three core harnesses, plus Gemini CLI | Material partial gap | Pi and Node only | High |
| 2 | General code-review workflow | All three core harnesses | Narrow but useful gap | Git and current model quota | High |
| 3 | Exact repeated-call warning | OpenCode, Cline, and Gemini CLI | Confirmed gap | Pi and Node only | Medium |
| 4 | Post-edit diagnostics | OpenCode, oh-my-pi, and Cline | Confirmed gap | Local servers and optional transport package | Medium |
| 5 | Git-aware checkpoint safety | OpenCode, Cline, and Gemini CLI | Confirmed gap | Git and local disk | Medium-low |

Ranks three and four are close. Diagnostics have stronger core-harness use. Repeated-call warnings have lower cost and fewer lifecycle requirements.

## 1. Normal-session tool policy

### Finding

This is the strongest common-harness gap. All three core references have non-sandbox tool approval controls.

- [OpenCode permissions](https://github.com/anomalyco/opencode/blob/31406ccc51b4bd2a4e1e086b2bcaa5f7f804f26d/packages/opencode/src/permission/index.ts) use ordered `allow`, `ask`, and `deny` rules.
- [Codex execution policy](https://github.com/openai/codex/blob/8c68d4c87dc54d38861f5114e920c3de2efa5876/codex-rs/core/src/exec_policy.rs) combines approval posture with command-prefix rules.
- [oh-my-pi approvals](https://github.com/can1357/oh-my-pi/blob/b87cd8f93f520f35f199122c2a7a28c7676961be/packages/coding-agent/src/tools/approval.ts) use read, write, and execute tiers with per-tool rules.
- [Gemini CLI policy](https://github.com/google-gemini/gemini-cli/blob/ac9431c9e2290d68af31a77614ff2fddb2391ca3/docs/reference/policy-engine.md) adds stable argument matching and headless denial.

Only OpenCode has a general path-resource policy among the three core references. Gemini CLI adds task-specific, tool-dependent path rules. Codex protected paths mainly belong to its sandbox and do not count here.

The harness defaults differ. The pinned oh-my-pi release defaults to its permissive `yolo` mode. Common presence does not imply a common safe default.

### Local gap

Plan Mode and Hackler already have scoped policy systems. Neither system governs all ordinary parent-session tools.

A useful feature would apply `allow`, `ask`, or `deny` before normal tool execution. It could inspect exact tool names and canonical paths from direct file tools. A prompt must become a denial when no interactive client exists.

### Cost and limits

Pi 0.84 exposes the required `tool_call` hook and local UI methods. The feature needs no model call, service, or production package.

This policy would remain an application guardrail. It would not contain an approved process. Bash scripts, aliases, custom tools, subprocesses, symlink races, and external processes can escape direct-path analysis.

A broad shell classifier could create false confidence. Any future design must state these limits next to its configuration.

## 2. General code-review workflow

### Finding

All three core harnesses have a code-review workflow.

- [OpenCode review command](https://github.com/anomalyco/opencode/blob/31406ccc51b4bd2a4e1e086b2bcaa5f7f804f26d/packages/opencode/src/command/index.ts)
- [Codex review command routing](https://github.com/openai/codex/blob/8c68d4c87dc54d38861f5114e920c3de2efa5876/codex-rs/cli/src/main.rs)
- [Codex review target resolution](https://github.com/openai/codex/blob/8c68d4c87dc54d38861f5114e920c3de2efa5876/codex-rs/prompts/src/review_request.rs)
- [oh-my-pi review command](https://github.com/can1357/oh-my-pi/blob/b87cd8f93f520f35f199122c2a7a28c7676961be/packages/coding-agent/src/extensibility/custom-commands/bundled/review/index.ts)

### Local gap

The repository already has reviewer profiles and plan review. The missing feature is a normal code-review entry point with clear Git targets.

Useful targets include uncommitted changes, a base branch, and a commit. The workflow should record the resolved commit and merge-base data before model review. This avoids an ambiguous or moving target.

The existing Hackler reviewer can handle the review task. No new reviewer implementation or provider integration is necessary.

### Cost and limits

The workflow needs Git and the current model. A separate review consumes current provider quota, even though it adds no new API.

Model findings must remain advisory. Tests and deterministic checks must take priority over a model verdict.

A 2026 code-review study found prompt-dependent false acceptance and rejection. It also found explanations that did not reliably match the underlying fault. The study covered requirement conformance without tests, not full repository review.

## 3. Exact repeated-call warning

### Finding

Released detectors exist in several references.

- [OpenCode loop check](https://github.com/anomalyco/opencode/blob/31406ccc51b4bd2a4e1e086b2bcaa5f7f804f26d/packages/opencode/src/session/processor.ts) checks three identical tool calls and inputs.
- [Cline loop detection](https://github.com/cline/cline/blob/9ee618111d58630fea30b27439216448225458e0/src/core/task/loop-detection.ts) warns at three calls and escalates at five.
- [Gemini CLI loop detection](https://github.com/google-gemini/gemini-cli/blob/ac9431c9e2290d68af31a77614ff2fddb2391ca3/packages/core/src/services/loopDetectionService.ts) checks exact calls and broader content patterns.

Cline checks after the repeated call executes. OpenCode compares raw serialized input. Gemini CLI also uses model-assisted checks, which would add cost and classification risk.

### Local gap

Ordinary Pi sessions have no exact-call detector. Hackler budgets and workflow retry limits bound some loops, but they do not detect repeated parent-session calls.

A narrow Pi feature could compare a canonical call signature and a result fingerprint. It should warn only after completed calls produce the same result. Initial use should not block or abort work.

### Evidence limits

The [ASE 2025 trajectory study](https://conf.researchr.org/details/ase-2025/ase-2025-papers/40/Understanding-Software-Engineering-Agents-A-Study-of-Thought-Action-Result-Trajector) analyzed 120 trajectories and 2,822 interactions.

Failed and successful Action-to-Action repetition rates differed:

| Agent | Successful | Failed |
| --- | ---: | ---: |
| RepairAgent | 6.1% | 13.6% |
| OpenHands | 0.5% | 3.8% |
| AutoCodeRover | 0.0% | 8.8% |

The authors recommend sequence-based repetition detection. They did not test a runtime detector, threshold, false-positive rate, token saving, or success improvement.

Intentional polling and repeated verification can look identical. A warning needs tool exemptions and correct handling for parallel calls.

## 4. Post-edit diagnostics

### Finding

Post-edit diagnostic feedback has released precedent.

- [OpenCode edit](https://github.com/anomalyco/opencode/blob/31406ccc51b4bd2a4e1e086b2bcaa5f7f804f26d/packages/opencode/src/tool/edit.ts) notifies its LSP layer and appends errors when configuration enables LSP.
- [OpenCode LSP documentation](https://github.com/anomalyco/opencode/blob/31406ccc51b4bd2a4e1e086b2bcaa5f7f804f26d/packages/web/src/content/docs/lsp.mdx) states that the default configuration disables LSP.
- [oh-my-pi settings](https://github.com/can1357/oh-my-pi/blob/b87cd8f93f520f35f199122c2a7a28c7676961be/packages/coding-agent/src/config/settings-schema.ts) enable write diagnostics by default.
- [Cline diagnostics](https://github.com/cline/cline/blob/9ee618111d58630fea30b27439216448225458e0/src/integrations/editor/DiffViewProvider.ts) compare editor errors before and after an edit.

The pinned Codex tool and configuration surfaces contain no native post-edit diagnostic feature.

### Dependency options

Every option requires user-installed local language servers.

A small Node client could use child processes and direct JSON-RPC framing. This avoids a production dependency but creates substantial protocol and lifecycle work.

A reviewed [`vscode-jsonrpc`](https://www.npmjs.com/package/vscode-jsonrpc) release could handle transport framing. It is not a complete LSP client. The repository would still own discovery, document versions, timeouts, process cleanup, and diagnostic freshness.

The feature must not download language servers automatically.

### Failure limits

A successful edit must stay successful when diagnostics fail. Results must distinguish these states:

- diagnostics received
- no configured server
- startup or server failure
- timeout
- cancellation
- stale publication

An empty result must not mean that the project is clean. Language-server output does not replace a compiler, build, test suite, or project checker.

## 5. Git-aware checkpoint safety

### Finding

Workspace restoration exists in OpenCode, Cline, and optional Gemini CLI checkpointing.

- [OpenCode snapshots](https://github.com/anomalyco/opencode/blob/31406ccc51b4bd2a4e1e086b2bcaa5f7f804f26d/packages/opencode/src/snapshot/index.ts)
- [OpenCode session revert](https://github.com/anomalyco/opencode/blob/31406ccc51b4bd2a4e1e086b2bcaa5f7f804f26d/packages/opencode/src/session/revert.ts)
- [Cline checkpoint exclusions](https://github.com/cline/cline/blob/9ee618111d58630fea30b27439216448225458e0/src/integrations/checkpoints/CheckpointExclusions.ts)
- [Gemini CLI checkpointing](https://github.com/google-gemini/gemini-cli/blob/ac9431c9e2290d68af31a77614ff2fddb2391ca3/docs/cli/checkpointing.md)

Codex conversation forks do not restore files. The pinned oh-my-pi checkpoint and rewind tools change conversation state only. Their live checkpoint guard does not survive a process restart.

### Local gap

Pi conversation branches share the current physical workspace. A fork at an old message does not restore the files from that point.

### Cost and limits

A checkpoint feature can use system Git and local disk. It needs no hosted service.

Restoration has the highest failure risk in this ranking. Shadow repositories do not capture all state. Common exclusions include ignored files, environment files, media, build output, archives, databases, and large files.

Cline does not support multi-root checkpoint restoration. No reviewed harness can reverse processes, network calls, databases, services, or writes outside its captured workspace.

Conversation and filesystem changes also lack one shared transaction in Pi. A safe design should show a restore preview and refuse ambiguous state. It should not advertise complete undo.

## Applicable research evidence

### Agent trajectories

Bouzenia and Pradel studied 120 software-agent trajectories with 2,822 interactions. Failed trajectories had more manually labeled repeated actions for all three agents.

This is an observed association. The study did not test a loop detector intervention.

Sources:

- [ASE 2025 program entry](https://conf.researchr.org/details/ase-2025/ase-2025-papers/40/Understanding-Software-Engineering-Agents-A-Study-of-Thought-Action-Result-Trajector)
- [Author-hosted paper](https://software-lab.org/publications/ase2025_trajectories.pdf)

### Agent-authored pull requests

The [MSR 2026 study](https://2026.msrconf.org/details/msr-2026-mining-challenge/19/Where-Do-AI-Coding-Agents-Fail-An-Empirical-Study-of-Failed-Agentic-Pull-Requests-in) examined 33,000 agent-authored pull requests from five agents. The authors also reviewed a sample of 600 pull requests.

Non-merged pull requests tended to change more files and fail continuous integration more often. The qualitative sample also found duplicates, unwanted features, weak reviewer engagement, and task misalignment.

The study supports careful target selection and deterministic validation. It does not show that a model review command improves merge rates.

### Model code review

The [Automated Software Engineering study](https://link.springer.com/article/10.1007/s10515-026-00638-5) tested five models across three requirement-conformance benchmarks without tests.

The study found systematic over-rejection under some prompt designs. It also found explanations with weak cause-level grounding.

These results support an advisory review role. They do not measure the proposed workflow or full repository diffs.

## Candidates not advanced

### Deferred tool loading

Pi 0.84 supports dynamic activation. The local Codex compaction package also preserves some deferred-tool history.

No local measurement shows that tool schemas cause a material context or latency problem. Active-tool changes would also need coordination with Plan Mode. This candidate needs a baseline before implementation.

### Output spill and truncation

Pi already bounds built-in tool output. Bash can retain full output in a temporary file. This is not a local gap.

### Machine-readable execution

Pi already has JSON event output and RPC mode. A second execution protocol would duplicate core behavior.

### Session resume and fork

Pi already stores branchable JSONL sessions. A conversation branch is not a workspace checkpoint, which is why checkpoint safety remains ranked separately.

### Search and provider features

The repository already has provider-routed search. New paid search services and provider integrations are outside this report.

## Recommendation

The normal-session tool policy is the best next candidate. It has the broadest released precedent and the lowest dependency cost.

The code-review workflow is the best productivity-oriented alternative. It can reuse the existing reviewer machinery, but it consumes model quota.

The repeated-call warning is suitable for a small measured experiment. Default blocking lacks supporting detector evidence.

Post-edit diagnostics need more lifecycle work. Checkpoint restoration needs the strongest refusal and recovery rules.

## Revalidation triggers

Repeat this research when one of these conditions occurs:

- Pi changes its tool, session, or skill APIs.
- A core harness changes a ranked feature materially.
- This repository adds or removes a related extension.
- A candidate gets selected for implementation.
- Twelve months pass without a new report.

Do not reuse old defaults, prices, release states, or issue status without a new check.

## Repeat this research

This repository includes a manual project skill:

```text
/skill:harness-feature-gap-research
```

Find the skill at [`.agents/skills/harness-feature-gap-research/SKILL.md`](../.agents/skills/harness-feature-gap-research/SKILL.md). It writes future reports as `docs/YYYY-MM-DD-harness-feature-gap-report.md`.

If a same-date report exists, the workflow asks before replacing it. A new report compares its findings with the newest prior report.

## Research limits

The research used static source, documentation, tests, and external primary sources. It did not run the external harness binaries or a live language server.

Source presence does not prove default activation. Released adoption does not prove safety, productivity, reliability, or lower cost.

Search-based absence is not universal proof of absence. Each negative finding applies only to the pinned source surfaces that the research inspected.
