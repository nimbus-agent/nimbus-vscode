# "Preview what leaves" pre-flight — design

**Date:** 2026-07-30
**Status:** approved, ready for an implementation plan
**Roadmap:** Phase 2 — `docs/ROADMAP.md:93`

## What this is

A gate, not a viewer. Before the extension sends anything to the agent, every
agent-bound call passes through one seam that can render exactly what would
leave — with paths already redacted — and can refuse to send it.

The transparency is the payoff. The choke point is the point.

## The finding it answers

The whole-branch review of the dev-workflow trio concluded:

> The one structural weakness is that there is no single choke point asserting
> "nothing absolute crosses into `agentInvoke`" — it is enforced by four
> independent call sites doing the right thing. That is adequate today and
> well-tested, but a fifth SCM command added later has no guardrail.

This design supplies the choke point, and makes bypassing it fail at compile
time and again in CI.

## Corrections to the brief

Two premises in the original framing did not survive contact with the repo.

**There are five outbound paths, not four.** `src/lm-tools/lm-tools.ts:72`
(`runNimbusAskTool`) calls `agentInvoke`. It shipped with
`contributes.languageModelTools`, so Copilot Chat — or any other agent
extension — can drive Nimbus egress with no Nimbus UI on screen and no user
keystroke in the loop. That is the "fifth call site with no guardrail" the
review warned about, already present.

**No client bump is needed, and none is blocked.** The pinned
`@nimbus-dev/client` is `^0.12.1`, not `0.5.0`; Phase 4 is no longer blocked
(`docs/ROADMAP.md:35`). More to the point, this feature needs **zero RPCs** —
including the `local` + `egressList` the roadmap lists as enabling. A
*pre-flight* view describes a payload the extension is already holding. Like the
troubleshooter and the walkthrough, it works while disconnected.

## Scope

| Surface | Call | Site | Gate behaviour |
|---|---|---|---|
| Quick Ask | `agentInvoke` | `src/extension.ts:804` | **prompts** — extension assembles the context |
| SCM trio (4 commands) | `agentInvoke` | `src/scm/commands.ts:263` | **prompts** — extension assembles the context |
| Ask panel | `askStream` | `src/chat/chat-controller.ts:156` | routes, records, does not prompt |
| `@nimbus` participant | `askStream` | `src/chat-participant/participant.ts:221` | routes, records, does not prompt |
| LM tools (`nimbus_ask`) | `agentInvoke` | `src/lm-tools/lm-tools.ts:72` | native `prepareInvocation` confirmation card |

All five route through the seam, so no call site can bypass it. Only the two
where the **extension** chooses the content prompt by default — those carry the
surprise risk. The other two are text the user just typed; prompting there would
be pure nag.

`nimbus_search` is out of scope: `searchRanked` hits the local index, not the
agent.

## Architecture

New directory `src/egress/`:

| Module | Purity | Job |
|---|---|---|
| `preflight.ts` | pure | `EgressPayload` + three renderers |
| `gate.ts` | vscode-free, injected deps | the decision table |
| `gated-client.ts` | vscode-free | the only module in `src/` that may call `.agentInvoke(` / `.askStream(` |
| `skip-store.ts` | memento-backed | per-surface "don't ask again", mirrors `src/chat/session-store.ts` |

### The payload

```ts
export type EgressKind = "quickAsk" | "scm" | "ask" | "participant" | "lmTool";

export interface EgressFile {
  /** ALREADY redacted by the call site — a basename or repo-relative path. */
  name: string;
  /** "whole file", "selected code", "staged + unstaged" */
  note: string;
}

export interface EgressPayload {
  kind: EgressKind;
  /** Human label: "Review Changes", "Quick Ask". */
  action: string;
  /** Verbatim — exactly the string that would be sent. */
  prompt: string;
  files: readonly EgressFile[];
  /** What was deliberately left out: "2 files omitted (diff too large)". */
  omissions: readonly string[];
  /**
   * Absolute paths held LOCALLY for the leak check — the picked repo's
   * rootPath plus every open workspace folder. Never sent.
   */
  roots: readonly string[];
}

/**
 * What a call site supplies. The wrapper adds `kind` (fixed per surface) and
 * `prompt` (the string it was handed), so a call site can describe its context
 * but cannot misreport which surface it is or what text it is sending.
 */
export type EgressMeta = Omit<EgressPayload, "kind" | "prompt">;
```

### The gate

