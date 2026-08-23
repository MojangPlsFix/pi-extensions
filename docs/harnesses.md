# Harness reference catalog

Last reviewed: **2026-08-23**.

This catalog defines reference tiers for feature work. A listing is not an endorsement or evidence that a design works here.

## Tier meanings

- **Implementation authority:** Use this source for supported APIs and runtime behavior. External harnesses cannot override it.
- **Core reference:** Screen every entry for each substantive feature. Compare all three entries and record relevance.
- **Task-specific reference:** Screen an entry when the feature directly matches its listed areas.
- **Optional reference:** Use an entry only when it can answer a named design question.

A relevance screen can conclude that a source is irrelevant or unavailable. Do not force an unsuitable precedent.

Deeply inspect at least one relevant harness when a relevant precedent exists. Pin a release, tag, or commit before detailed source study.

The license links below show the state verified on the review date. Recheck the license at the pinned revision before copying or adaptation.

## Implementation authority

### [Pi](https://github.com/earendil-works/pi)

- **License:** [MIT](https://github.com/earendil-works/pi/blob/main/LICENSE).
- **Inspect for:** Supported extension APIs, runtime behavior, context loading, sessions, providers, tools, packages, TUI, and examples.
- **Caveats:** The installed target version controls compatibility. The default branch can differ from that version.
- **Study rule:** Pin the target release, tag, or commit before detailed source study.
- **Verified:** 2026-08-23.

## Core references — mandatory relevance screening

### [OpenCode](https://github.com/anomalyco/opencode)

- **License:** [MIT](https://github.com/anomalyco/opencode/blob/dev/LICENSE).
- **Inspect for:** Client-server boundaries, tool execution, context, permissions, sessions, orchestration, provider behavior, and terminal UX.
- **Caveats:** The default branch is `dev`. The name OpenCode also identifies unrelated projects.
- **Study rule:** Pin a release, tag, or commit before detailed source study.
- **Verified:** 2026-08-23.

### [OpenAI Codex](https://github.com/openai/codex)

- **License:** [Apache-2.0](https://github.com/openai/codex/blob/main/LICENSE).
- **Inspect for:** Tool policy, sandboxing, approvals, context discovery, sessions, compaction, provider integration, orchestration, and terminal UX.
- **Caveats:** The repository covers the open-source CLI. It does not define every hosted Codex service behavior.
- **Study rule:** Pin a release, tag, or commit before detailed source study.
- **Verified:** 2026-08-23.

### [oh-my-pi](https://github.com/can1357/oh-my-pi)

- **License:** [MIT](https://github.com/can1357/oh-my-pi/blob/main/LICENSE).
- **Inspect for:** Pi-derived architecture, tools, context assembly, providers, sessions, orchestration, performance work, and TUI experiments.
- **Caveats:** It can diverge from Pi and contains separately licensed third-party material. Similar repository names identify forks.
- **Study rule:** Pin a release, tag, or commit before detailed source study.
- **Verified:** 2026-08-23.

## Task-specific references — use when directly relevant

### [Gemini CLI](https://github.com/google-gemini/gemini-cli)

- **License:** [Apache-2.0](https://github.com/google-gemini/gemini-cli/blob/main/LICENSE).
- **Inspect for:** Tooling, context files, extensions, sandboxing, approval policy, provider integration, and terminal UX.
- **Caveats:** Hosted Google services have separate terms. Distinguish experimental features from released behavior.
- **Study rule:** Pin a release, tag, or commit before detailed source study.
- **Verified:** 2026-08-23.

### [goose](https://github.com/aaif-goose/goose)

- **License:** Code and specifications use [Apache-2.0](https://github.com/aaif-goose/goose/blob/main/LICENSE).
- **Inspect for:** Agent architecture, extension protocols, tools, recipes, providers, orchestration, and desktop or terminal UX.
- **Caveats:** Most documentation uses CC BY 4.0. Governance permits approved license exceptions.
- **Study rule:** Pin a release, tag, or commit before detailed source study.
- **Verified:** 2026-08-23.

### [OpenHands Software Agent SDK](https://github.com/OpenHands/software-agent-sdk)

- **License:** [MIT](https://github.com/OpenHands/software-agent-sdk/blob/main/LICENSE).
- **Inspect for:** Agent events, tool interfaces, workspaces, sandbox boundaries, delegation, evaluation hooks, and SDK integration.
- **Caveats:** This SDK differs from the OpenHands application and CLI repositories. Check API stability at the pinned revision.
- **Study rule:** Pin a release, tag, or commit before detailed source study.
- **Verified:** 2026-08-23.

### [Cline](https://github.com/cline/cline)

- **License:** [Apache-2.0](https://github.com/cline/cline/blob/main/LICENSE).
- **Inspect for:** Editor UX, approvals, checkpoints, tool use, context selection, provider configuration, and extension protocols.
- **Caveats:** The JetBrains plugin is not open source. Do not treat unavailable components as covered by this repository license.
- **Study rule:** Pin a release, tag, or commit before detailed source study.
- **Verified:** 2026-08-23.

### [mini-swe-agent](https://github.com/SWE-agent/mini-swe-agent)

- **License:** [MIT](https://github.com/SWE-agent/mini-swe-agent/blob/main/LICENSE.md).
- **Inspect for:** Minimal agent loops, environment and tool interfaces, prompt design, trajectories, benchmark integration, and evaluation.
- **Caveats:** The default branch contains version 2. Version 1 remains on a separate branch.
- **Study rule:** Pin a release, tag, or commit before detailed source study.
- **Verified:** 2026-08-23.

## Optional references — candidates, not requirements or endorsements

### [Aider](https://github.com/Aider-AI/aider)

- **License:** [Apache-2.0](https://github.com/Aider-AI/aider/blob/main/LICENSE.txt).
- **Inspect for:** Repository maps, edit formats, git workflows, context selection, prompting, model evaluation, and terminal UX.
- **Caveats:** Provider and model behavior changes quickly. Separate measured results from project claims.
- **Study rule:** Pin a release, tag, or commit before detailed source study.
- **Verified:** 2026-08-23.

### [SWE-agent](https://github.com/SWE-agent/SWE-agent)

- **License:** [MIT](https://github.com/SWE-agent/SWE-agent/blob/main/LICENSE).
- **Inspect for:** Agent-computer interfaces, tools, trajectories, environment design, benchmark tasks, and evaluation methods.
- **Caveats:** The project directs most current development to mini-swe-agent. Historical results depend on pinned harness versions.
- **Study rule:** Pin a release, tag, or commit before detailed source study.
- **Verified:** 2026-08-23.

### [Continue](https://github.com/continuedev/continue)

- **License:** [Apache-2.0](https://github.com/continuedev/continue/blob/main/LICENSE).
- **Inspect for:** IDE UX, context providers, model configuration, tools, workflows, and extension architecture.
- **Caveats:** The repository is read-only and no longer actively maintained. Treat it as a historical reference.
- **Study rule:** Pin release 2.0.0 or another tag or commit before detailed source study.
- **Verified:** 2026-08-23.

## Interoperability warnings

- `AGENTS.md` is a convention, not a uniform loading protocol.
- Discovery, precedence, refresh behavior, and size limits vary by harness.
- Markdown links do not guarantee automatic loading.
- Explicitly direct an unsupported harness to [`AGENTS.md`](../AGENTS.md).
- Unknown licensing blocks copying or adaptation. It does not block conceptual comparison.
- A repository license does not replace hosted-service terms or third-party licenses.
