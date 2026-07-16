# Phase 1 Quick Wins — Batch Design

**Date:** 2026-07-16
**Status:** Approved (design), pending implementation plan
**Scope:** The four Phase 1 "quick wins" from [docs/ROADMAP.md](../../ROADMAP.md), built as one branch / one PR with four independent, individually-reviewable commits.

## Context & non-negotiables

The extension is a **thin IPC client** (see [CLAUDE.md](../../../CLAUDE.md)). Every constraint below is load-bearing for this batch:

- **No reaching past `@nimbus-dev/client`.** All Gateway data rides typed RPCs. This batch uses `egressHead`, `cancelStream` (already consumed via `AskStreamHandle.cancel()`), and `searchRanked` — all present in the installed `@nimbus-dev/client@0.5.0`. No upstream dependency.
- **No `any`** (use `unknown` for external data); TypeScript strict; Biome-enforced (`noExplicitAny`, `noConsole`, `noNonNullAssertion`).
- **`vscode` only through `src/vscode-shim.ts`**; log via `logging.ts`, never `console`.
- **Docs-sync guard**: any new setting must land in `package.json` (`contributes.configuration`), `docs/settings.md`, **and** `README.md` in the same change.

This batch introduces **exactly one** new setting (`nimbus.egress.showStatusBarBadge`) → one docs-sync pass.

## Findings that shaped the design (verified against code)

Two discoveries changed the naive roadmap reading:

1. **"Stop" is ~80% already built.** `chat-protocol.ts` declares `stopStream`; the webview has a real Stop button with disabled-state handling (`webview/main.ts`); `chat-controller.ts` `stop()` calls `handle.cancel()`, which — verified in the compiled client (`node_modules/@nimbus-dev/client/dist/ask-stream.js`) — **calls `engine.cancelStream` on the Gateway**, so cancellation genuinely propagates and the Gateway stops generating. `extension.ts` wires `stopStream` → `controller.stop()`.

   **The real gap** is that `controller.stop()` posts **nothing** to the webview. The `for await` loop in `start()` ends silently, leaving the partial assistant turn stuck with the streaming spinner (`data-streaming="1"`), Stop still enabled, Send still disabled, status still "Streaming…". The existing `stop()` unit test only asserts `cancel()` fired and `isStreaming() === false`, never a webview message — which is why the gap slipped through. So #2 is **"close the UI feedback loop on cancel,"** not "build cancellation."

2. **"Find related" from a selection overlaps `nimbus.searchSelection`**, which already runs `searchRanked` on the selection through the shared QuickPick. The genuinely new surface is the **Index-item pivot** plus a **distinctly-framed** "related neighbors" command that excludes exact/self matches.

## Batch shape

- **Branch:** `feat/phase1-quick-wins`.
- **Commits (independent, in this order):**
  1. `feat(egress): status-bar badge (row count + head-reachable ✓) via egressHead`
  2. `feat(chat): reset webview UI after Stop (finalize partial + Stopped marker)`
  3. `feat(connection): connection troubleshooter modal`
  4. `feat(search): Find related from selection + index item via searchRanked`
- The features share no state and touch disjoint subsystems (status-bar, chat/webview, connection, search), so each commit stays independently reviewable and revertable.
- Each feature isolates pure, testable core logic from thin `extension.ts` / `vscode-shim` wiring, mirroring existing modules.

---

## Feature 1 — Egress status-bar badge

**Goal:** an always-visible, at-a-glance trust signal: egress row count + a "ledger live" checkmark.

### Components

- **New module** `src/status-bar/egress-status-bar-item.ts`, mirroring `status-bar-item.ts`:
  - `type EgressBadgeInputs = { head: { head: string; count: number } | undefined; lastKnownCount: number | undefined; error: string | undefined; connected: boolean; showBadge: boolean; }` — `head` is set on a fresh successful read; on a read error `head` is `undefined` and `error` + `lastKnownCount` (tracked by the controller across polls) drive the stale render.
  - `formatEgressBadge(inp: EgressBadgeInputs): EgressBadgeRender | undefined` — pure. Returns `undefined` when the item should be hidden (disconnected, setting off, or error before any successful read).
  - `createEgressStatusBarController(item: StatusBarItemHandle): { update(inp): void; dispose(): void }`.
- **A second status-bar item**, right-aligned (`createStatusBarItem(2, 99)`) — priority 99 places it just to the right of the connection item (priority 100). Created and disposed in `extension.ts` alongside the existing one.

