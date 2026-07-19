# scripts/

Build/maintenance helpers invoked via `package.json` scripts. Plain Node ESM
(`.mjs`) — they run under both `node` and `bun`. They use only the Node standard
library, except `check-vsix-contents.mjs`, which reuses the `@vscode/vsce`
devDependency so it asks the packager itself what would ship rather than
re-implementing `.vscodeignore` resolution.

| Script | npm script | What it does |
| --- | --- | --- |
| `clean.mjs` | `bun run clean` | Remove build artifacts (`dist/`, `media/webview.*`). |
| `check-bundle.mjs` | `bun run check-bundle` | Assert both bundles (`dist/extension.js`, `media/webview.js`) exist and the extension bundle keeps `vscode` as its only external require — i.e. `@nimbus-dev/client` and all other deps are inlined, so the `.vsix` has no runtime npm dependency. Run after `bun run build`; CI runs it too. |
| `check-vsix-contents.mjs` | `bun run check-vsix-contents` | Assert the `.vsix` contains only the bundles, runtime assets and marketplace docs — an allowlist, so a new top-level directory cannot silently ship. Complements the allowlist form of `.vscodeignore`. Run after `bun run build`; CI runs it too. |
| `check-settings-docs.mjs` | `bun run check-settings-docs` | Assert every `nimbus.*` configuration setting in `package.json` is documented in `docs/settings.md` and the README settings table. Prevents settings-doc drift; CI runs it too. |

See [`docs/architecture.md`](../docs/architecture.md) for why the bundling
invariant that `check-bundle.mjs` guards is load-bearing.