```ts
export type GateDecision = "send" | "cancel";

export interface EgressGate {
  /** Prompting kinds. Awaited. */
  check(payload: EgressPayload): Promise<GateDecision>;
  /** Pass-through kinds. Synchronous — see below. */
  record(payload: EgressPayload): void;
  lastPayload(): EgressPayload | undefined;
}
```

`record` is separate from `check` because **`askStream` returns its handle
synchronously**. An async gate cannot sit in front of it without changing that
contract — and does not need to, since Ask and the participant are pass-through
by decision. Which method runs is chosen inside `gated-client.ts` from the
surface's fixed kind, never at a call site.

Decision table for `check`:

1. Workspace is untrusted → **always prompt**, ignore any skip. Restricted Mode
   is exactly when you want the gate.
2. The surface's skip flag is set → `send`.
3. Otherwise prompt.

The prompt is `showWarningMessage(title, { modal: true, detail }, …)` with three
items — VS Code adds Cancel to a modal automatically:

- **Send** → `send`
- **Show full text** → dismiss, open the verbatim prompt in the read-only tab,
  then **re-ask with a non-modal notification** (`Send` / `Cancel`)
- **Always send &lt;surface&gt; here** → set the skip, then `send`
- Cancel / Esc / dismissed → `cancel`

**The re-ask must not be modal.** A VS Code modal blocks the whole workbench, so
re-showing one over the freshly opened tab would leave the user unable to
scroll, search, or copy the very text they asked to see. The second prompt is a
plain notification, which floats and lets the editor be used. This costs nothing
architecturally: what makes this a gate is that the code *awaits* a decision
before calling the client, not that the dialog is blocking.

The first modal stays modal. It is a self-contained summary — there is nothing
behind it to read, and a send should interrupt.

A dismissed notification is `cancel`. The gate fails closed on every ambiguous
outcome.

### The guardrail — two mechanisms

**Type-level.** The gated client's `agentInvoke` takes a third *required*
argument, `meta: EgressMeta`. The raw `NimbusClient` therefore no longer
satisfies `ScmClientLike` / `LmToolsClientLike` structurally: the ungated client
cannot be wired in by accident. `createGatedClient(raw, gate, kind)` is
instantiated **per surface with its kind fixed**, so a fifth SCM command added
later inherits the gate by construction and has no way to select the wrong kind.

**CI-level.** `test/unit/egress-choke-point.test.ts` walks `src/` and asserts
that `gated-client.ts` is the only file containing `.agentInvoke(` or
`.askStream(`. Modelled on the existing `test/unit/no-raw-sql-guard.test.ts`,
including its trick of matching the *call* shape (leading dot) so interface
declarations do not false-positive.

Together these replace "four developers doing the right thing" with a rule the
compiler and CI both hold.

## What the manifest says

One pure builder; three renderings.

**Modal detail** (`summarizeEgress`):

```
Review Changes — 12 files, 18,412 characters

  auth-service.ts        staged + unstaged
  session-store.ts       staged + unstaged
  routes.ts              staged + unstaged
  … and 9 more

  Paths sent as file names only — no directories,
  no repository path.
  2 files omitted (diff too large).
  1 possible secret file skipped.
```

**Read-only tab** (`renderFullEgress`): the same header, the complete file list,
then the verbatim prompt.

**LM-tools card** (`confirmationMessage`): `{ title, message }` for
`prepareInvocation`, rendered inline by the calling chat.

Three rules:

**The gate asserts redaction; it does not perform it.** `redactPath`
(`src/quick-ask.ts`) and `relativeOrBasename` (`src/scm/paths.ts`) keep their
call sites. A second implementation inside the gate would diverge and let call
sites get lazy.

**The leak check is a non-negotiable made executable.** We hold each root as an
exact string, so searching the assembled prompt for those literals has no false
positives — unlike a "looks like a path" regex, which fires on every
`#!/usr/bin/env` in a diff. On a hit the modal warns, and says plainly that
Nimbus did not add it: it is inside the user's own changes. Today "never send an
absolute path" is enforced only by a reviewer noticing.

What the check searches for:

