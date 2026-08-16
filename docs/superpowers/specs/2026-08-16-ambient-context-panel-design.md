# Ambient context panel — design

Status: approved, not implemented. Revised 2026-08-16 after design review
(`2026-08-16-ambient-context-panel-review.md`).
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
| `snapshot.ts` | The `ContextSnapshot` type and its construction from plain data: repo-relative path, `languageId`, cursor line, clamped selection text, `isDirty`, branch, changed-file summary, diagnostics. No I/O. | no |
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

1. **`src/scm/git-types.ts` + `src/scm/real-git.ts`** gain two verbs, `branch()`
   and `onDidChange(listener)`. `GitRepositoryLike` today exposes `rootPath`,
   `changedFiles`, `fileDiff`, `untrackedPaths`, `log` and `inputBox` — there is
   no way to read the current branch, and no event at all. Without the event, a
   branch switch made while the user is idle leaves the panel offering
   `Safe to deploy?` pre-filled with the *previous* branch: wrongness, not
   staleness. `RawRepository` in `real-git.ts` is a structural narrowing of the
   git extension's repository object, whose `state` exposes both `HEAD` and
   `onDidChange`, so this is a local edit to that interface and its adapter.
2. **`src/briefs/peek.ts`** splits `renderPeek` into a pure field extractor the
   panel consumes plus the existing markdown-with-`command:`-link wrapper the
   hover keeps. One interpretation of a `WhyPeek`, two renderings.

### Second esbuild entry

`esbuild.mjs` gains an entry for `src/context/webview/main.ts` → `media/context.js`,
in both the build and watch configurations.

**The stylesheet does not go through esbuild.** `media/webview.css` is produced
by a `copyFileSync` at the bottom of `esbuild.mjs`, not by a bundler entry, so
`media/context.css` needs a second `copyFileSync` line. An esbuild entry alone
yields a panel that renders unstyled and still passes every guard.

`media/` is already a directory allowlist in `.vscodeignore` (`!media/**`) and in
`scripts/check-vsix-contents.mjs` (`ALLOWED_DIRS`), so no packaging change is
required for either file. Add `media/context.js` **and** `media/context.css` to
that script's "must exist" assertion, so a missing bundle or a dropped
`copyFileSync` cannot pass the guard trivially.

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
| `related` | `searchRanked` | `path`, or the clamped selection text when there is one | yes (ungated) |
| `problems` | VS Code's diagnostic collection | `path` + diagnostic count/versions | no |
| `git` | `GitApiLike` | repo root + branch + changed-file list | no |

`offers` is derived rather than collected — pure, instantaneous, always current.

### Selection is clamped at the snapshot boundary

Selecting a whole large file must not put that string in a snapshot, a cache key
or a query. The repo already has two clamps, and the right one is not the
model-context one: `QUICK_ASK_MAX_CONTEXT_CHARS` (50 000, via `clampContext`)
sizes text bound for a model, while `NORMALIZED_QUERY_MAX_CHARS` (300, clamped on
a word boundary) sizes text bound for the index. `related` is an index query, so
it takes the query precedent — the snapshot stores selection already clamped to
300 chars on a word boundary, reusing the diagnostics helper rather than
introducing a third limit. The cache key is then bounded for free.

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

Window focus (`window.state.focused`) is deliberately **not** tracked as a
second pause condition. Collection is event-driven, not polled: while the VS
Code window is unfocused, no editor, selection or diagnostic events fire, so
there is nothing to suppress. Tracking focus would add API surface and a state
to test for a case that already costs zero.

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

### Invalidation

The cache expires on events, not on a timer. Four triggers:

- **Save** (`onDidSaveTextDocument`) — drop every entry for that path. The
  indexer may pick the file up, so `related` can legitimately change.
- **Git state change** (the new `onDidChange` seam verb) — recompute the `git`
  snapshot fields and drop the `git` section's entry.
- **Disconnect** — clear everything; the index may change while we are away.
- **Reconnect** — the symmetric half, and the one the first draft of this spec
  omitted. The controller subscribes to `SidebarConnection.onState`, the same
  event every sidebar view already uses, and on a transition **into**
  `connected` it drops the "needs the Gateway" sections and re-collects if the
  view is visible. Without it the panel stays dead until the user happens to
  move the cursor.

**Deliberately not a trigger: `onDidChangeTextDocument`, and document `version`
is deliberately not part of any cache key.** That event fires per keystroke, so
keying `blame` on `version` would invalidate on every keystroke and cost an RPC
at every subsequent cursor rest — exactly the storm this section exists to
prevent. It would also buy nothing: `agentsWhyPeek` answers about **committed**
content, so a mid-edit refetch returns the same answer against a line number
that has shifted either way. Unsaved edits are communicated instead, at zero
cost, by the dirty marker below.

### Dirty documents

`ContextSnapshot` carries `isDirty`. When it is set, the `blame` section renders
a marker saying the file has unsaved edits and the attribution may not line up
with what is on screen.

Blame is **not** suppressed for a dirty file. The shipped hover
(`briefs.showHoverBlame`) has exactly this exposure today, so the panel inherits
it rather than introducing it — and hiding blame while the user edits would
remove it at the moment it is most wanted. The marker states the limit; the save
trigger above clears it.

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

**Command allowlist, and argument validation.** A webview is untrusted input.
The host validates every posted message on two axes and never passes a
webview-supplied string to `executeCommand`:

1. **The id**, against a `ReadonlyArray<string>` derived from `BRIEF_CATALOG`,
   `SIGNAL_CATALOG` and the diagnostics/SCM command ids.
2. **The arguments**, against a per-command validator. An allowlisted id with a
   malformed payload is refused exactly like an unknown id — `nimbus.brief.why`
   accepts `{ ref: string, line: number }` and nothing else, rather than letting
   arbitrary JSON reach a command handler.

Unit tests assert both refusals, and that each is logged.

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
| Vitest, controller with a fake clock | Debounce tiers; cache-key hits; in-flight coalescing; the generation fence discarding a late reply; **hidden means no collector runs**, asserted rather than assumed; each of the four invalidation triggers; reconnect re-collecting while visible and *not* collecting while hidden. |
| Vitest, protocol | An unknown command id is refused and logged; an allowlisted id with malformed args is refused and logged; selection longer than the query clamp is truncated on a word boundary. |
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
catalog-derived offers. Includes the `branch()` addition to the git seam, the
cadence section's visibility pause and debounce tiers, and the dirty marker.
No Gateway RPC at all, so the panel is useful while disconnected from day one.

**PR 2 — Gateway signals and cadence.** The `blame` and `related` collectors,
the `peek.ts` split, and the rest of the cadence section: the cache, in-flight
coalescing, the general generation fence, the four invalidation triggers, and
the seam's `onDidChange` verb.

**PR 3 — polish.** Action wiring end to end, the degraded states, the
`nimbus.context.enabled` setting, `docs/settings.md`, the ROADMAP move to
*Already shipped*, the CLAUDE.md surface paragraph, and the ExTester spec.

## Open questions

None blocking. One to settle during implementation, local to PR 2:

- The exact LRU size per signal. 50 is a starting figure, not a measured one.

Settled by the 2026-08-16 review, and recorded here so they are not reopened by
default: selection keying stays (clamped at the 300-char index-query limit, which
bounds the key); document `version` stays out of every cache key; window focus is
not a pause condition. Reasoning for each is inline above.
