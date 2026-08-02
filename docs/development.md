# Development

## Prerequisites

- Node.js 22+
- A current Pi installation for runtime checks

Install development-only tooling with `npm install`. Pi packages are peers because Pi provides them at runtime; this package has no runtime dependencies and no lifecycle install scripts.

## Commands

```bash
npm run typecheck
npm run lint
npm test
npm run validate:package
npm run check
```

`validate:package` verifies the explicit Pi manifest, entrypoint shape, and install-safety constraints.

## Local runtime check

Use an isolated Pi configuration directory so local testing cannot modify normal settings:

```bash
PI_CONFIG_DIR="$(mktemp -d)" pi install "$(pwd)"
PI_CONFIG_DIR="$PI_CONFIG_DIR" pi
```

Test `/reload`, a non-Copilot model, provider switching where configured, `/plan`, `/plan off`, plan implementation, and `/agents` without optional tools installed.
