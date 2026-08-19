# Context-grounded Ask — design

Status: approved in brainstorming 2026-08-19, not implemented.
Roadmap row: Phase 2, *Context-grounded Ask* (effort M) — the last open Phase 2
item. Rides `searchRanked` / `queryItems` + `askStream`, all already published.

## The problem

The Ask panel is the extension's oldest surface and its most context-blind one.
Every other surface built since knows what you are looking at: the context panel
follows the active editor, the SCM trio reads the diff, the diagnostic actions
read the problem under the cursor, the participant takes `#file`. Ask takes a
string.

So the one place built for a conversation is the one place where you retype —
or paste — what the editor, the index and the search results already hold. The
answers are correspondingly weaker: the model guesses at code it was never
shown, and cites nothing local.

Everything needed to fix that already ships. `searchRanked` and `queryItems`
are wired, the Index view lists items, search results are one Quick Pick away,
and `askStream` takes whatever prompt we hand it. What is missing is a way to
put those things *into* a question, and a trustworthy account of what that
sends.

## Scope

**In:** attaching workspace files, an editor selection, and local-index items to
an Ask turn; a composer button plus *Attach to Ask* entries on the surfaces that
already hold those things; attachment chips in the composer that state exactly
what will be sent; per-session persistence so a follow-up keeps its context; and
a payload assembler that refuses secret-looking and non-textual files and clamps
oversized ones, naming every omission.

**Out by choice:** typed `@`-autocomplete inside the composer (sequenced as a
follow-up once the attachment model has settled — it means building completion
UI, keyboard navigation and its own debounce inside a custom webview, which is
the largest slice of the work and the least load-bearing); attaching whole
folders; image or other binary attachments.

**Out, and worth stating:** this does not touch the `@nimbus` chat participant,
which already has `#file` through VS Code's own attachment UI. This is the
custom panel only.

## The load-bearing decision

`src/egress/gate.ts` states the rule the whole trust story rests on:

> Only the surfaces where the EXTENSION decides what is sent prompt. Ask and
> the participant record without prompting.

Ask records rather than prompts **because the payload is text the user typed**.
Attachments break that premise: the extension would assemble content the user
never wrote, which is precisely why Quick Ask, the six briefs, the SCM trio and
the diagnostic actions all raise a modal manifest.

**This design keeps Ask recording, and pays for it by making the composer a
standing preview.** Every attachment is a chip; every chip states its resolved
size; expanding one shows the exact block that will be sent; every refusal is
visible as a chip saying why. Nothing is hidden, so there is nothing a modal
would reveal — and a modal mid-conversation is the one thing the gate's own
comment says must not happen.

That trade is only honest if one property holds:

> **The chips show byte-for-byte what leaves.**

Everything in *Resolution* and *Testing* below exists to guarantee it. If that
property ever fails, this design is wrong and Ask must start prompting under a
ninth `EgressKind`. The `EgressKind` count stays at **eight**.

## Architecture

| File | Purpose | Touches `vscode` |
| --- | --- | --- |
| `src/chat/attachments.ts` | **New, pure.** The `Attachment` union, `classifyAttachment`, and `buildAttachedContext` — the single function producing both the prompt blocks and the chips. | no |
| `src/chat/chat-protocol.ts` | New message variants in both directions (attach, detach, resolved manifest). | no |
| `src/chat/chat-controller.ts` | Attach/detach handling, per-session attachment state, and the resolve-then-send sequence. | no |
| `src/chat/webview/render.ts`, `main.ts`, `styles.css` | Chip rendering and the composer button. Renders the posted manifest; computes nothing. | n/a |
| `src/chat/real-chat-panel.ts` | Only if the composer button needs new host plumbing. | **yes** |
| `src/extension.ts` | The Quick Pick command and the *Attach to Ask* entries on Index rows, search results and the editor selection. | yes |

**Reuse, not reinvention.** `src/scm/diff.ts` is pure and already exports
`isSecretPath`, `selectWithinBudget` and `truncateAtHunkBoundary`, shipped and
tested behind *Review Changes*. `attachments.ts` imports them rather than
growing a second policy that can drift from the first. Importing across feature
modules is established here — `src/context/` imports from `src/briefs/`.

## Attaching

Three entry points, all reaching the same controller message:

1. **Composer button** — opens a Quick Pick blending workspace files
   (`workspace.findFiles`) and local-index items (`searchRanked`), each row
   labelled with its source so "the file on disk" and "what the index knows"
   are never confused.
