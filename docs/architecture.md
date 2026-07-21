# Architecture

`nimbus-vscode` is a **thin client** for [Nimbus](https://github.com/nimbus-agent/Nimbus).
It renders UI and forwards intent; all intelligence lives in a locally-running
Nimbus **Gateway**. The extension never calls a cloud API itself.

```
┌─────────────────────────── VS Code ───────────────────────────┐
│                                                                │
│  Extension host (node, CJS)            Webview (browser, IIFE) │
│  ┌──────────────────────────┐          ┌───────────────────┐   │
│  │ extension.ts             │  postMsg │ chat/webview/     │   │
│  │  ├ chat/                 │◀────────▶│   main.ts         │   │
│  │  ├ connection/           │          │   render.ts       │   │
│  │  ├ hitl/                 │          │   styles.css      │   │
│  │  ├ status-bar/           │          └───────────────────┘   │
│  │  └ vscode-shim.ts ───────┼─▶ vscode API                     │
│  └────────────┬─────────────┘                                  │
└───────────────┼────────────────────────────────────────────────┘
                │ JSON-RPC over IPC (@nimbus-dev/client)
                ▼
        Nimbus Gateway (separate process, local machine)
```

## Three load-bearing rules

### 1. IPC-only — one Nimbus dependency

All Gateway interaction goes through the published
[`@nimbus-dev/client`](https://www.npmjs.com/package/@nimbus-dev/client) package
over JSON-RPC IPC. There are **no** direct cloud/network calls and **no** imports
from the Nimbus gateway source. New Gateway capability is surfaced by bumping
`@nimbus-dev/client` and using its typed client — never by reaching into the
gateway.

The committed dependency is always a **published** version (`^x.y.z`), never
`workspace:*` (that only resolves inside the Nimbus monorepo this repo was
extracted from).

### 2. Bundled — no runtime npm dependency

[`esbuild.mjs`](../esbuild.mjs) produces two bundles:

| Entry | Platform | Output | Notes |
| --- | --- | --- | --- |
| `src/extension.ts` | node / CJS | `dist/extension.js` | `target: node18`, minified in prod, `vscode` external. |
| `src/chat/webview/main.ts` | browser / IIFE | `media/webview.js` | `globalName: NimbusWebview`, always minified (ships in the `.vsix`, reloads on every panel open). `styles.css` is copied to `media/webview.css`. |

Every dependency — including `@nimbus-dev/client`, `marked`, and `dompurify` —
is **inlined at build time**. The only thing left external is `vscode`, which the
host provides at runtime. Consequences:

- The published `.vsix` has **no runtime npm dependency**; `@nimbus-dev/client`
  is a build/typecheck-time dependency only.
- `bun run package` uses `vsce package --no-dependencies` because esbuild has
  already inlined everything.

This invariant is **self-verifying**: [`scripts/check-bundle.mjs`](../scripts/check-bundle.mjs)
asserts that `dist/extension.js` externalizes only node builtins + `vscode`, and
CI runs it on every push/PR. If a dependency ever leaked out as a runtime
`require`, the extension would fail to load on a user's machine (no
`node_modules` is shipped) — the guard catches that before release.

### 3. The `vscode` seam

The `vscode` API is touched **only** through [`src/vscode-shim.ts`](../src/vscode-shim.ts).
Everything else depends on narrow interfaces (e.g. `WorkspaceApi` in
[`src/settings.ts`](../src/settings.ts)) rather than the global `vscode` module.
That keeps the logic unit-testable: tests alias `vscode` to a stub
(`test/unit/vscode-stub.ts`, wired in `vitest.config.ts`) and exercise the real
code paths without a running editor. Keep `src/` and `test/` self-contained.

## Module map

| Area | Responsibility |
| --- | --- |
| `src/extension.ts` | Activation entry: registers commands, wires the connection manager, status bar, and HITL router. |
| `src/sidebar/` | Activity-bar tree views (Audit, Sessions, Index, Agents, Egress) over a shared `tree-view.ts` seam, plus quick-actions. Pure parse/format modules (`audit.ts`, `egress.ts`, …) stay `vscode`-free. |
| `src/chat/` | Chat controller + panel, the message protocol, session store, and the browser `webview/` bundle (Ask UI, streaming render). |
| `src/chat-participant/` | Chat participant: pure turn handler + the `real-participant.ts` vscode-glue adapter. |
| `src/search.ts` | Pure parse/rank helpers behind Search and Find related (`searchRanked` results → Quick Pick items). |
| `src/quick-ask.ts` | Pure quick-ask helpers: context clamping, path redaction, prompt building, reply extraction. Shared by quick-ask, ask-about-selection and the chat participant. |
| `src/quick-ask-presets.ts` | Resolves the configurable quick-ask preset actions (Explain / Fix / Review / Docstring). |
| `src/connection/` | Connection manager, the troubleshooter, and optional `nimbus start` auto-start. |
| `src/hitl/` | Human-in-the-loop consent: router + modal / toast / details surfaces. |
| `src/status-bar/` | Connector-health status bar item and the egress badge. |
| `src/logging.ts` | Output-channel logger. **Never** `console` in `src/` (Biome's `noConsole`). |
| `src/settings.ts` | Typed accessors over `nimbus.*` configuration. |
| `src/scm/` | Dev-workflow trio (Generate Commit Message, Review Changes, Generate Tests, Generate Docstrings): pure diff/commit-message/review/generate modules behind a `GitApiLike` seam, plus `commands.ts` and `real-git.ts` (see below). |

## The `src/scm/` seam

The dev-workflow trio follows the same seam discipline as rule 3 above, scoped
to VS Code's *built-in* git extension instead of `vscode` itself.

[`git-types.ts`](../src/scm/git-types.ts) defines the narrow structural
interface the rest of `src/scm/` programs against — `GitApiLike` /
`GitRepositoryLike`, four verbs (`changedFiles`, `fileDiff`, `untrackedPaths`,
`log`) plus the SCM input box. `repo-select.ts`, `diff.ts`,
`commit-message.ts`, `review.ts`, and `generate.ts` are pure functions over
those types — repository selection, diff ordering/budgeting/truncation,
commit-message prompting/sanitizing, review coverage, and test/docstring
prompting/extraction. `commands.ts` wires the four commands over an injected
`ScmCommandDeps` (a `git()` accessor, the client, `window`, settings), the same
dependency-injection shape used elsewhere in the extension.

[`real-git.ts`](../src/scm/real-git.ts) is the **only** file that touches the
git extension's actual API (`vscode.extensions.getExtension("vscode.git")`) —
untyped on our side. Resolving the API itself (`getExtension`/`activate`/
`getAPI`) is guarded and degrades to "git unavailable" rather than throwing;
a shape mismatch discovered later, per-repository call (e.g. a `RawChange`
missing `.uri.fsPath`) is not caught here — `commands.ts` catches it, at the
per-command level, alongside its other failure modes. It mirrors
`chat-participant/real-participant.ts` and is excluded from coverage for the
same reason: the pure modules carry the logic and the tests.

Diffs are always fetched **per file**: `collectDiff` lists changed files via
`changedFiles(scope)`, then calls `fileDiff(scope, path)` once per path. Paths
always come from git's own listing, never by parsing a `diff --git` header out
of a combined diff — there is no unified-diff parser anywhere in `src/scm/`.
Output is always a suggestion (the SCM input box, an untitled buffer, a
read-only tab, or a diff view); the extension never writes to disk and never
applies a `WorkspaceEdit`.

## Conventions

TypeScript **strict**, **no `any`** (use `unknown` for external data). Biome
([`biome.json`](../biome.json)) enforces `noExplicitAny`, `noConsole` (in `src/`),
`noNonNullAssertion`, and more. Log via the output channel, never `console`.

## Current surface

Implemented: **Ask** (streaming chat panel, with a Stop affordance that cancels
an in-flight generation), **Search** (Quick Pick over the local index),
**Ask/Search Selection**, **Find related** (pivot from a selection or Index item
to ranked neighbors), **Quick Ask** (one-shot editor quick-ask over
`agentInvoke`, reply in a read-only tab); a native `@nimbus` **Chat participant**
in VS Code's built-in Chat view (`/explain`, `/fix`, `/test` slash commands,
`#file`/selection context, streaming answers, local-index citations); a
**dev-workflow trio** over VS Code's built-in git extension — `Generate Commit
Message` (staged diff → SCM input box), `Review Changes` (all local changes →
findings tab), and `Generate Tests` / `Generate Docstrings` (selection → test
buffer / docstring diff), output always a suggestion; a Nimbus sidebar with
Audit, Sessions, Index, Agents, and an **Egress** ledger viewer (with
Verify-ledger and Prove-window commands) plus an **egress status-bar badge**; a
**connection troubleshooter** (state-aware modal, no RPC); a **Get Started
walkthrough** (first-run onboarding via the VS Code Walkthroughs API, no RPC);
plus connection + HITL plumbing.

Workflow / share surfaces are **not** implemented — they are blocked upstream,
not deferred by choice: no published `@nimbus-dev/client` exposes those RPCs
(checked through `0.5.0`), and the IPC-only non-negotiable forbids reaching past
the typed client. See [ROADMAP.md](./ROADMAP.md) Phase 4.
