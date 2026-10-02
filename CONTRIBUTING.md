# Contributing

Thanks for helping improve the Nimbus VS Code extension!

## Questions

If the extension isn't doing what you expect — no answer comes back, the sidebar
is empty, the status bar looks dead — the cause is usually the Gateway rather
than the extension: it isn't running, or `nimbus.socketPath` is pointing
somewhere else. Run **Nimbus: Troubleshoot Connection** from the command palette
first. It tells you what it found and offers a one-click fix.

Still stuck, or just want to ask something? Post in
[Nimbus Discussions](https://github.com/nimbus-agent/Nimbus/discussions).
Questions about any part of Nimbus get answered there, so you don't have to work
out which repository yours belongs to, and a GitHub account is the whole of the
process. That includes "would you accept a PR that does X?", which is worth
asking before you build it.

Found a real defect in the extension, or want a specific change made to it? Open
an [issue](https://github.com/nimbus-agent/nimbus-vscode/issues) here — no need
to ask permission first. Anything that looks like a security problem should not
be posted publicly anywhere: follow [SECURITY.md](./SECURITY.md).

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
- Logic modules program against the narrow `*Like` interfaces in
  `src/vscode-shim.ts` (aliased to a stub in tests), which keeps them
  unit-testable. The real `vscode` module is imported only by `src/extension.ts`
  and the seven `real-*.ts` adapters — new `vscode` surface goes in an adapter.
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

## Updating dependencies

No bot opens dependency-update PRs here. A maintainer updates dependencies in
periodic bulk PRs: run `bun outdated`, raise the ranges in `package.json`, run
`bun install`, then run the full gate above and open one `chore(deps):` PR.
GitHub's Dependabot *alerts* stay on for security advisories; only its update
PRs were retired.

A range bump is not the whole job for these:

- **`bun.lock`** — commit it with `package.json`. CI installs with
  `bun install --frozen-lockfile`, so a range change without its regenerated
  lockfile fails every job.
- **`@nimbus-dev/client`** — leave it out of a bulk update. It is bumped on
  purpose, in its own PR, when the extension surfaces new Gateway capability.
- **`vitest` and `@vitest/coverage-v8`** — always the same version, in one
  change: the coverage provider declares the exact `vitest` version as its peer.
- **`@types/vscode`** — follows `engines.vscode`, not npm's latest. The types
  decide which VS Code APIs the code may call, so types newer than the
  `engines.vscode` floor let code compile against APIs the oldest supported
  VS Code lacks. `vsce package` rejects a declared `@types/vscode` range whose
  major.minor is newer than `engines.vscode`, but it reads the range in
  `package.json`, not the version `bun.lock` resolved — check that too. Raise
  the two together, deliberately, never as part of a bulk update.
- **The UI-test harness** — `vscode-extension-tester` (pinned exactly),
  `mocha`, `chai` and their `@types`. CI typechecks `test/ui/` but never runs
  it, so after bumping any of them run `bun run test:ui` yourself (see
  [docs/development.md](./docs/development.md#ui-tests)).
- **GitHub Actions** — third-party actions are pinned by full commit SHA with
  the version in a trailing comment (`@<sha> # v7.0.0`); update the two
  together. Bun is pinned in two places that move together: the workflows'
  `bun-version` input and the `oven/bun` image in `.gitlab-ci.yml`.

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
