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
Everything else depends on the narrow interfaces it declares (e.g. `WorkspaceApi`,
consumed by [`src/settings.ts`](../src/settings.ts)) rather than the global
`vscode` module. That keeps the logic unit-testable: tests alias `vscode` to a
stub (`test/unit/vscode-stub.ts`, wired in `vitest.config.ts`) and exercise the
real code paths without a running editor. Keep `src/` and `test/` self-contained.

## Module map

| Area | Responsibility |
| --- | --- |
| `src/extension.ts` | Activation entry: registers commands, wires the connection manager, status bar, and HITL router. |
| `src/sidebar/` | Activity-bar tree views (Audit, Sessions, Index, Agents, Egress, Workflows) over a shared `tree-view.ts` seam, plus quick-actions. Pure parse/format modules (`audit.ts`, `egress.ts`, `workflows.ts`, …) stay `vscode`-free. Workflows is the one view with lazily-loaded children (`createDataView`'s optional `loadChildren`), because eager children would cost one `workflow.listRuns` round trip per saved workflow on every open. |
| `src/workflows/` | The run surface: pure `run.ts` (pre-flight manifest, outcome wording, run report) plus `commands.ts`, which holds the injected seams. The run is gated under the `"workflow"` kind; `workflowCancel` is deliberately **not** gated, since it stops egress rather than causing any. |
| `src/chat/` | Chat controller + panel, the message protocol, session store, and the browser `webview/` bundle (Ask UI, streaming render). |
| `src/chat-participant/` | Chat participant: pure turn handler + the `real-participant.ts` vscode-glue adapter. |
| `src/lm-tools/` | The `nimbus_search` / `nimbus_ask` Language Model tools (`contributes.languageModelTools`): pure `lm-tools.ts` handlers + the `real-lm-tools.ts` vscode-glue adapter. |
| `src/search.ts` | Pure parse/rank helpers behind Search and Find related (`searchRanked` results → Quick Pick items). |
| `src/quick-ask.ts` | Pure quick-ask helpers: context clamping, path redaction, prompt building, reply extraction. Shared by quick-ask, ask-about-selection and the chat participant. |
| `src/quick-ask-presets.ts` | Resolves the configurable quick-ask preset actions (Explain / Fix / Review / Docstring). |
| `src/connection/` | Connection manager, the troubleshooter, and optional `nimbus start` auto-start. |
| `src/hitl/` | Human-in-the-loop consent: router + modal / toast / details surfaces. |
| `src/status-bar/` | Connector-health status bar item and the egress badge. |
| `src/logging.ts` | Output-channel logger. **Never** `console` in `src/` (Biome's `noConsole`). |
| `src/settings.ts` | Typed accessors over `nimbus.*` configuration. |
| `src/scm/` | Dev-workflow trio (Generate Commit Message, Review Changes, Generate Tests, Generate Docstrings): pure diff/commit-message/review/generate modules behind a `GitApiLike` seam, plus `commands.ts` and `real-git.ts` (see below). |
| `src/egress/` | The pre-flight gate: every agent-bound call routes through `gated-client.ts` (see below). Pure `leak-check.ts` / `preflight.ts`, the `gate.ts` decision table, and the `skip-store.ts` memento wrapper. |
| `src/diagnostics/` | The lightbulb actions on an error or warning diagnostic. Pure core — `normalize.ts` (diagnostic message → index query: prepend the code, strip paths and positions, apply a per-`source` keep/drop policy to quoted tokens, reject anything too short to search on), `context.ts` (diagnostic + document → the payload, ±20 lines clamped by `clampContext`), `prompts.ts`, `actions.ts` (which actions to offer, and the single diagnostic they are offered for — one per lightbulb, by a total order, so several squiggles on a line cannot multiply the entries) — plus `commands.ts` over injected deps and `real-provider.ts`, the only file here touching `vscode`. Every action carries a `command` and no `edit`, and none sets `isPreferred`: selecting one must show a suggestion, and *Auto Fix* must never fire a model call. Explain and fix route through `gated-client.ts` under the `"diagnostic"` kind; prior-occurrences is a `searchRanked` read that reaches no model and is deliberately ungated. The fix reply is spliced back over **whole lines** — `context.ts` expands the diagnostic's range to line boundaries because `prompts.ts` asks the model for whole lines, and the two granularities must agree or a sub-token range (which is what tsserver and ESLint actually report) leaves the rest of the line behind. |
| `src/briefs/` | The built-in agent briefs (`agentsWhy` / `agentsGhost` / `agentsConflicts` / `agentsHuddle` / `agentsJanitor` / `agentsPreflight`). Pure core — `catalog.ts` (the briefs as data), `render.ts` (brief → markdown, shared with the chat participant), `params.ts` (editor context → params, and the one place guaranteeing no **editor-derived** absolute path becomes a parameter — the prompted briefs pass user-typed refs verbatim and rely on the gate's leak warning), `namespace-store.ts` (per-workspace-folder memory of the last preflight namespace) — plus `commands.ts`. Every call routes through `gated-client.ts` under the `"brief"` egress kind, which prompts and is skippable per workspace. The chat participant's three ops briefs (`agentsCatchup` / `agentsExpert` / `agentsImpact`) route through the same seam but under the `"participant"` kind, which records rather than prompts — a modal must not interrupt a chat turn. Also `peek.ts` / `peek-hover.ts` — the `whyPeek` hover: a pure renderer plus the settle/supersede controller — behind `real-hover.ts`, which alongside `commands.ts` is the only `vscode`-touching code here. `agentsWhyPeek` is deliberately **not** gated: it takes no `timeoutMs`, returns synchronously, and carries no `brief` string or `AgentBriefBase`, so it never reaches a model. `test/unit/egress-choke-point.test.ts` discovers every `agents*` call shape in `src/` and asserts this is the only such exemption. |

## The `src/egress/` choke point

Before anything reaches the agent, it passes through one seam that can render
exactly what would leave — paths already redacted — and refuse to send it. The
gate is the point; the transparency is the payoff.

Five outbound paths route through it. Only the two where the **extension**
assembles context prompt by default:

| Surface | Call | Gate behaviour |
| --- | --- | --- |
| Quick Ask | `agentInvoke` | **prompts** — extension picks the context (a whole file, when there is no selection) |
| SCM trio (4 commands) | `agentInvoke` | **prompts** — extension picks the context (diffs of up to 100 files) |
| Ask panel | `askStream` | routes and records; no prompt — the user typed it |
| `@nimbus` participant | `askStream` | routes and records; no prompt — the user typed it |
| LM tools (`nimbus_ask`) | `agentInvoke` | native `prepareInvocation` card, rendered inline by the *calling* chat |

Two mechanisms keep it a guardrail rather than a convention:

1. **By construction.** Each surface gets a wrapper with its `EgressKind` fixed
   at wiring time, so a fifth SCM command inherits the gate rather than
   re-deriving it. The consumer shapes (`ScmClientLike.agentInvoke`,
   `LmToolsClientLike.agentInvoke`, `DiagnosticClientLike.agentInvoke`) take a
   third required `EgressMeta` argument, which documents that intent and makes
   an ungated wiring visible on sight in review. It is not, however, a
   *type-level* guarantee, and was once commented here as if it were: TypeScript
   assigns a function with fewer parameters to one with more, so a raw
   `NimbusClient` satisfies those shapes unchanged. The enforcement is (2).
2. **CI-level.** `test/unit/egress-choke-point.test.ts` asserts that
   `extension.ts` — the one place holding a real client — never touches
   `.agentInvoke` / `.askStream`, and that those call shapes appear only in
   `gated-client.ts` plus five allowlisted consumer modules, each of which holds
   an injected seam rather than a real client.

Cancelling throws `EgressCancelled`; every catch treats it as a normal outcome
and stays silent, exactly as dismissing a Quick Pick does.

The gate makes **no RPCs**. A pre-flight view describes a payload the extension
already holds, so like the troubleshooter and walkthrough it works while
disconnected. It is the before-the-fact counterpart to the egress ledger.

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
in VS Code's built-in Chat view (the ops slash commands `/incident`, `/deploys`,
`/owns`, `/blast`, `#file`/selection context, streaming answers, local-index
citations — the Copilot three, explain/fix/test, were retired to Quick Ask
presets); the **Language Model tools** `nimbus_search` and `nimbus_ask`, which
let other chat extensions and agents call Nimbus as a tool; a
**dev-workflow trio** over VS Code's built-in git extension — `Generate Commit
Message` (staged diff → SCM input box), `Review Changes` (all local changes →
findings tab), and `Generate Tests` / `Generate Docstrings` (selection → test
buffer / docstring diff), output always a suggestion; a Nimbus sidebar with
Audit, Sessions, Index, Agents, a **Workflows** view (saved workflows, each
one's recent runs loaded on expand) with **Run** / **Dry-Run** commands that
stream per-step output and can be cancelled — at the next step boundary, so the
in-flight step always finishes — and an **Egress** ledger viewer (with
Verify-ledger and Prove-window commands) plus an **egress status-bar badge**; a
**connection troubleshooter** (state-aware modal, no RPC); a **Get Started
walkthrough** (first-run onboarding via the VS Code Walkthroughs API, no RPC);
plus connection + HITL plumbing and **Restricted Mode** support
(`capabilities.untrustedWorkspaces` = `limited` with `extensionKind: ["ui"]` — in
an untrusted workspace the workspace-level `nimbus.socketPath` and
`nimbus.autoStartGateway` settings are ignored, so a workspace cannot redirect
the IPC socket or spawn a process).

The **share** surface is **not** implemented — it is blocked upstream, not
deferred by choice: no published `@nimbus-dev/client` exposes those RPCs (checked
through `0.14.0`, the pinned version), and the IPC-only non-negotiable forbids
reaching past the typed client. Workflow and connector surfaces are no longer
blocked — `0.14.0` exposes `workflowList`/`workflowSave`/`workflowDelete`/
`workflowListRuns`/`workflowRun`/`workflowRunStream`, the full `connector*`
suite, and `subscribeConnectorConfigChanged` — they are simply unbuilt. See
[ROADMAP.md](./ROADMAP.md).
