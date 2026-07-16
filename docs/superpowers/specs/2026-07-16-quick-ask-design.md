# Design: `nimbus.quickAsk` — one-shot editor quick-ask

**Date:** 2026-07-16
**Status:** Approved (pending implementation)

---

## Context

The extension already has `nimbus.askAboutSelection`, which sends a selection to
the **full streaming chat panel**. The gap this fills is a *lightweight,
one-shot* path: ask a question about the current code and get an answer back
**without opening the chat panel**.

This is enabled by an unexploited capability already present in
`@nimbus-dev/client` 0.4.0: `agentInvoke(input, { stream?, sessionId?, agent? })
: Promise<{ reply?: string } & Record<string, unknown>>` — a non-streaming,
one-shot agent call. No client bump and no upstream Gateway work is required.

The presentation reuses an existing seam: `createReadonlyJsonOpener` in
`extension.ts` is a *generic* read-only virtual-document opener — the rendered
language is derived from the title's file extension. Passing a `.md` title
renders the reply as markdown with no new machinery.

## UX flow

1. An editor is open → Command Palette or editor right-click → **"Nimbus: Quick
   ask…"** (enabled on `editorTextFocus`).
2. Context is resolved first = **the selection if one exists, otherwise the whole
   active file** — then clamped to a max size (an oversized whole-file context is
   truncated with a visible marker and a warning; see Error / edge handling).
3. The connection is checked **before** prompting (`nimbus()`); if not connected,
   an error is shown and nothing else happens — the user is never asked to type a
   question only to fail on submit.
4. A **scope-aware** input box prompts (*"Ask a question about the selected code"*
   or *"…about the active file"*) and rejects a blank/whitespace-only question via
   `validateInput`.
5. `client.agentInvoke(prompt, { agent, stream: false })` runs, wrapped in a
   **non-cancellable** progress spinner (see Decisions for why not cancellable).
6. The reply opens in a **read-only markdown preview tab** ("Nimbus reply.md").
   Because it opens in preview mode, a subsequent quick-ask reuses the same tab
   slot rather than accumulating tabs. No chat panel is opened and no source is
   mutated.

## Components / files

- **`src/quick-ask.ts`** (new, pure — imports no `vscode`): the testable core.
  - `QUICK_ASK_MAX_CONTEXT_CHARS = 50_000` — the context-size cap.
  - `clampContext(code: string, max: number): { code: string; truncated: boolean }`
    — returns `code` unchanged with `truncated: false` when within `max`;
    otherwise returns the first `max` characters with `truncated: true`.
  - `buildQuickAskPrompt(input: { question: string; code: string; filePath: string; languageId: string; truncated?: boolean }): string`
    — composes the question followed by a fenced code block labelled with the
    file path and language. The language tag on the fence is the `languageId`;
    when `truncated` is true the file-path line is marked `(truncated)`. When
    `code` is empty/blank after trimming, the fenced block (and file-path line)
    are omitted entirely and only the question is returned.
  - `extractReply(result: unknown): string | undefined` — pulls the answer from
    `agentInvoke`'s `{ reply?: string } & Record<string, unknown>` result.
    Prefers a non-empty string `reply`; returns `undefined` when `reply` is
    missing, not a string, or blank after trimming. Parsed defensively via the
    existing `asRecord` / `asNonEmptyString` helpers (`src/sidebar/parse-helpers.ts`).
- **`src/extension.ts`** — register `nimbus.quickAsk`:
  1. Resolve `deps.window.activeTextEditor`; if none, show an error and return.
  2. Determine context and scope: a non-empty selection if present (`scope =
     "selected code"`), else the whole document text (`scope = "active file"`).
     Capture `document.fileName` (or a relative label) and `document.languageId`.
  3. `clampContext(context, QUICK_ASK_MAX_CONTEXT_CHARS)`; if `truncated`, show a
     warning message that the context was truncated.
  4. **Guard the connection first** via the existing `nimbus()` accessor; on
     `undefined`, show the standard "not connected to Gateway" error and return —
     before any input prompt.
  5. Show the input box, its `prompt`/`placeholder` naming the resolved `scope`,
     with `validateInput` rejecting a blank/whitespace-only question. Return on
     cancel.
  6. Call `client.agentInvoke(buildQuickAskPrompt(...), { agent, stream: false })`
     inside a non-cancellable `withProgress`. `agent` comes from
     `settings.askAgent()` and is passed only when non-empty.
  7. `extractReply(result)`; if defined, render via the read-only-doc opener with
     a `.md` title; if `undefined`, show an information message that the agent
     returned no reply.
