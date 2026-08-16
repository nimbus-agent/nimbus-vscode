# Ambient context panel — design

Status: approved, not implemented.
Roadmap row: Phase 2, *Ambient context panel* (effort L).

## The problem

The extension's reach gap is closed. All ten typed `agents*` client methods are
called, the chat participant ships, the Language Model tools ship, the briefs
ship. What is left is that every one of those surfaces is **invoked** rather
than **offered**: the user must know a brief exists, find its command, and — for
the prompted briefs — retype context the editor already holds.

VS Code knows the open file, the cursor line, the selection, the branch, the
diff against `HEAD`, and the diagnostics on screen. Today that context reaches
an agent only when the user assembles it by hand.

This panel closes that gap: a sidebar surface that reads what is already on
screen and shows what Nimbus knows about it, with the agents that fit one click
away and pre-filled.

## Scope

**In:** a `WebviewView` in the Nimbus activity-bar container; four context
signals (blame, related index items, diagnostics, git state); a catalog-derived
list of briefs runnable right now; one settings toggle.

**Out:** running any model-backed agent automatically. The panel eagerly
collects only what reaches no model. Every model-bound action stays a click,
and that click runs an existing gated command.

## Non-negotiable posture

The panel adds **zero** outbound paths. The `EgressKind` count stays at eight.
It is a new entry point to existing paths, not a ninth path.

- `src/context/` never names `agentInvoke` or `askStream`. `gated-client.ts`
  remains the sole choke point, and `test/unit/egress-choke-point.test.ts`
  stays green without modification.
- The panel's own two RPCs reach no model: `agentsWhyPeek` (the documented
  exemption — the choke-point test keys on the **method name** across all of
  `src/`, not on the call site, so a second caller passes unchanged) and
  `searchRanked` (the same posture as *Find related* and *Find prior
  occurrences*). Both still require the Gateway socket.
- Comments in new `src/` files must not spell a dotted `agents*` call with a
  paren. The discovery test scans comments; write `agents*` in prose.

## Architecture

`src/context/`, following the shape of `src/chat/` and `src/diagnostics/`: a
pure core plus exactly one file that touches `vscode`.

| File | Purpose | Touches `vscode` |
| --- | --- | --- |
| `snapshot.ts` | The `ContextSnapshot` type and its construction from plain data: repo-relative path, `languageId`, cursor line, selection text, branch, changed-file summary, diagnostics. No I/O. | no |
| `signals.ts` | `SIGNAL_CATALOG` — a data array, one entry per signal: id, title, whether it needs the Gateway, and a pure `collect(snapshot, deps)`. | no |
| `offers.ts` | `ContextSnapshot` × `BRIEF_CATALOG.context` → the briefs runnable right now, with pre-filled arguments. | no |
| `protocol.ts` | The host↔webview message union, mirroring `chat-protocol.ts`. | no |
| `controller.ts` | Debounce, cache, visibility pause, collector fan-out, posting. Pure over an injected clock and injected deps. | no |
| `real-context-view.ts` | The `WebviewViewProvider`: registration, event wiring, CSP'd HTML, `asWebviewUri`. Smoke-tested only, excluded from coverage like `real-chat-panel.ts`. | **yes** |
| `webview/main.ts`, `webview/render.ts`, `webview/styles.css` | Browser bundle → `media/context.js` + `media/context.css`. | n/a |

`SIGNAL_CATALOG` is a data array for the same reason `BRIEF_CATALOG` is: adding
a fifth signal should be one entry, not an edit in four files.

### The boundary that matters

The webview never decides anything. It receives rendered sections and posts back
`{ command, args }`. Every judgement — what fits, what to run, what to send —
stays in the pure host modules, where the unit tests are.

### Edits outside `src/context/`

Two, both targeted:

1. **`src/scm/git-types.ts` + `src/scm/real-git.ts`** gain a `branch()` verb.
   `GitRepositoryLike` today exposes `rootPath`, `changedFiles`, `fileDiff`,
   `untrackedPaths`, `log` and `inputBox` — there is no way to read the current
   branch, and the git signal needs one.