### Behaviour

- **Visibility:** shown only while `connection.kind === "connected"` **and** `showBadge` is true. Hidden otherwise (calls `item.hide()`), because there is no reachable ledger to describe when disconnected.
- **Poll cadence:** `egressHead()` on the existing, currently-unused **`statusBarPollMs`** setting (default 30000) — this badge is its first consumer, so no new cadence setting. Also refresh on transition into `connected`, and immediately when the poll interval is (re)started.
- **Consistency with the egress view (composition-root coupling):** the badge and `egressView` read the same ledger but stay decoupled *as modules* — the coupling lives in the composition root. `extension.ts` gains a single `refreshEgress()` helper that calls both `egressView.refresh()` and the badge controller's `poll()`; existing call sites that refresh the view (e.g. after Verify-ledger, `extension.ts:676`) call `refreshEgress()` instead. **No shared event emitter is introduced** — a polled badge with bounded ≤`statusBarPollMs` staleness plus this explicit co-refresh is sufficient, and it keeps `egress-status-bar-item.ts` free of any dependency on the tree view. *(Resolves feedback 1a: coupling is real but belongs in the composition root, not a new emitter seam.)*
- **Render (success):** `text = "$(shield) {count} $(check)"`; `tooltip = "Egress ledger: {count} rows · head {head.slice(0,6)}… · click to open · run \"Verify ledger\" for a cryptographic check"`; `command = "nimbus.egressView.focus"` (VS Code's auto-generated tree-reveal command — no new command needed).
- **Render (read error):** if a prior successful read exists, keep its count and flag staleness — `text = "$(shield) {lastKnownCount} $(warning)"`, tooltip `Egress ledger: couldn't refresh — showing last known {lastKnownCount} rows ({error})`. If no successful read has happened yet, stay hidden (same as before the first read). The count is **never** replaced by a literal word: the badge always shows a number or nothing. The poll swallows the error (logged at `warn`) and retries next tick. *(Resolves feedback 1b: the earlier `$(shield) egress $(question)` text was ambiguous — dropped in favour of last-known-count + `$(warning)`.)*

### Honesty guard (explicit design decision)

The checkmark attests **"head read OK / ledger live," not a cryptographic verification.** `egressHead` only returns `{ head, count }`; it does not walk the chain. Given Nimbus's trust positioning, the tooltip must not imply otherwise — it explicitly points to the existing *Verify ledger* command for the real offline BLAKE3 check. The icon is `$(shield)` (trust surface) with `$(check)` meaning "reachable," never a bare green "verified" claim.

### New setting

`nimbus.egress.showStatusBarBadge` — boolean, default `true`. Added to `Settings` (`showEgressStatusBarBadge()`), `package.json`, `docs/settings.md`, `README.md`. A config change re-renders the badge (via the existing `onDidChangeConfiguration` path).

### Tests

- `formatEgressBadge`: hidden when disconnected / setting off / no successful read yet; success render (count, short head, check, command); stale render after a read error (last-known count + `$(warning)`, no check, tooltip names the error).
- Poll/controller behaviour is exercised through the format function; the interval wiring is thin `extension.ts` glue (smoke-covered like other timers).

---

## Feature 2 — Reset webview UI after Stop

**Goal:** clicking Stop already cancels the Gateway generation; make the webview reflect it — finalize the partial reply, mark it stopped, and return the controls to idle.

### Protocol

- Add to `ExtensionToWebview`: `{ type: "cancelled" }`.

### Extension / controller

- `chat-controller.ts` `stop()`: if there is an active handle, clear it, **post `{ type: "cancelled" }` immediately, then** call `handle.cancel()`. Posting *before* awaiting the cancel is the fix for the hang risk (feedback 2a): `handle.cancel()` awaits an IPC round-trip (`engine.cancelStream`) that can hang if the connection is severed, and the webview's return-to-idle must not depend on the Gateway acking it. `postMessage` to the webview is a local call, so the UI always resets — no webview watchdog timer is needed. If there was no active stream, post nothing. Race-safe: a near-simultaneous `done`/`error` already reset the UI, and a stray `cancelled` is ignored by the webview (see below). `newConversation()` and `resume()` keep their existing `reset`/`hydrate` posts (they replace the transcript, so no marker is wanted there).
- **Resource cleanup (feedback 2b):** the existing `start()` `finally` block already unregisters the HITL stream and clears `active`; the client's own notification subscriptions are torn down inside its `finish()`, guarded by a `done` flag (it has no `off()` yet — a known, guarded no-op in `ask-stream.js`). No additional teardown is required in our code.

### Webview (`webview/main.ts`)

- On Stop click: immediately set status to `Stopping…` and disable the Stop button (prevents a double-click before `cancelled` lands). Do not finalize yet.
- On `cancelled` message:
  - if not currently streaming, ignore (a concurrent `done`/`error` already handled it);
  - otherwise finalize the streaming turn (reuse `finalizeStreamingTurn`), append a muted `⏹ Stopped` marker element to that turn, and `setStreaming(r, false)` (re-enables Send, clears status).
- The `⏹ Stopped` marker is a small muted line appended to the finalized assistant turn so the transcript records that the reply was cut short. Partial content is **kept** (per the chosen "finalize partial + subtle marker" UX).

### Tests

- `chat-controller.test.ts`: `stop()` with an active stream posts a `cancelled` message (extend the existing test, which currently only checks `cancel()` + `isStreaming()`); `stop()` when idle posts nothing.
- `webview-interactions.test.ts`: a `cancelled` message while streaming finalizes the turn (removes `data-streaming`), appends the `⏹ Stopped` marker, re-enables Send, disables Stop; a `cancelled` message while not streaming is a no-op.

---

## Feature 3 — Connection troubleshooter

**Goal:** remove the #1 first-run friction — a "why am I disconnected / how do I fix it" flow. No RPC; pure local + VS Code API over `ConnectionState`.

### Components

- **New pure module** `src/connection/troubleshooter.ts`:
  - `type TroubleshootAction = { label: string; command: string; args?: unknown[] }`
  - `type TroubleshootReport = { level: "info" | "warn" | "error"; message: string; actions: TroubleshootAction[] }`
  - `buildTroubleshooter(state: ConnectionState, opts: { autoStartGateway: boolean; platform: NodeJS.Platform }): TroubleshootReport` — one branch per `state.kind`. No `vscode` import; `platform` is **injected** (extension.ts passes `process.platform`), keeping the module pure and unit-testable across platforms. *(Resolves feedback 3a.)*
- **New command** `nimbus.troubleshootConnection` in `extension.ts` (palette title **"Nimbus: Troubleshoot Connection"**). It reads `connection.current()`, builds the report, shows a **modal** via the window shim (`showInformationMessage`/`showWarningMessage`/`showErrorMessage` with `{ modal: true }` and the report's action labels as buttons), and dispatches the chosen action's `command` (with `args`) through `deps.commands.executeCommand`.

### State → report mapping

| `state.kind` | level | message (summarised) | actions |
| --- | --- | --- | --- |
| `connected` | info | "Connected to the Gateway at `{socketPath}`." | Open Logs |
| `disconnected` (autoStart off) | error | "Nimbus can't reach the Gateway (not running) at `{socketPath}`." | Start Gateway; Open Logs |
| `disconnected` (autoStart on) | warn | "Waiting for the Gateway to start at `{socketPath}`." | Reconnect Now; Open Logs |
| `permission-denied` | error | **Platform-tailored:** Unix → "Permission denied accessing the socket `{socketPath}` — check the socket file's ownership/mode (`chmod`/`chown`) or the socketPath setting."; Windows (`win32`) → "Permission denied accessing `{socketPath}` — check that the Gateway is running under your user account (named-pipe access), or adjust the socketPath setting." | Edit socketPath Setting; Open Logs |
| `connecting` / `starting-gateway` | info | "Still connecting to `{socketPath}`…" | Reconnect Now; Open Logs |
| `idle` | warn | "Nimbus hasn't connected yet." | Reconnect Now; Open Logs |

Action → command: Start Gateway → `nimbus.startGateway`; Reconnect Now → `nimbus.reconnect`; Open Logs → `nimbus.openLogs`; Edit socketPath Setting → `workbench.action.openSettings` with args `["nimbus.socketPath"]`.

### Decoupling

Deliberately **do not** repoint the shipped status-bar error commands (`nimbus.startGateway`, `nimbus.openLogs`) at the troubleshooter — that would entangle this feature with the status-bar commit. The troubleshooter is reachable via the command palette (and remains available for a later, separate wiring decision).

### Deferred (feedback 3b)

A connected-state **self-test** (latency ping / test-RPC button) was suggested. **Deferred** — it is a separate feature with its own design surface (which RPC, timeout handling, how latency is displayed), beyond this S-sized quick win; `ping-socket.ts` exists but wiring a user-facing latency check is not a "why am I disconnected" concern. Connected state stays minimal (info + Open Logs). Tracked as a possible Phase 2/3 enhancement.

### Tests

- `troubleshooter.test.ts`: each `ConnectionState.kind` (and both `disconnected` autoStart branches) produces the expected level, a message containing the socket path, and the expected action commands. `permission-denied` is asserted for both `platform: "win32"` and a Unix platform. No vscode needed.

---

## Feature 4 — Find related

**Goal:** pivot from code (a selection) or from an Index sidebar item to the local knowledge around it, via `searchRanked`.

### Refactor

Extend the existing `runSearch` helper in `extension.ts` to accept optional shaping without changing `Search`/`Search Selection`:

```ts
runSearch(initialValue?: string, opts?: {
  placeholder?: string;
  exclude?: (r: RankedResult) => boolean;
});
```

Add an `exclude` predicate to the pick-building path so self/duplicate rows can be filtered. Implemented as a thin filter over parsed `RankedResult`s before `rankedResultToPick`, so `search.ts` gains one small exported helper (e.g. `buildPicks(rows, exclude?)`) and keeps its existing behaviour when no predicate is passed. `Search` and `Search Selection` call sites are unchanged.

### Commands

- **`nimbus.findRelatedFromIndex`** — contributed to `view/item/context` for `viewItem == nimbusIndexItem` (the index tree). Mirrors `askAboutIndexItem`: reads `node.payload` → `parseIndexRow` → `IndexItem`, then `runSearch(item.name, { placeholder: "Related to \"{name}\"…", exclude: r => matchesSelf(r, item) })`.
- **`nimbus.findRelated`** — palette + `editor/context`. **Empty/whitespace selection (feedback 4a):** show a warning `Nimbus: select text to find related items.` and return, matching the shipped `searchSelection`/`askAboutSelection` convention. (Word-under-cursor fallback was considered and **deferred** — it adds `getWordRangeAtPosition` handling and diverges from the existing selection-required idiom; can revisit later.) Otherwise runs `runSearch(selection, { placeholder: "Related to selection…", exclude: sameName(selection) })` — framed as "related neighbors," excluding an exact-name echo of the query. Distinct from the literal `Search Selection`, which stays as-is.
- **Exclusion matching (feedback 4b):** `matchesSelf(r, item)` excludes a row that is the item itself — `url === item.url` when both carry a url (the dependable identity signal), **or** a trimmed, case-insensitive name match (`r.name.trim().toLowerCase() === item.name.trim().toLowerCase()`). `sameName(query)` applies the same trimmed/case-folded name compare. Deliberately **no** stripping of quotes/semicolons/other code delimiters — that normalization is unpredictable and risks excluding legitimately distinct items; url identity is the reliable signal for the index pivot, and a trimmed case-fold is the safe default for the selection path.

### Tests

- `search.test.ts` (or existing search tests): `buildPicks(rows, exclude)` drops excluded rows and preserves order; no predicate == current behaviour.
- `matchesSelf` / `sameName` exclusion logic: url-identity match, and trimmed/case-insensitive name match (asserts `"Auth Service"` excludes `"auth service "`); a differently-named row is kept.
- Command wiring (node.payload → IndexItem) mirrors the covered `askAboutIndexItem` pattern. Empty/whitespace selection → warning, no picker opened.

---

## Out of scope

- No cryptographic verify on a timer (badge stays head-only; the existing *Verify ledger* command owns that).
- No changes to shipped status-bar commands, `Search Selection`, or the Stop cancellation mechanism itself (only its webview feedback).
- No new settings beyond `nimbus.egress.showStatusBarBadge`.
- Walkthrough (the fifth Phase 1 item, effort M) is not part of this batch.
- **Deferred from feedback:** connected-state latency self-test (3b) and word-under-cursor fallback for Find related (4a) — both are separate features with their own surface; revisit post-batch.

## Verification

Per the repo gate (`verify-extension` skill): `bun run test`, `typecheck`, `lint`, `build`, `check-bundle`, plus the settings-doc guard for the new setting. Runtime/UI surfaces (badge, Stop marker, troubleshooter modal, Find related pickers) driven in an Extension Development Host before the PR.
