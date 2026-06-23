# Contributing

Thanks for helping improve the Nimbus VS Code extension!

## Prerequisites

- [Bun](https://bun.sh) v1.2+
- VS Code 1.90+ (for running the extension host)
- A running [Nimbus Gateway](https://nimbus-agent.dev/install) for manual testing

## Setup

```bash
bun install
```

## Develop

```bash
bun run typecheck   # tsc --noEmit (strict)
bun run lint        # biome check src/
bun run test        # vitest run
bun run build       # esbuild bundles into dist/ + media/
```

To try it in VS Code: run `bun run build`, then press **F5** (Run Extension) from
this folder to launch an Extension Development Host. See
[docs/development.md](./docs/development.md) for watch mode, debugging, and the
test setup.

## Docs

Deeper reference lives in [`docs/`](./docs/): architecture, development,
settings, and the release runbook.

## Architecture notes

- This extension is **IPC-only**: it talks to the Gateway through the published
  [`@nimbus-dev/client`](https://www.npmjs.com/package/@nimbus-dev/client) package.
  Do not add direct cloud/network calls or import from the Nimbus gateway source.
- The `vscode` API is touched only through `src/vscode-shim.ts` (stubbed in tests),
  which keeps the logic unit-testable.
- TypeScript strict; **no `any`**. Biome enforces the rules in `biome.json`
  (including `noConsole` in `src/` — log via the output channel in `logging.ts`).

## Pull requests

- Keep PRs focused; include tests for behavior changes.
- `bun run typecheck && bun run lint && bun run test && bun run build && bun run check-bundle`
  must pass (CI runs the same on Ubuntu).

## Releases

Releases are tag-driven: pushing a `vX.Y.Z` tag runs `.github/workflows/publish.yml`,
which publishes to the VS Code Marketplace + Open VSX and mirrors the `.vsix` on a
GitHub Release. The tag version is stamped into `package.json` at publish time.
