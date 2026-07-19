# Contributing

Thanks for helping improve the Nimbus VS Code extension!

## Prerequisites

- [Bun](https://bun.sh) v1.2+
- VS Code 1.95+ (for running the extension host — matches `engines.vscode`)
- A running [Nimbus Gateway](https://nimbus-agent.dev/user-guide/install/) for manual testing

## Setup

```bash
bun install
```

## Develop

```bash
bun run typecheck   # tsc --noEmit (strict)
bun run lint        # biome check . (whole repo)
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
- **The PR title must be a [Conventional Commit](https://www.conventionalcommits.org)**
  (`feat:`, `fix:`, `chore:`, `docs:`, …). The repo squash-merges, so the title
  becomes the commit on `main` that Release Please reads to compute the version
  bump and changelog. `.github/workflows/pr-title-lint.yml` enforces this.
- The full gate must pass locally:

  ```bash
  bun run typecheck && bun run lint && bun run check-settings-docs && \
    bun run test && bun run build && bun run check-bundle && bun run check-vsix-contents
  ```

  CI runs the same set on Ubuntu, plus a lean Windows job (typecheck, test,
  build, bundle guards).

## Releases

Releases are automated with **Release Please**. Merging Conventional-Commit PRs
to `main` keeps a release PR open with the computed version bump and changelog;
merging *that* PR tags `vX.Y.Z`, which triggers
`.github/workflows/publish.yml` to publish to the VS Code Marketplace + Open VSX
and mirror the `.vsix` on a GitHub Release. The tag version is stamped into
`package.json` at publish time.

Do **not** hand-edit `CHANGELOG.md` or create tags manually — Release Please owns
both. See [docs/releasing.md](./docs/releasing.md) for the full runbook and the
manual fallback.
