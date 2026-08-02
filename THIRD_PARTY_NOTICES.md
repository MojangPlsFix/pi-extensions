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
- Relationship: The provider-aware Search extension's native `/codex/alpha/search` request and response handling was informed by the OpenAI Codex implementation and adapted independently to Pi's extension and OAuth APIs.

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
