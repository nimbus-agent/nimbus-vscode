# Design — Native `@nimbus` VS Code Chat participant

**Date:** 2026-07-18
**Status:** Approved (design); pending implementation plan
**Roadmap:** Phase 2 — "Native VS Code Chat participant" (existing RPCs; no client bump)

## Overview

Register a `@nimbus` participant in VS Code's built-in Chat view, backed by the
local Nimbus agent over `askStream`. It supports the `/explain`, `/fix`, and
`/test` slash commands, `#file`/selection context, live token streaming,
mid-stream HITL consent, and clickable citations into the local index.

It is **purely additive**: the existing Ask webview panel is unchanged and keeps
its own session. The participant is a second front door that meets developers in
the chat surface they already use, and — unlike Copilot-style tools — grounds its
answers in the *local* index and honours Nimbus's egress posture.

No new Gateway capability is required. The participant rides the already-published
`@nimbus-dev/client` surface (`askStream`, `searchRanked`, and the existing HITL
router). This keeps the load-bearing non-negotiable intact: the extension never
reaches past the typed client.

## Goals

- A `@nimbus` participant that streams answers from the local agent into the
  built-in Chat view.
- Slash commands `/explain`, `/fix`, `/test` operating on the active
  selection/file.
- `#file` reference context for free-form questions.
- Visible, clickable **citations** into the local index (the differentiator).
- Mid-stream HITL consent handled through the extension's existing modal router.
- Cancellation via the Chat view's Stop control.
- Graceful, RPC-free behaviour when the Gateway is disconnected.

## Non-goals (MVP)

- Auto-applying `/fix` / `/test` output as a `WorkspaceEdit` (that is the Phase 3
  "quick-ask code-editing actions" item). MVP returns suggestions as code blocks.
- Inline chat HITL buttons (`response.button()`-driven approve/deny). MVP reuses
  the existing modal HITL surface.
- Auto-including the active editor on *free-form* turns (privacy posture — see
  "Context inputs").
- Workflow / share surfaces (Phase 4; blocked upstream).
- Any `@nimbus-dev/client` bump or new setting beyond what already exists
  (reuses `askAgent()`; citation count is a small hardcoded cap).

## Decisions (from brainstorming)

| # | Decision | Choice |
| - | -------- | ------ |
| 1 | Backing RPC | **`askStream`** — streaming-native, supports `AbortSignal` + `sessionId` + `agent`; reuses the Ask panel's proven event loop. |
| 2 | Session model | **Dedicated rolling session** — the participant threads its own `sessionId` across follow-up turns, resets on a new conversation (empty history), isolated from the Ask panel's `sessionStore`. |
| 3 | Grounding / citations | **Client-side `searchRanked` + citation chips** — makes local grounding visible and clickable. |
| 4 | HITL | **Reuse the existing modal router** — register the stream via `registerStreamWithHitl` so `hitlBatch` pops the standard modal. |
| 5 | Context inputs | **Explicit refs + slash-command selection** — free-form uses only attached `#file`; slash commands use the active selection (or whole file if none); always path-redacted + size-clamped. |

## Architecture

Follows the codebase's discipline: **pure logic behind narrow interfaces**, with
the `vscode` Chat API touched only in a thin real adapter. This mirrors how
`ChatController` (pure) relates to `real-chat-panel.ts` (vscode-facing), and keeps
everything unit-testable under Vitest with a fake sink — no running editor.

The three load-bearing rules are preserved:

1. **IPC-only / one Nimbus dependency** — all Gateway interaction is through
   `@nimbus-dev/client` (`askStream`, `searchRanked`). No new dependency.
2. **Bundled** — pure TypeScript modules; nothing new leaks into the bundle's
   externals, so `check-bundle` stays green.
3. **The `vscode` seam** — the Chat API is adapted in one thin place; pure modules
   depend on narrow interfaces only.

### Module layout

```
src/chat-participant/
  participant.ts        # pure handler: (request, deps) -> drives askStream -> emits to a ChatResponseSink
  prompt.ts             # per-command prompt building (reuses redactPath / clampContext from quick-ask.ts)
  citations.ts          # searchRanked hits -> citation descriptors (self-excluded, top-N)
  session.ts            # rolling sessionId: fresh on empty history, threaded on follow-ups
  participant-types.ts  # narrow interfaces: ChatRequestLike, ChatResponseSink, CancellationLike, ParticipantDeps
```