2. **`src/briefs/peek.ts`** splits `renderPeek` into a pure field extractor the
   panel consumes plus the existing markdown-with-`command:`-link wrapper the
   hover keeps. One interpretation of a `WhyPeek`, two renderings.

### Second esbuild entry

`esbuild.mjs` gains an entry for `src/context/webview/main.ts` → `media/context.js`,
in both the build and watch configurations. `media/` is already a directory
allowlist in `.vscodeignore` and in `scripts/check-vsix-contents.mjs`, so no
packaging change is required. Add `media/context.js` to that script's
"must exist" assertion so a missing bundle cannot pass the guard trivially.

## Data flow

```
editor / selection / diagnostic / git event
  → buildSnapshot(plain data)                       [pure]
  → controller: diff against last snapshot, decide which signals are stale
  → run stale collectors concurrently; each posts its own section
  → webview renders sections independently
```

### The four signals

| Signal | Source | Cache key | Needs Gateway |
| --- | --- | --- | --- |
| `blame` | `agentsWhyPeek` | `path + line` | yes (ungated) |
| `related` | `searchRanked` | `path`, or the selection text when there is one | yes (ungated) |
| `problems` | VS Code's diagnostic collection | `path` + diagnostic count/versions | no |
| `git` | `GitApiLike` | repo root + branch + changed-file list | no |

`offers` is derived rather than collected — pure, instantaneous, always current.

### Three properties fixed by design

**Sections post individually, never as a batch.** `problems`, `git` and `offers`
resolve synchronously; `blame` and `related` are round trips. A batched render
would make the whole panel wait on the slowest RPC and visibly lag the cursor.
Each collector posts its own `section` message, carrying its own loading, error
and empty states.

**A generation counter fences stale replies.** Every snapshot gets a
monotonically increasing id; a collector's result is dropped when its generation
is no longer current. Without it, moving the cursor quickly lets an earlier,
slower `whyPeek` land after a later, faster one, and the panel shows blame for a
line the user has left.

**A failed collector fails alone.** A signal that throws renders as an error row
in its own section — the pattern `errorRow` already establishes in the sidebar —
while the other three still render. Losing the Gateway degrades the panel to
`problems` + `git` + `offers`; it never blanks it.

## Cadence

Five mechanisms, ordered by how much cost they remove.

**1. Visibility pause dominates.** The Nimbus container is usually not the open
sidebar. `WebviewView.onDidChangeVisibility` is a hard on/off: while hidden the
controller records snapshots but runs no collectors, and on becoming visible it
collects once for the current context. Most sessions therefore cost nothing.

**2. Debounce, tiered by event.** Cursor and selection 300 ms trailing; active
editor change 150 ms (Ctrl+Tab cycling is the rapid case); diagnostics 500 ms,
because a language server re-lints in bursts and each burst fires several events
for one file.

**3. Cache keyed by what the RPC actually depends on.** `blame` keys on
`path + line`, so moving within a line costs nothing, and scrolling — which
fires no cursor event at all — costs nothing. `related` keys on path or
selection text, so it is one call per file switch rather than per keystroke. A
bounded LRU of roughly 50 entries per signal, cleared on disconnect because the
index may have changed underneath it.

**4. In-flight coalescing.** A second request for a key already in flight
attaches to it. A request for a different key proceeds: neither `agentsWhyPeek`
nor `searchRanked` is cancellable (per-call abort is a Phase 4 item), so the
generation fence is what protects correctness. Coalescing is only about waste.

**5. Disconnected means skip, not fail.** When `connection.current()` is not
`connected`, the two Gateway signals are not attempted. They render "needs the
Gateway" once rather than retrying and filling the log.

Realistic worst case, actively navigating with the panel visible: about one
`whyPeek` per line the cursor rests on and one `searchRanked` per file opened —
both local lookups that reach no model.

## Action routing

Everything clickable posts `{ command, args }` to the host, which runs an
already-registered command through `executeCommand`.

- `Why is this here?` runs `nimbus.brief.why` with `{ ref, line }` — the same
  command the hover's `Why? →` link fires, so the same gate, the same manifest,
  and the same *Always send here* apply.
