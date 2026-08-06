# Development

## Prerequisites

- Node.js 22 or newer
- A current Pi installation for runtime checks

Install development tools with `npm install`. Pi supplies peer dependencies at run time. This package has no runtime dependencies and no install lifecycle scripts.

## Commands

```bash
npm run typecheck
npm run lint
npm test
npm run validate:package
npm run check
```

`validate:package` checks the explicit Pi manifest, entrypoint shape, and install-safety rules.

## Local runtime check

Use an isolated Pi configuration directory. This prevents local tests from changing normal settings:

```bash
PI_CONFIG_DIR="$(mktemp -d)" pi install "$(pwd)"
PI_CONFIG_DIR="$PI_CONFIG_DIR" pi
```

Test `/reload`, a non-Copilot model, provider switching when configured, `/plan`, `/plan off`, plan implementation, and `/agents` without optional tools.
