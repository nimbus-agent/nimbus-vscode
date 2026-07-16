# scripts/

Build/maintenance helpers invoked via `package.json` scripts. Plain Node ESM
(`.mjs`), no dependencies beyond the Node standard library — they run under both
`node` and `bun`.

| Script | npm script | What it does |
| --- | --- | --- |
| `clean.mjs` | `bun run clean` | Remove build artifacts (`dist/`, `media/webview.*`). |
| `check-bundle.mjs` | `bun run check-bundle` | Assert both bundles (`dist/extension.js`, `media/webview.js`) exist and the extension bundle keeps `vscode` as its only external require — i.e. `@nimbus-dev/client` and all other deps are inlined, so the `.vsix` has no runtime npm dependency. Run after `bun run build`; CI runs it too. |
| `check-settings-docs.mjs` | `bun run check-settings-docs` | Assert every `nimbus.*` configuration setting in `package.json` is documented in `docs/settings.md` and the README settings table. Prevents settings-doc drift; CI runs it too. |

See [`docs/architecture.md`](../docs/architecture.md) for why the bundling
invariant that `check-bundle.mjs` guards is load-bearing.