- Diagnostic rows route to the existing `src/diagnostics` commands.
- Git rows route to the SCM trio.
- The prompted briefs (`Is this idle?`, `Safe to deploy?`) still prompt for what
  the panel does not know, but arrive with the branch pre-filled where there is
  one.

**Command allowlist.** A webview is untrusted input. The host validates every
posted command against an allowlist derived from `BRIEF_CATALOG`,
`SIGNAL_CATALOG` and the diagnostics/SCM command ids, and never passes a
webview-supplied string to `executeCommand`. A unit test asserts an unknown id
is refused and logged.

## Settings

One new setting, matching the per-surface pattern of `briefs.showHoverBlame`
and `diagnostics.showCodeActions`:

- `nimbus.context.enabled` — boolean, default `true`. When `false` the view
  renders a one-line paused state and collects nothing.

`scripts/check-settings-docs.mjs` requires it documented in `docs/settings.md`
with its Type and Default line.

## Degraded states

Each is an explicit render, never a blank panel:

- No editor open.
- A non-file editor (output, settings, untitled schemes) — no path, so
  path-keyed signals sit out and say so.
- No git repository.
- Disconnected — the two Gateway signals show "needs the Gateway" once.
- **Repository not indexed.** A `WhyPeek` with `author`, `commitSha`, `pr` and
  `ticket` all null already means this; `renderPeek` declines the hover for it.
  The panel says to run `nimbus init` rather than showing an empty box.
- Restricted Mode — the panel works, inheriting the ignored workspace-level
  `nimbus.socketPath` / `nimbus.autoStartGateway` settings.

## Testing

| Layer | Covers |
| --- | --- |
| Vitest, pure core | Snapshot construction; each collector over fake deps; offers derivation against `BRIEF_CATALOG`; the protocol allowlist. |
| Vitest, controller with a fake clock | Debounce tiers; cache-key hits; in-flight coalescing; the generation fence discarding a late reply; visibility pause suppressing collection entirely. |
| `webview-render` style | Sections render independently, with loading, error and empty each covered. |
| `manifest-context.test.ts` | The view, the setting and the commands are declared in `package.json`. |
| `real-context-view.ts` | Smoke only, excluded from coverage like `real-chat-panel.ts`. |
| ExTester spec | Added knowing it will not run in CI (upstream headless-Linux limitation). |

The controller tests are the ones that earn their keep. Everything else is a
pattern this repo already tests.

## Verification

The `verify-extension` gate — test, typecheck, lint, build, check-bundle,
check-vsix-contents, check-settings-docs — **plus a real Extension Development
Host pass** before any claim that the panel works.

This is not ceremony. The workflow run surface shipped broken through two
releases because a UI surface passed its unit tests and was never driven in a
real editor. An ambient panel has more runtime-only failure modes than that one
did, not fewer: webview CSP and resource roots, visibility events, and event
wiring that no unit test observes.

## Delivery

Three PRs, each independently reviewable and shippable.

**PR 1 — shell and free signals.** `src/context/` pure core (`snapshot.ts`,
`signals.ts`, `offers.ts`, `protocol.ts`), `real-context-view.ts`, the webview
bundle and its esbuild entry, the `problems` and `git` signals, and
catalog-derived offers. Includes the `branch()` addition to the git seam. No
Gateway RPC at all, so the panel is useful while disconnected from day one.

**PR 2 — Gateway signals and cadence.** The `blame` and `related` collectors,
the `peek.ts` split, and the whole of the cadence section: debounce tiers,
cache, coalescing, generation fence, visibility pause.

**PR 3 — polish.** Action wiring end to end, the degraded states, the
`nimbus.context.enabled` setting, `docs/settings.md`, the ROADMAP move to
*Already shipped*, the CLAUDE.md surface paragraph, and the ExTester spec.

## Open questions

None blocking. Two to settle during implementation, both local to PR 2:

- The exact LRU size per signal. 50 is a starting figure, not a measured one.
- Whether `related` should key on selection text at all, or only on path.
  Selection-keyed lookups are more relevant but far more numerous; if the debounce
  proves insufficient, path-only is the fallback.