- **`package.json`** — add the `nimbus.quickAsk` command, an `editor/context`
  menu entry (`when: editorTextFocus`), and a visible `commandPalette` entry.
- **`src/vscode-shim.ts`** — add `withProgress` to `WindowApi` (a small typed
  wrapper over `vscode.window.withProgress`) so the spinner stays behind the
  shim seam. The unit stub gets a pass-through implementation (runs the task
  immediately).

## Decisions (defaults)

- **Agent:** reuse `settings.askAgent()` (blank → Gateway default), consistent
  with the chat panel's agent resolution. No per-call agent picker.
- **Stateless:** no `sessionId` is passed — each quick-ask is independent. (The
  seam leaves room to thread a session later; not built now.)
- **Reply rendering:** reuse the existing read-only-doc opener as-is with a `.md`
  title, plus a one-line comment noting it is now general. The rename to
  `openReadonlyDoc` (which would touch the audit/egress callers and their tests)
  is **deferred** to a separate cleanup.
- **Progress / cancellation:** keep a **non-cancellable** progress spinner via the
  new shim `withProgress` wrapper. True cancellation is not wireable in client
  0.4.0 — `agentInvoke(input, { stream?, sessionId?, agent? })` takes no
  `AbortSignal`/cancel argument, and a one-shot call (`stream: false`) returns no
  `streamId` for `cancelStream`. A `cancellable: true` spinner that cannot abort
  the upstream request would be misleading, so it is omitted; real cancellation
  is a follow-up gated on a client that exposes an abort mechanism.
- **Reply tab lifecycle:** reuse the existing opener, which opens each reply at a
  unique virtual URI with `preview: true`. VS Code preview tabs reuse the same
  tab slot, so a subsequent quick-ask replaces the prior preview rather than
  accumulating tabs (unless the user pinned or edited it). Each reply is a fresh
  URI, so no `onDidChange` refresh machinery is needed. This matches the existing
  audit/egress detail behaviour.

## Error / edge handling

- No active editor → error message, no call.
- Oversized context (whole-file mode on a very large/minified file) →
  `clampContext` truncates to `QUICK_ASK_MAX_CONTEXT_CHARS`, the prompt marks the
  fence `(truncated)`, and a warning message tells the user the context was
  truncated. The request still proceeds with the clamped context.
- Empty/whitespace context (e.g. empty file, no selection resolving to empty) →
  still allowed; `buildQuickAskPrompt` omits the fenced block and sends the
  question alone. The prompt builder must not crash on empty `code`.
- Not connected → standard Gateway-not-connected error, shown **before** the
  input box; no call.
- Blank question → `validateInput` blocks submission with a "Please enter a
  question" message; the user can amend or cancel.
- `agentInvoke` rejects → caught; show an error message with the reason (mirrors
  the search failure pattern). No unhandled rejection.
- Blank/absent `reply` → information message, no empty doc opened.

## Testing

- **`test/unit/quick-ask.test.ts`** (pure):
  - `clampContext`: returns the input unchanged (`truncated: false`) within the
    cap; truncates to `max` with `truncated: true` when over.
  - `buildQuickAskPrompt`: includes the question, the file path, the language
    fence tag, and the code; marks the header `(truncated)` when `truncated` is
    true; omits the fenced block for empty `code` without crashing.
  - `extractReply`: returns the string for a present non-empty `reply`; returns
    `undefined` for missing / non-string / blank-after-trim replies.
- **`test/unit/extension.test.ts`**:
  - Quick-ask with a selection calls `agentInvoke` with a prompt containing the
    selected text; the reply is shown via the (stubbed) doc opener.
  - No-selection case attaches the whole-file text.
  - Not-connected shows the error **before** any input box and never calls
    `agentInvoke`.
  - Blank reply → information message, no doc opened.

## Out of scope (v1)

- Code-editing / apply actions (WorkspaceEdit + diff preview + undo).
- Streaming output.
- Multi-turn / session continuation from a quick-ask.
- A curated preset action menu (Explain / Fix / Refactor).
- True request cancellation (blocked by client 0.4.0 — no abort mechanism on
  one-shot `agentInvoke`).
- Renaming `openReadonlyJson` → `openReadonlyDoc` (separate cleanup).

All are natural follow-ups on top of this seam.
