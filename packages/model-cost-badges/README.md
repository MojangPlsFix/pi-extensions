# Model Cost Badges

Model Cost Badges adds an `API cost / 1M` panel to Pi's model selector. The panel shows base and long-context input, cache-read, cache-write, and output prices for the currently selected model.

## Supported Pi layouts

The extension follows Pi's real Node CLI path, including a symlinked `pi` launcher, and recognizes these layouts:

- **Modular Node build:** `dist/cli.js` with the selector at `dist/modes/interactive/components/model-selector.js`.
- **Bundled Node build:** `dist/bundle/cli.js` with the selector class re-exported by `dist/bundle/index.js`. The CLI and bundle index use the same generated module. The patch reaches the selector used by Pi.

The resolver does not import Bun, experimental, or standalone entrypoints. If the CLI or selector module is missing, moved, unreadable, or fails to import, the extension leaves badges disabled without a notification.

## Compatibility and limitations

The extension patches Pi's selector component at runtime. Pi does not provide a stable public extension hook for this component. The component is an internal detail and may change between Pi releases. The resolver supports only the verified Node layouts above.

The panel keeps the selector's normal output. It skips side-by-side output when the terminal is too narrow. Shared symbols mark the patch. Repeated initialization does not wrap the selector prototype again.

Prices come from the selected model's Pi model definition. The panel is informational and does not calculate session billing or make provider requests.
