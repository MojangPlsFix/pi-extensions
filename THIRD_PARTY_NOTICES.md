# Third-party notices

The projects below were used as references or inspiration. Their inclusion does not imply endorsement, and no source is claimed as copied or substantially adapted unless explicitly stated.

## OpenAI Codex Plan Mode

- Reference: <https://github.com/openai/codex/commit/578c1b2230288104041e880a86d0f7f3a5ca6e47>
- License: [Apache License 2.0](https://github.com/openai/codex/blob/main/LICENSE)
- Relationship: The Plan Mode workflow was inspired by this implementation and adapted to Pi's extension APIs.

## OpenAI Codex Native Search

- Reference commit: <https://github.com/openai/codex/commit/1e85ca099e4265bf89f4016772d299816e231bb3>
- Pinned source references: [search request/response types](https://github.com/openai/codex/blob/1e85ca099e4265bf89f4016772d299816e231bb3/codex-rs/codex-api/src/search.rs) and [search endpoint](https://github.com/openai/codex/blob/1e85ca099e4265bf89f4016772d299816e231bb3/codex-rs/codex-api/src/endpoint/search.rs)
- License: [Apache License 2.0](https://github.com/openai/codex/blob/main/LICENSE)
- Relationship: The Web Search extension's native `/codex/alpha/search` request and response handling was informed by the OpenAI Codex implementation and adapted independently to Pi's extension and OAuth APIs.

## OpenAI Codex Usage Meter

- Reference commit: <https://github.com/openai/codex/commit/2b5bdcf67547860f2e5c5a605009a70026796b2b>
- License: [Apache License 2.0](https://github.com/openai/codex/blob/main/LICENSE)
- Relationship: The Usage Meter extension's direct ChatGPT quota request and rate-limit parsing were informed by the OpenAI Codex implementation and adapted independently to Pi's extension and OAuth APIs.

## Codex Native Compaction Extension

- Reference commit: <https://github.com/ogulcancelik/pi-extensions/commit/ca37adb6c8000f6a83c447b4a119657c7714bc94>
- Pinned source: [pi-codex-compaction](https://github.com/ogulcancelik/pi-extensions/tree/ca37adb6c8000f6a83c447b4a119657c7714bc94/packages/pi-codex-compaction)
- License: [MIT](https://github.com/ogulcancelik/pi-extensions/blob/ca37adb6c8000f6a83c447b4a119657c7714bc94/packages/pi-codex-compaction/LICENSE)
- Copyright: 2025 Can Celik
- Relationship: The Codex Compaction extension adapts this implementation to this package and Pi 0.84 APIs.

## STE Writing Skill

- Sources: [ste-writing-skill.md](https://raw.githubusercontent.com/woosal1337/blog/main/videos/ep01-the-cure-for-ai-slop/ste-writing-skill.md) and [ste-lint.py](https://raw.githubusercontent.com/woosal1337/blog/main/videos/ep01-the-cure-for-ai-slop/ste-lint.py)
- License: Not specified by the source repository.
- Relationship: The skill and optional documentation linter were included at the user's request.

## Pi Skills

- Repository: <https://github.com/badlogic/pi-skills>
- License: [MIT](https://github.com/badlogic/pi-skills/blob/main/LICENSE)
- Copyright: 2024 Mario Zechner
- Relationship: Reference and inspiration for Pi skill organization and conventions.

## Agent Stuff

- Repository: <https://github.com/mitsuhiko/agent-stuff>
- License: [Apache License 2.0](https://github.com/mitsuhiko/agent-stuff/blob/main/LICENSE)
- Relationship: Reference and inspiration for Pi package, extension, skill, and repository organization.

## pi-extensions by Can Celik

- Repository: <https://github.com/ogulcancelik/pi-extensions>
- License: [MIT](https://github.com/ogulcancelik/pi-extensions/blob/main/LICENSE)
- Copyright: 2025 Can Celik
- Relationship: Reference and inspiration for modular feature/package organization and Pi extension implementations.

## Pi

- Repository: <https://github.com/earendil-works/pi>
- License: [MIT](https://github.com/earendil-works/pi/blob/main/LICENSE)
- Copyright: 2025 Mario Zechner
- Relationship: Runtime platform and primary reference for extension APIs, package structure, examples, and conventions. Pi supplies the runtime peer dependencies; this repository does not redistribute Pi source.
