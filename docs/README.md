# Nimbus VS Code — Documentation

Reference docs for the `nimbus-vscode` extension. For a high-level overview see
the top-level [README](../README.md); for the contributor quickstart see
[CONTRIBUTING](../CONTRIBUTING.md).

| Doc | For | Covers |
| --- | --- | --- |
| [architecture.md](./architecture.md) | Contributors | The IPC-only seam, the esbuild bundling model and why it's load-bearing, the Webview boundary, and the `vscode-shim` test seam. |
| [development.md](./development.md) | Contributors | Clone → build → run in an Extension Development Host (F5), watch mode, debugging, and how the test suite stubs `vscode`. |
| [settings.md](./settings.md) | Users & contributors | Every `nimbus.*` setting, its default, and when to change it. |
| [releasing.md](./releasing.md) | Maintainers | The tag-driven publish flow, required secrets, and how to recover a failed release. |
| [ROADMAP.md](./ROADMAP.md) | Contributors & maintainers | Where the extension is going, phased by SDK-readiness: what's buildable on the existing `@nimbus-dev/client` vs. what's gated on new Gateway/client RPCs. |

> These docs expand on the load-bearing notes in [CLAUDE.md](../CLAUDE.md) rather
> than duplicating them. When a fact lives in `package.json`, `biome.json`, or a
> workflow, the docs link to it instead of copying it.
