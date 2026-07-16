# Nimbus VS Code Extension — Claude Code Context

## What this is

`nimbus-vscode` is the VS Code / Open VSX extension for [Nimbus](https://github.com/nimbus-agent/Nimbus), a local-first AI agent framework. It is a **thin client**: it talks to a locally-running Nimbus Gateway over JSON-RPC IPC via the published `@nimbus-dev/client` package and never calls cloud APIs itself.

Extracted from the Nimbus monorepo (`packages/vscode-extension`) on 2026-06-22 so it can release independently of the Gateway.

## Architecture (load-bearing)

- **IPC-only.** All Gateway interaction goes through `@nimbus-dev/client` (published to npm). There are no direct cloud/network calls and **no imports from the Nimbus gateway source** — the only Nimbus dependency is `@nimbus-dev/client`.
- **Bundled.** `esbuild.mjs` bundles `src/extension.ts` (node CJS) and the webview entry `src/chat/webview/main.ts` (browser IIFE) into `dist/` + `media/`, with only `vscode` external. The published `.vsix` therefore has **no runtime npm dependency** on `@nimbus-dev/client` — it's inlined at build time; the dep is build/typecheck-time only.
- **Surface today:** Ask (streaming chat panel), Search (Quick Pick over the local index), Ask/Search Selection, **Quick Ask** (one-shot editor quick-ask over `agentInvoke` — reply in a read-only tab, no chat panel); a Nimbus activity-bar sidebar with **Audit**, **Sessions** (with chat resume), **Index**, and **Agents** views; plus an **Egress** ledger viewer (with Verify-ledger and Prove-window commands); a status-bar quick menu and connection + HITL plumbing. For where this is going, see [docs/ROADMAP.md](docs/ROADMAP.md) (phased by SDK-readiness). Workflow / share surfaces are **not implemented yet** — they are blocked upstream, not deferred by choice: no published `@nimbus-dev/client` exposes those RPCs (checked through `0.4.0`, which added the egress RPCs this surface now uses), and the non-negotiable below forbids reaching past the typed client. Building them starts with the Gateway shipping the RPCs and the client surfacing them typed.

## Layout

- `src/` — extension-host code (`extension.ts` entry); `src/chat/` (chat controller/panel + `webview/` browser bundle); `src/sidebar/` (activity-bar tree views — audit, sessions, index, agents — plus quick-actions, over a shared `tree-view.ts` seam); `src/connection/`, `src/hitl/`, `src/status-bar/`, `src/logging.ts`, `src/settings.ts`
- `src/vscode-shim.ts` — the seam over the `vscode` API (stubbed in tests via `test/unit/vscode-stub.ts`)
- `test/unit/` — Vitest unit tests; `vscode` is aliased to the stub in `vitest.config.ts`
- `esbuild.mjs` — build
- `scripts/` — Node ESM maintenance helpers: `clean.mjs`, `check-bundle.mjs` (guards the no-runtime-dep bundling invariant). See `scripts/README.md`.
- `docs/` — contributor/maintainer reference: `architecture.md`, `development.md`, `settings.md`, `releasing.md`. See `docs/README.md`.
- `.github/workflows/ci.yml` — typecheck + lint + test + build + check-bundle on PR/push
- `.github/workflows/publish.yml` — on a `v*` tag: Marketplace + Open VSX + GitHub Release

## Commands

```bash
bun install
bun run typecheck     # tsc --noEmit (strict)
bun run lint          # biome check src/
bun run test          # vitest run
bun run build         # esbuild bundles
bun run watch         # esbuild bundles, rebuild on save
bun run check-bundle  # assert vscode is the bundle's only external (run after build)
bun run package       # .vsix via vsce (--no-dependencies; esbuild already inlined deps)
```

## Conventions / non-negotiables

- TypeScript **strict**; **no `any`** (use `unknown` for external data). Biome enforces this (`noExplicitAny`, `noConsole` in `src/`, `noNonNullAssertion`, …) — see `biome.json`. Log via the output channel (`logging.ts`), never `console`.
- The committed `@nimbus-dev/client` dependency is always a **published** version (`^x.y.z`), never `workspace:*` (that only resolves inside the monorepo).
- Don't reach into the Nimbus gateway. New Gateway capability is surfaced by bumping `@nimbus-dev/client` and using its typed IPC client.
- Keep `src/` and `test/` self-contained; the `vscode` API is only touched through `vscode-shim.ts`.

## Releasing

1. `publish.yml` stamps the package version **from the git tag** — the `version` in `package.json` is only a baseline.
2. Tag `vX.Y.Z` and push → `publish.yml` publishes to the VS Code Marketplace + Open VSX and mirrors the `.vsix` on a GitHub Release.
3. Requires repo secrets `VSCE_PAT` (Azure DevOps, "Marketplace (Manage)") and `OVSX_PAT` (Open VSX namespace `nimbus-agent`) in the `release` environment.

## Requires (runtime)

A running Nimbus Gateway. See <https://nimbus-agent.dev/install>.
