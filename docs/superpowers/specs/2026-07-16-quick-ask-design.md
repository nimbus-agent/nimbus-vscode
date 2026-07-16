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
2. An input box prompts: *"Ask Nimbus about this code"*.
3. Context attached = **the selection if one exists, otherwise the whole active
   file**.
4. `client.agentInvoke(prompt, { agent, stream: false })` runs, wrapped in a
   progress spinner.
5. The reply opens in a **read-only markdown tab** ("Nimbus reply.md"). No chat
   panel is opened and no source is mutated.

## Components / files

- **`src/quick-ask.ts`** (new, pure — imports no `vscode`): the testable core.
  - `buildQuickAskPrompt(input: { question: string; code: string; filePath: string; languageId: string }): string`
    — composes the question followed by a fenced code block labelled with the
    file path and language. The language tag on the fence is the `languageId`.
    When `code` is empty/blank after trimming, the fenced block (and file-path
    line) are omitted entirely and only the question is returned.
  - `extractReply(result: unknown): string | undefined` — pulls the answer from
    `agentInvoke`'s `{ reply?: string } & Record<string, unknown>` result.
    Prefers a non-empty string `reply`; returns `undefined` when `reply` is
    missing, not a string, or blank after trimming. Parsed defensively via the
    existing `asRecord` / `asNonEmptyString` helpers (`src/sidebar/parse-helpers.ts`).
- **`src/extension.ts`** — register `nimbus.quickAsk`:
  1. Resolve `deps.window.activeTextEditor`; if none, show an error and return.
  2. Determine context: non-empty selection text if present, else the whole
     document text. Capture `document.fileName` (or a relative label) and
     `document.languageId`.
  3. Show the input box; return on cancel/empty.
  4. Guard connection via the existing `nimbus()` accessor; on `undefined`, show
     the standard "not connected to Gateway" error and return.
  5. Call `client.agentInvoke(buildQuickAskPrompt(...), { agent, stream: false })`
     inside `withProgress`. `agent` comes from `settings.askAgent()` and is
     passed only when non-empty.
  6. `extractReply(result)`; if defined, render via the read-only-doc opener with
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
- **Progress:** keep a progress spinner via the new shim `withProgress` wrapper.

## Error / edge handling

- No active editor → error message, no call.
- Empty/whitespace context (e.g. empty file, no selection resolving to empty) →
  still allowed; `buildQuickAskPrompt` omits the fenced block and sends the
  question alone. The prompt builder must not crash on empty `code`.
- Not connected → standard Gateway-not-connected error, no call.
- `agentInvoke` rejects → caught; show an error message with the reason (mirrors
  the search failure pattern). No unhandled rejection.
- Blank/absent `reply` → information message, no empty doc opened.

## Testing

- **`test/unit/quick-ask.test.ts`** (pure):
  - `buildQuickAskPrompt`: includes the question, the file path, the language
    fence tag, and the code; handles empty `code` without crashing.
  - `extractReply`: returns the string for a present non-empty `reply`; returns
    `undefined` for missing / non-string / blank-after-trim replies.
- **`test/unit/extension.test.ts`**:
  - Quick-ask with a selection calls `agentInvoke` with a prompt containing the
    selected text; the reply is shown via the (stubbed) doc opener.
  - No-selection case attaches the whole-file text.
  - Not-connected shows the error and never calls `agentInvoke`.
  - Blank reply → information message, no doc opened.

## Out of scope (v1)

- Code-editing / apply actions (WorkspaceEdit + diff preview + undo).
- Streaming output.
- Multi-turn / session continuation from a quick-ask.
- A curated preset action menu (Explain / Fix / Refactor).
- Renaming `openReadonlyJson` → `openReadonlyDoc` (separate cleanup).

All are natural follow-ups on top of this seam.