Plus:

- A thin real adapter (in `src/extension.ts` or a small `real-participant.ts`)
  that: calls `vscode.chat.createChatParticipant(id, handler)`; adapts
  `vscode.ChatResponseStream` → the narrow `ChatResponseSink`
  (`markdown` / `reference` / `progress` / `button`); reads `request.references`
  and the active editor selection through the existing `vscode-shim` seam; and
  bridges the `CancellationToken` → an `AbortSignal`.
- `contributes.chatParticipants` in `package.json` declaring id
  `nimbus-agent.nimbus`, name `nimbus`, a `description`, and the three commands
  (`explain`, `fix`, `test`) each with a short description. The
  `createChatParticipant` id matches the contribution id.

### Narrow interfaces (sketch)

```ts
// participant-types.ts (illustrative — finalised during implementation)
export interface ChatRequestLike {
  prompt: string;
  command?: string;                 // "explain" | "fix" | "test" | undefined
  references: ReadonlyArray<{ id: string; value: unknown }>;
  isNewConversation: boolean;       // derived from empty context.history in the adapter
}

export interface CitationRef {
  title: string;
  uri?: string;                     // resolvable local target when present
}

export interface ChatResponseSink {
  markdown(text: string): void;
  progress(text: string): void;
  reference(ref: CitationRef): void;
  button(title: string, command: string, args?: unknown[]): void;
}

export interface CancellationLike {
  isCancelled: boolean;
  onCancelled(cb: () => void): void;
}

export interface ParticipantDeps {
  client: () => ParticipantClientLike | undefined;   // undefined = disconnected
  activeEditor: () => { code: string; filePath: string; languageId: string; hasSelection: boolean } | undefined;
  session: SessionState;                              // rolling sessionId (session.ts)
  registerStreamWithHitl(streamId: string): void;
  unregisterStreamWithHitl(streamId: string): void;
  agent: () => string;                               // askAgent() setting
  citationLimit: number;                             // small cap, e.g. 5
  reconnectCommand: string;                          // command id for the disconnected button
  log: Logger;
}

export interface ParticipantClientLike {
  askStream(input: string, opts?: AskStreamOptions): AskStreamHandle;
  searchRanked(params?: RankedSearchParams): Promise<RankedSearchItem[]>;
}
```

## Request flow (per turn)

The pure `participant.ts` handler runs this sequence:

1. **Disconnected guard.** If `deps.client()` is `undefined`, emit a friendly
   "Nimbus Gateway isn't connected" markdown note plus a `button` to the existing
   reconnect/troubleshooter command, and return. No RPC is attempted.

2. **Build the prompt** (`prompt.ts`):
   - **Slash command** (`/explain` | `/fix` | `/test`): wrap the user's text in a
     command-specific template around the **active selection**, falling back to
     the **whole active file** when there is no selection (its natural target,
     like Quick Ask). Path is redacted via `redactPath`; context is clamped via
     `clampContext` / `QUICK_ASK_MAX_CONTEXT_CHARS`.
   - **Free-form** (`@nimbus <question>`): the user's text plus the contents of any
     **explicitly attached `#file`** references (redacted + clamped). No implicit
     inclusion of the active file.

3. **Citations** (`citations.ts`): call
   `searchRanked({ name: <query>, limit: citationLimit })`, self-exclude the active
   file, and emit each surviving hit as a `reference` chip. This is best-effort —
   a `searchRanked` failure is logged and swallowed, never blocking the answer.
   (Runs concurrently with / before the stream; ordering is an implementation
   detail, but citations must not delay first token materially.)

4. **Session** (`session.ts`): if the request is a new conversation
   (empty history), start fresh — omit `sessionId`. Otherwise thread the stored
   `sessionId`. After the stream's `done`, capture `done.sessionId` for the next
   turn. This state is isolated from the Ask panel's `sessionStore`.

