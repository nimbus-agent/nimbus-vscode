# Development

How to build, run, and debug the extension locally. For the architecture behind
these commands see [architecture.md](./architecture.md).

## Prerequisites

- [Bun](https://bun.sh) v1.2+ (package manager + test runner)
- VS Code 1.90+ (to run the Extension Development Host)
- A running [Nimbus Gateway](https://nimbus-agent.dev/user-guide/install/) for manual testing
  (Ask/Search need a Gateway to talk to over IPC)

## Setup

```bash
bun install
```

## The inner loop

| Command | What it does |
| --- | --- |
| `bun run typecheck` | `tsc --noEmit` (strict, no emit) |
| `bun run lint` | `biome check src/` |
| `bun run test` | `vitest run` (unit tests) |
| `bun run test:coverage` | tests with V8 coverage |
| `bun run build` | esbuild bundles into `dist/` + `media/` |
| `bun run watch` | `build --watch` — rebuild on save |
| `bun run check-bundle` | assert the bundle keeps `vscode` as its only external (run after `build`) |
| `bun run clean` | remove build artifacts |
| `bun run package` | produce a `.vsix` via `vsce` (`--no-dependencies`) |

The full pre-PR gate (the same one CI runs) is:

```bash
bun run typecheck && bun run lint && bun run test && bun run build && bun run check-bundle
```

## Run it in VS Code (F5)

1. `bun run build` once (or start `bun run watch` to rebuild continuously).
2. Open this folder in VS Code and press **F5** (or **Run → Start Debugging**).

This launches the **Run Extension** configuration in
[`.vscode/launch.json`](../.vscode/launch.json), which opens an **Extension
Development Host** window with `nimbus-vscode` loaded. Try **Nimbus: Ask** from
the command palette, or right-click a selection → *Ask About Selection* /
*Search Selection*.

- The **watch** task in [`.vscode/tasks.json`](../.vscode/tasks.json) runs
  `bun run watch` in the background so edits to `src/` rebuild without a manual
  step. Reload the Extension Development Host (**Developer: Reload Window**) to
  pick up a rebuild.
- Extension-host logs go to the **Nimbus** output channel
  ([`src/logging.ts`](../src/logging.ts)) — set `nimbus.logLevel` to `debug` for
  the most detail. See [settings.md](./settings.md).

## Tests

Unit tests live in `test/unit/` and run under Vitest. The `vscode` module is
aliased to a stub (`test/unit/vscode-stub.ts`) in
[`vitest.config.ts`](../vitest.config.ts), so tests exercise the real `src/`
logic without a running editor — this is the payoff of routing all `vscode`
access through [`src/vscode-shim.ts`](../src/vscode-shim.ts). Webview tests run
under jsdom.

When adding code:

- Depend on a narrow interface (like `WorkspaceApi`) rather than importing
  `vscode` directly, so the unit can be driven by the stub.
- Include tests for behavior changes; keep PRs focused.

## Conventions

TypeScript **strict**, **no `any`** (use `unknown` for external data). Log via
the output channel, never `console` (Biome's `noConsole` fails the lint in
`src/`). The full rule set is in [`biome.json`](../biome.json); the editor is set
up to format with Biome on save via [`.vscode/settings.json`](../.vscode/settings.json).