2. ***Attach to Ask* on existing surfaces** — Index view rows, search results,
   and the editor selection. These are the surfaces that already hold the thing
   you want to attach; making you find it a second time through a different
   picker is the friction this feature exists to remove.
3. **The active editor**, as a one-click "attach this file".

Attachments belong to the **chat session**, not the turn: a follow-up question
keeps them, because "now explain the other half" is the normal second question.
Detach is per-chip. Starting a new conversation clears them.

## Resolution — the property that justifies not prompting

Bytes resolve **at send**, not at attach:

1. The user hits send. The controller reads each attachment's current content.
2. `buildAttachedContext` classifies and assembles, returning `{ blocks, chips,
   omissions }` — one value, one pass.
3. The controller **posts the resolved manifest to the webview before the
   request goes out**, so the chips render what was actually assembled.
4. Only then does the prompt reach `askStream` through the gated client, which
   records it as it does today.

Resolving at send is what keeps a file edited after attaching from sending a
stale copy — the panel would otherwise be describing work you have moved past.
The alternative, snapshotting at attach, makes the chips trivially accurate
about a payload that no longer matches the workspace.

Chips before send show a **provisional** size, marked as such. This spec would
rather say "about 4 KB, measured when attached" than assert a number it has not
re-read.

## The payload

Attached blocks are prepended to the typed question in a delimited section, each
block naming its source (repo-relative path, or the index item's service and
name). The user's own text is last, so the question reads as the instruction.

Refusals and clamping reuse the SCM trio's rules **and its precedence** —
secret beats non-textual beats too-large, because an all-`.env` attachment is
not usefully described as "binary", and a huge file containing binary is more
actionably reported as too large:

| Case | Behaviour | Chip |
| --- | --- | --- |
| Possible secret (`isSecretPath`) | not sent at all | `possible secret · not sent` |
| Binary / non-textual | not sent at all | `binary · not sent` |
| Over budget | clamped head sent | `clamped · 12 KB of 400 KB sent` |
| Index item | its stored snippet and metadata, no working-tree read | `from index` |
| Every attachment refused | the turn still sends the typed question | a line saying nothing was attached |

A refused attachment is never silently dropped, and never blocks the question.

## Degraded states

| State | Behaviour |
| --- | --- |
| Disconnected | the composer button still opens, but index rows are absent and the picker says so; file attachment is local and keeps working |
| A file deleted between attach and send | resolves to a refusal chip naming it; the turn proceeds |
| `searchRanked` throws while picking | the picker shows files only, with a row explaining the index is unavailable |
| Attachment list empty | identical to today's Ask in every respect |

## Testing

Pure, in `test/unit/chat-attachments.test.ts`:

- **the invariant** — for a mixed attachment set, the concatenated `blocks`
  equal, byte for byte, what the chips report. This is the test that earns the
  decision not to prompt; if it cannot be written, the decision is wrong.
- refusal precedence: secret beats non-textual beats too-large;
- clamping exactly at the budget boundary, and one byte either side;
- an entirely-refused set still yields a sendable prompt;
- an index item contributes no filesystem read.

Controller, over stubs: attach → chips posted; detach; attachments surviving a
turn; cleared on new conversation; the resolved manifest posted **before**
`askStream` is called (assert ordering, not just occurrence).

Guards: `test/unit/egress-choke-point.test.ts` must stay green **unmodified** —
`askStream` still flows only through `gated-client.ts`, and no new outbound path
appears. No new setting, so `check-settings-docs` is untouched.

Finally an ExTester spec in `test/ui/specs/`, because chips are UI and the
repo's own history says an unexercised surface is an unverified one: attach a
file, see its chip, send, see the chip's count match the ledger row.

## Delivery

One worktree, `worktree-context-grounded-ask`, staged as reviewable commits:

1. `feat(chat): pure attachment assembler with refusal and clamping`
2. `feat(chat): attach and detach context in the Ask panel`
3. `feat(chat): attach to Ask from the index, search and the editor`
4. `test(ui): drive attachments in a real editor`
5. `docs: record context-grounded Ask`

## Open questions

1. **Budget.** The SCM trio's budget was chosen for diffs. A single attached
   file probably deserves a different one; pick it in the plan, state it in the
   chip, and revisit after the first real use.
2. **Ledger legibility.** An attached turn's ledger row grows by the blocks. If
   that makes the Egress viewer unreadable, the fix belongs in that viewer, not
   in what we send.
3. **Index-item freshness.** An index snippet can lag the working tree. The chip
   says `from index`; whether it should also say how stale is unknown until the
   surface is used.