| Needle | Why |
|---|---|
| The picked repo's `rootPath` | The original non-negotiable |
| Every open workspace folder | Multi-root windows, **and** Quick Ask — which has no repo at all, so a root-only check would have skipped it entirely |
| `os.homedir()` | The highest-value needle: it carries the OS username |
| Each of the above with `/` and `\` swapped | On Windows the same path appears both ways, often within one payload |

**Not** `os.tmpdir()`. On Linux that is `/tmp` — a string that legitimately
appears in shebangs, scripts, test fixtures, and documentation. Matching it
would break the zero-false-positive property that makes the warning worth
showing at all, and a gate that cries wolf trains people to click through it.
On Windows `tmpdir()` lives under `homedir()`, so it is largely covered anyway.

The checker is pure and takes needles as input strings. The caller resolves
`os.homedir()` and the workspace folders; `node:os` never appears in a pure
module.

**Omissions are part of what leaves.** `collectDiff` already computes
`omittedTooLarge`, `skippedSecret`, `nonTextual`, and `warnOmissions`
(`src/scm/commands.ts:215`) already surfaces two of them as separate toasts.
They move into the manifest, where they belong — "what leaves" is incomplete
without "and what didn't." The toasts stay, unchanged, for the paths that skip
the modal.

**No per-file statistics.** `CollectedDiff` (`src/scm/commands.ts:92`) carries
path lists and one rendered `block`; there are no per-file sizes or ± line
counts. Deriving them means parsing the unified diff, which `collectDiff`
explicitly refuses to do ("Nothing here parses a unified diff: paths come from
git, not from headers"). The manifest lists names, and takes its total from
`block.length`. Elision is the first 5 in `collectDiff`'s order, then
`… and N more`; the complete list is always one click away.

## "Don't ask again"

Two independent flags in `ctx.workspaceState`, mirroring `session-store.ts`:

```
nimbus.preflight.skip.quickAsk
nimbus.preflight.skip.scm
```

**Per surface**, so approving a 30-line Quick Ask never silently disarms the
gate on a 12-file whole-repo diff — the case the gate exists for.

**Per workspace**, so trust does not follow you into the next repository you
open. A client repo opened next week starts by prompting again.

**Never honoured in an untrusted workspace.**

`nimbus.resetPreflightPrompts` clears both — the way back from an over-eager
*Always send*.

No setting is added. A global on/off switch would let one `never` apply to every
repository forever, which is the wrong default for a trust surface, and it would
duplicate state that already has a home. `check-settings-docs` is therefore
unaffected.

## Wiring

| Surface | Change |
|---|---|
| Quick Ask | `extension.ts:804` → gated call. Meta: one file, note `"selected code"` / `"whole file"`, an omission entry when `truncated` |
| SCM trio | `commands.ts:252` `invoke()` gains a `meta` parameter. One shared helper, so all four commands — and any fifth — are covered. A pure `collectedToMeta(collected)` maps `CollectedDiff` onto the manifest |
| Ask panel | `chat-controller.ts` deps receive the gated client; `record()` fires inside it. **No call-site diff** |
| Participant | same |
| LM tools | `prepareInvocation` added to `real-lm-tools.ts` (already coverage-excluded glue); its message comes from pure `confirmationMessage()`, **including the leak-check warning** (see below). Kind `lmTool` is record-only at `invoke` time — the confirmation happened upstream, and VS Code remembers *Continue* for the session itself |

### The leak check runs on the LM-tools path too

We author the confirmation card — `confirmationMessages: { title, message }` is
ours — so this is not a generic host dialog we are stuck with. But marking the
kind record-only would mean the leak check never runs there, and the question
text on that path is written by *another model*, which may well quote an
absolute path it read from disk. So `prepareInvocation` builds the payload and
runs the same check, folding any warning into the card's message before the user
is asked.

**Unverified, for the Extension Development Host pass:** `prepareInvocation` is
optional in the VS Code LM-tool API, and I have not confirmed that every
invocation route calls it. If a route skips it, the card never appears and only
`record` runs on that path. Worth checking against a real Copilot Chat turn
before treating this path as gated rather than merely observed.

`extension.ts` builds the gate once and hands each surface its own fixed-kind
wrapper.

## Cancellation

The gated `agentInvoke` throws a sentinel `EgressCancelled`; `isEgressCancelled(e)`
in each catch returns silently.

A return code will not do: `invoke()` currently returns `string | undefined` and
treats `undefined` as *"the agent returned no reply"*
(`src/scm/commands.ts:266`), so a cancelled send would show the wrong message.
The sentinel keeps all five signatures unchanged, and SCM already wraps every
handler in `contain()` (`src/scm/commands.ts:241`), so that path is a two-line
change.

Per surface: Quick Ask and the SCM trio return silently, exactly as they do when
the user dismisses a Quick Pick. The LM-tools path never cancels here — its
Cancel is handled by VS Code before `invoke` runs.

## New user-visible surface

- `nimbus.showLastOutbound` — **Nimbus: Show Last Outbound Payload**. Renders
  `gate.lastPayload()` through `renderFullEgress` into the read-only tab.
  Answers "what did I just send?" without the ledger, and gives the
  pass-through paths a payoff for routing.
- `nimbus.resetPreflightPrompts` — **Nimbus: Reset Egress Preview Prompts**.

`lastPayload` is in-memory only; it does not survive a window reload. The signed
ledger is the durable record, and this must not become a second one.

### Retention

`lastPayload` is a single slot, replaced on every send — there is no list to
accumulate. Its size is already bounded upstream: Quick Ask clamps at
`QUICK_ASK_MAX_CONTEXT_CHARS` (50,000) and `collectDiff` drops files that blow
its budget, so the multi-megabyte payload is not reachable on the prompting
paths.

The real retention is elsewhere. `createReadonlyJsonOpener`
(`src/extension.ts:1141`) keeps its rendered documents in a `Map` capped at
`MAX_DOCS = 50` so the content provider can still serve a tab the user left
open. Routing full outbound payloads through the shared instance would park up
to 50 of the largest strings this extension ever builds there for the rest of
the session, interleaved with audit entries.

So the preview gets its **own** opener instance with a small cap.
`createReadonlyJsonOpener` takes `maxDocs` as a parameter (default 50,
preserving today's behaviour); the preview passes 5. Anything older than the
last handful of previews is not worth a megabyte.

## Shim change

Two new members on `WorkspaceApi` (`src/vscode-shim.ts:132`, which today carries
only `getConfiguration` and `onDidChangeConfiguration`):

- `isTrusted: boolean` — the Restricted-Mode override
- `workspaceFolders: readonly { uri: { fsPath: string } }[] | undefined` — the
  leak check's needles

Both added to `test/unit/vscode-stub.ts` alongside.

`createReadonlyJsonOpener` (`src/extension.ts:1141`) gains a `maxDocs`
parameter, defaulting to 50.

## Testing

| File | Covers |
|---|---|
| `egress-preflight.test.ts` | renderers: elision at 5, zero-file case, omissions, leak warning, LM card |
| `egress-leak-check.test.ts` | each needle kind; both separator forms; **`/tmp` in a shebang does not fire**; no needles → no warning |
| `egress-gate.test.ts` | decision table × trusted/untrusted × skip set/unset; the *Show full text* path (**second prompt is non-modal**, dismissal is `cancel`); Cancel |
| `egress-gated-client.test.ts` | args forwarded; **on cancel the raw client is never called**; `askStream` still returns synchronously |
| `egress-skip-store.test.ts` | memento round-trip, per-surface isolation |
| `egress-choke-point.test.ts` | the allowlist grep guard |

Extended: `scm-commands.test.ts` (cancel is silent, meta is populated from
`CollectedDiff`), `extension.test.ts` (wiring, the two new commands), and the
`manifest-*.test.ts` family for the `contributes.commands` entries.

**The choke-point guard test lands last.** It fails by definition until every
path is migrated, which makes it a real completion signal rather than a
formality.

## Non-goals

- No new RPCs, and no `@nimbus-dev/client` bump.
- No webview. The richer per-file panel stays available later behind the same
  seam; a webview cannot block a call the way a modal can, and this is a gate.
- No durable log of outbound payloads. The egress ledger is the record.
- No prompting on the Ask panel or the participant.
- No change to `redactPath` / `relativeOrBasename` or to any existing toast.
- No settings.

## Documentation to update

- `docs/architecture.md` — the seam and the two guardrail mechanisms
- `docs/ROADMAP.md` — move the Phase 2 row to **Already shipped**, and correct
  its enabling-RPC column to "none"
- `CLAUDE.md` — surface list, and `src/egress/` in the layout section

## Gate

```
bun run test && bun run typecheck && bun run lint && bun run build \
  && bun run check-bundle && bun run check-vsix-contents && bun run check-settings-docs
```

Plus the `verify-extension` skill's Extension Development Host pass. Four things
cannot be settled from a unit test:

1. The modal's real button order and its automatic Cancel.
2. That the tab opened by *Show full text* is genuinely usable — scrollable and
   searchable — with the non-modal re-ask on screen.
3. Whether `prepareInvocation` is called on every LM-tool invocation route
   (see above).
4. That an untrusted workspace really does prompt despite a set skip.