5. **Stream** `askStream(prompt, { sessionId?, agent?, signal })`:
   - `agent` comes from the existing `askAgent()` setting (empty ⇒ omit).
   - Bridge the Chat `CancellationToken` to the `AbortSignal` (abort on cancel).
   - On the first event with a non-empty `streamId`, call
     `registerStreamWithHitl(streamId)` so `hitlBatch` events pop the standard
     modal; `unregisterStreamWithHitl` in `finally`.
   - Map events (mirroring `chat-controller.ts`): `token` → `markdown`;
     `subTaskProgress` → `progress`; `hitlBatch` → handled by the router (the
     stream pauses on the modal); `done` → persist session id, finish;
     `error` / thrown-from-iterator / **no-content** → the same careful,
     user-facing messages `chat-controller.ts` already uses (including the
     "no LLM provider" notice when a stream ends without producing content).

The handler returns a minimal `ChatResult` (no followup metadata in MVP).

## Error handling

Reuse the exact failure taxonomy already proven in `chat-controller.ts`:

- **`askStream` throws to start** → emit an error note ("couldn't start the
  request"), log, return.
- **`error` event** → emit `error.message`, log `code: message`.
- **Thrown mid-stream** (client surfaces agent failure by throwing from the
  iterator) → emit a message that nudges toward LLM-provider setup, log.
- **No content** (stream ends with no token/error/HITL) → emit the explicit
  "reached the Gateway, but no answer came back … add an LLM provider" notice.
- **`searchRanked` failure** → swallow (log at warn); the answer still streams.

## Coexistence with the Ask panel

Additive and independent:

- The Ask webview panel, its commands, and its `sessionStore` are untouched.
- The participant uses its **own** rolling session state, so the two surfaces do
  not cross-contaminate memory.
- Both share the same connection manager and the same HITL modal router.

## Testing (TDD)

Unit tests live in `test/unit/` under Vitest, mirroring
`chat-controller.test.ts` (fake `ChatResponseSink` capturing emitted items; fake
`askStream` handles as in the existing helpers; `MockClient` where useful):

- Streams `token` events to `markdown`; `subTaskProgress` to `progress`.
- `/explain`, `/fix`, `/test` prompt building; selection-vs-whole-file fallback;
  `redactPath` applied; context clamped at the limit (`prompt.ts`).
- Free-form uses attached `#file` refs only; no active-file inclusion.
- Citations rendered from `searchRanked` hits; active file self-excluded;
  `searchRanked` failure is swallowed and does not block streaming.
- Disconnected → friendly markdown + reconnect button; **no** client call.
- Cancellation aborts the stream (signal fires); HITL `streamId`
  registered then unregistered.
- Error event / thrown mid-stream / no-content each produce the right message.
- Session: fresh on empty history, threaded on follow-up, isolated from the Ask
  panel's session store.

Then the **verify-extension** skill:

- **Layer 1 gate:** `bun run typecheck && bun run lint && bun run test &&
  bun run build && bun run check-bundle` (plus settings-doc guards).
- **Layer 2 (Extension Development Host):** open the Chat view, type `@nimbus`,
  run `/explain` on a selection, confirm live streaming, citation chips, and the
  Stop control cancelling the stream; confirm the disconnected message path.

## Delivery

- Conventional-commit PR titled `feat(chat): native @nimbus VS Code Chat
  participant` → Release Please opens/updates the release PR.
- Docs: add the participant to `README.md`, note it under "Current surface" in
  `docs/architecture.md` and `CLAUDE.md`, and move the ROADMAP Phase 2 row to
  "Already shipped."

## Risks & mitigations

- **Chat API stability at engine `^1.90.0`.** `vscode.chat` +
  `contributes.chatParticipants` and `request.references` / `response.reference`
  are stable from 1.90 (May 2024). No proposed APIs are used. Mitigation: keep the
  vscode-facing adapter thin so any API delta is contained.
- **Double retrieval** (agent grounds server-side *and* we call `searchRanked`).
  Accepted: the client-side call exists to make citations *visible*; it is small
  (top-N) and best-effort. Overlap is cosmetic, not incorrect.
- **Citation targets that aren't local files** (e.g. email items). Render only
  hits with a resolvable target as clickable references; skip or plain-text the
  rest. Never fail the turn on an unresolvable citation.
- **Session identity across multiple concurrent chat conversations.** MVP keeps a
  single rolling session keyed off "is this a new conversation" (empty history).
  This is correct for the common single-conversation case; multi-conversation
  isolation is a future refinement, not an MVP blocker.
