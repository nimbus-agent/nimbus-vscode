# Nimbus VS Code Extension — Claude Code Context

## What this is

`nimbus-vscode` is the VS Code / Open VSX extension for [Nimbus](https://github.com/nimbus-agent/Nimbus), a local-first AI agent framework. It is a **thin client**: it talks to a locally-running Nimbus Gateway over JSON-RPC IPC via the published `@nimbus-dev/client` package and never calls cloud APIs itself.

Extracted from the Nimbus monorepo (`packages/vscode-extension`) on 2026-06-22 so it can release independently of the Gateway.

## Architecture (load-bearing)

- **IPC-only.** All Gateway interaction goes through `@nimbus-dev/client` (published to npm). There are no direct cloud/network calls and **no imports from the Nimbus gateway source** — the only Nimbus dependency is `@nimbus-dev/client`.
- **Bundled.** `esbuild.mjs` bundles `src/extension.ts` (node CJS) and the webview entry `src/chat/webview/main.ts` (browser IIFE) into `dist/` + `media/`, with only `vscode` external. The published `.vsix` therefore has **no runtime npm dependency** on `@nimbus-dev/client` — it's inlined at build time; the dep is build/typecheck-time only.
- **Surface today:** Ask (streaming chat panel, with a **Stop** button that cancels an in-flight generation via `cancelStream`), Search (Quick Pick over the local index), Ask/Search Selection, **Find related** (pivot from a selection or Index item to ranked neighbors via `searchRanked`), **Quick Ask** (one-shot editor quick-ask over `agentInvoke` — reply in a read-only tab, no chat panel), the **`@nimbus` Chat participant** (native participant in VS Code's built-in Chat view — the ops slash commands `/incident`, `/deploys`, `/owns`, `/blast`, `#file`/selection context, streaming answers via `askStream`, local-index citations via `searchRanked`; the Copilot three — explain/fix/test — were retired to Quick Ask presets in PR #49); the **Language Model tools** `nimbus_search` + `nimbus_ask` (`contributes.languageModelTools`, so other chat extensions and agents can call Nimbus as a tool — `src/lm-tools/`); a **dev-workflow trio** over the built-in git extension — `Generate Commit Message` (staged diff → SCM input box, matching the repo's own commit style), `Review Changes` (staged + unstaged local changes → a findings tab naming what wasn't reviewed), and `Generate Tests` / `Generate Docstrings` (editor selection → untitled test buffer / docstring diff) — all via `agentInvoke`, output always a suggestion, never an applied edit; a Nimbus activity-bar sidebar with **Audit**, **Sessions** (with chat resume), **Index**, and **Agents** views; an **Egress** ledger viewer (with Verify-ledger and Prove-window commands) plus an **egress status-bar badge** (row count + ledger-live ✓ via `egressHead`; shown while connected, on by default, toggle `nimbus.egress.showStatusBarBadge`); a **connection troubleshooter** (state-aware modal, no RPC); a **Get Started walkthrough** (first-run onboarding via `Nimbus: Open Walkthrough` / the Welcome page, no RPC); a status-bar quick menu and connection + HITL plumbing; plus **Restricted Mode** support (`capabilities.untrustedWorkspaces` = `limited`, `extensionKind: ["ui"]` — in an untrusted workspace the workspace-level `nimbus.socketPath` and `nimbus.autoStartGateway` settings are ignored). For where this is going, see [docs/ROADMAP.md](docs/ROADMAP.md) (phased by SDK-readiness). The **share** surface is **not implemented yet** — it is blocked upstream, not deferred by choice: no published `@nimbus-dev/client` exposes those RPCs (checked through `0.12.1`, the pinned version), and the non-negotiable below forbids reaching past the typed client. Workflow and connector RPCs are **no longer blocked** — `0.12.1` exposes `workflowList`/`workflowSave`/`workflowDelete`/`workflowListRuns`/`workflowRun` and the full `connector*` suite (incl. `connectorReindex`, `connectorAddMcp`) — those surfaces are simply unbuilt.

## Layout

- `src/` — extension-host code (`extension.ts` entry); `src/chat/` (chat controller/panel + `webview/` browser bundle); `src/sidebar/` (activity-bar tree views — audit, sessions, index, agents — plus quick-actions, over a shared `tree-view.ts` seam); `src/scm/` (dev-workflow trio: pure diff/commit-message/review/generate modules plus `commands.ts`, behind a `GitApiLike` seam over VS Code's built-in git extension — `real-git.ts` is the only file that touches it, mirroring `src/chat-participant/real-participant.ts`); `src/lm-tools/` (the `nimbus_search` / `nimbus_ask` Language Model tools — pure handlers plus the `real-lm-tools.ts` vscode-glue adapter); `src/connection/`, `src/hitl/`, `src/status-bar/`, `src/logging.ts`, `src/settings.ts`
- `src/vscode-shim.ts` — the seam over the `vscode` API (stubbed in tests via `test/unit/vscode-stub.ts`)
- `test/unit/` — Vitest unit tests; `vscode` is aliased to the stub in `vitest.config.ts`
- `esbuild.mjs` — build
- `scripts/` — Node ESM maintenance helpers: `clean.mjs`, `check-bundle.mjs` (guards the no-runtime-dep bundling invariant), `check-vsix-contents.mjs` (guards what the `.vsix` ships), `check-settings-docs.mjs` (guards settings-doc drift); plus `secret-health.ts`, the tested classifier behind `secret-health.yml` that keeps a rejected publish token apart from one merely approaching a known expiry. See `scripts/README.md`.
- `docs/` — contributor/maintainer reference: `architecture.md`, `development.md`, `settings.md`, `releasing.md`. See `docs/README.md`.
- `.github/workflows/ci.yml` — typecheck + lint + check-settings-docs + test + build + check-bundle + check-vsix-contents on PR/push (Ubuntu), plus a lean Windows job (typecheck + test + build + the two bundle guards)
- `.github/workflows/publish.yml` — on a `v*` tag: Marketplace + Open VSX + GitHub Release
- `.github/workflows/dependabot-lockfile.yml` — the only `pull_request_target` workflow here (a write-capable token over a PR author's tree). Its four defences — the `dependabot[bot]` actor gate, `bun install --ignore-scripts`, `persist-credentials: false`, and a `head.sha`-pinned checkout — are pinned by `test/unit/dependabot-lockfile-workflow.test.ts`; change one and that test tells you.

## Commands

```bash
bun install
bun run typecheck     # tsc --noEmit (strict)
bun run lint          # biome check . (whole repo)
bun run test          # vitest run
bun run build         # esbuild bundles
bun run watch         # esbuild bundles, rebuild on save
bun run check-bundle  # assert vscode is the bundle's only external (run after build)
bun run check-vsix-contents  # assert the .vsix ships only allowlisted files (run after build)
bun run check-settings-docs  # assert every nimbus.* setting is documented
bun run package       # .vsix via vsce (--no-dependencies; esbuild already inlined deps)
```

## Conventions / non-negotiables

- TypeScript **strict**; **no `any`** (use `unknown` for external data). Biome enforces this (`noExplicitAny`, `noConsole` in `src/`, `noNonNullAssertion`, …) — see `biome.json`. Log via the output channel (`logging.ts`), never `console`.
- The committed `@nimbus-dev/client` dependency is always a **published** version (`^x.y.z`), never `workspace:*` (that only resolves inside the monorepo).
- Don't reach into the Nimbus gateway. New Gateway capability is surfaced by bumping `@nimbus-dev/client` and using its typed IPC client.
- Keep `src/` and `test/` self-contained; the `vscode` API is only touched through `vscode-shim.ts`.

## Releasing

1. Releases are automated with **Release Please**. Land PRs with Conventional-Commit titles (the repo squash-merges, so the PR title is the commit `release-please.yml` reads); it keeps a standing release PR that bumps `package.json` and writes `CHANGELOG.md`. Never hand-edit the CHANGELOG or tag by hand.
2. Merging that release PR creates the `vX.Y.Z` tag → `publish.yml` stamps the version **from the tag**, publishes to the VS Code Marketplace + Open VSX, and mirrors the `.vsix` on a GitHub Release. Pushing a tag by hand is the documented fallback only.
3. Requires repository secrets `VSCE_PAT` (Azure DevOps, "Marketplace (Manage)") and `OVSX_PAT` (Open VSX namespace `nimbus-agent`), plus the **organization**-level `RELEASE_BOT_CLIENT_ID` / `RELEASE_BOT_PRIVATE_KEY` App credentials that mint the release-please token (a tag pushed by `GITHUB_TOKEN` would not fire `publish.yml`). The `publish` job declares `environment: release`, which now restricts deploys to `main` + `v*` tags, but both publish secrets are still configured at the **repository** level — so every workflow on this repo can read them until they are re-added as environment secrets and the repo-scoped copies deleted. See [docs/releasing.md](docs/releasing.md).

## Requires (runtime)

A running Nimbus Gateway. See <https://nimbus-agent.dev/user-guide/install/>.
