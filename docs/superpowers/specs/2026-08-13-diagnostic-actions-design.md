# Diagnostic actions — design

**Date:** 2026-08-13
**Status:** approved, not yet implemented
**Repos:** `nimbus-vscode` only — no Gateway or client work

## Problem

The roadmap's own conclusion, after the built-in briefs closed the reach gap, is
that reach is no longer what is missing:

> The editor is the surface with the **best context and the shortest path to
> action**. […] That context is underused today […] nothing in the editor
> *offers* an agent based on what you are looking at.

Everything the extension does today is *invoked*: the user opens a palette,
right-clicks, types `@nimbus`, or clicks a sidebar row. A diagnostic is the
cheapest place to invert that. VS Code already knows something is wrong, already
knows exactly where, and already renders a lightbulb the user reaches for by
reflex. Nimbus can put three things behind it that no linter can: an
explanation, a suggested fix, and — the one only a local index can answer —
*has this gone wrong here before?*

This spec covers the first slice of "offer agents from context". The Ambient
context panel (Phase 2, L) is the end state; this is deliberately not it.

## Scope

**In scope:** three command-only code actions on a diagnostic, the pure modules
behind them, one new pre-flight gate kind, one setting, and their tests.

**Out of scope, on purpose:**

- **The ambient context panel.** Its design problems — what counts as a change
  worth re-suggesting on, how noisy it is, how it behaves while disconnected —
  are untouched here.
- **A general `suggest(context) → agents` engine.** One consumer and one context
  kind do not justify one. The panel is the second consumer; it extracts the
  engine when it exists, not before.
- **Applying edits.** See the constraint below.
- **Failure context** (stack frame → indexed CI run) and the reference-aware
  pivot. Adjacent Phase 3 rows, separate specs.

This slice does pull one Phase 3 row forward — *quick-ask code-editing actions*
— because the fix action is that row, scoped to a diagnostic. The roadmap row
should be updated to say so when this lands rather than left to look untouched.

## Guiding constraints

1. **Never an applied edit.** `CLAUDE.md` states the rule for the SCM trio —
   "output always a suggestion, never an applied edit" — and this surface is
   where it is easiest to break, because VS Code's `CodeAction` has an `edit`
   field that is applied the instant the user selects it. **Every action here
   carries a `command` and no `edit`.** Selecting one runs a Nimbus command that
   *shows* something; the user applies it with the diff editor's own controls.
   This is not a stylistic preference — a code action with an `edit` would also
   route around the pre-flight gate's cancel path, since the edit would already
   be staged before the model was ever asked.
2. **The choke point holds.** Both model-bound actions call `agentInvoke`
   through `src/egress/gated-client.ts`, the only module in `src/` permitted to
   touch it (`test/unit/egress-choke-point.test.ts` enforces this).
3. **`vscode` only through the seam.** The provider registration lives in one
   glue file, mirroring `real-hover.ts`, `real-git.ts`, `real-participant.ts`.
4. **No new RPC.** `agentInvoke` and `searchRanked` are both already pinned.

---

## Part 1 — The three actions

| Action | Command | Call | Output | Gate |
| --- | --- | --- | --- | --- |
| Explain this problem | `nimbus.diagnosticExplain` | `agentInvoke` | read-only tab | prompts, kind `"diagnostic"` |
| Suggest a fix | `nimbus.diagnosticFix` | `agentInvoke` | diff vs the real file | prompts, kind `"diagnostic"` |
| Find prior occurrences | `nimbus.diagnosticPriorOccurrences` | `searchRanked` | Quick Pick | **none** |

### Explain

Sends the diagnostic (message, severity, source, code), the file's basename, and
a line-budgeted snippet around the range. The reply opens in a read-only tab via
the existing `openReadonly` dep — the Quick Ask and brief precedent, so no new
output machinery.

### Suggest a fix

Sends the same context with a prompt asking for the replacement region only.
Presentation reuses `src/scm/generate.ts` wholesale rather than growing a second
splice path:

- `extractCode(reply)` strips the fence.
- `isWholeFileRewrite(...)` decides whether the reply is a region or the whole
  file, exactly as `generateDocstrings` does.
- `spliceSelection(fullText, start, end, rewritten)` splices the region back in
  so the diff shows only the fix.
- `deps.openDiff({ title, left, right, fileName })` renders it.
- When the reply is not honestly spliceable, fall back to a read-only tab rather
  than a misleading diff — the rule `generateDocstrings` already follows, and
  the log line it already emits.

The diagnostic's `range` supplies the splice offsets, so unlike the docstring
path there is never a "no selection offsets" case; the whole-file-reply case
remains.

### Find prior occurrences

`searchRanked({ name: normalizedQuery, limit })` over the local index. This
action reaches **no model and produces no egress**, so it is not gated — the
same standing as the existing Search command, which is the surface whose Quick
Pick rendering it reuses.

It does still require the Gateway. `searchRanked` is an IPC call over the same
socket as everything else, so "ungated" and "works offline" are not the same
claim, and this spec makes only the first. The distinction that *does* exist is
one the extension cannot act on: prior-occurrences needs no LLM provider
configured, where explain and fix do — but no RPC reports provider readiness, so
the extension has no way to offer the third action when the first two would fail.
Both would surface as a Gateway-side error.

Empty results say **"Nimbus: nothing in the local index matches this error."**
Not "no prior occurrences" — on a thin index those are very different claims,
and the surface must not make the stronger one.

### Code action kinds, and never `isPreferred`

All three carry namespaced kinds under the quick-fix family —
`quickfix.nimbus.explain`, `quickfix.nimbus.fix`,
`quickfix.nimbus.priorOccurrences` — and each sets `diagnostics: [diagnostic]`
so VS Code associates it with the squiggle that produced it.

Staying inside `quickfix` is deliberate: `Ctrl+.` / `Cmd+.` requests that family,
and it is the *only* keyboard path to these actions since the commands are
palette-hidden (Part 6). Putting explain and prior-occurrences under
`CodeActionKind.Empty` to keep the quick-fix list clean would trade the tidier
menu for the actions being unreachable from the keyboard — the wrong trade.
Namespacing under `quickfix.nimbus.*` keeps them reachable while still letting a
user or a workspace filter the whole family by prefix.

**No action ever sets `isPreferred: true`.** *Auto Fix*
(`editor.action.autoFix`, `Shift+Alt+.`) considers only preferred actions, and a
keystroke a user presses to tidy lint must never fire a gated model call. This is
a one-word field and the single easiest way to get this surface wrong, so it is
pinned by a test rather than left to review.

### How many actions appear

A line commonly carries several diagnostics — a compiler error and a lint
warning on the same expression is routine. Three actions per diagnostic would put
six to nine Nimbus entries in one lightbulb, which is noise, not offering.

`actions.ts` therefore selects **exactly one diagnostic** from those in the
requested range and offers exactly three actions for it, so the Nimbus
contribution to the lightbulb is capped at three entries always. The selection
rule is pure and totally ordered, so it is testable and stable across repeated
`provideCodeActions` calls: highest severity first (`Error` before `Warning`),
then the smallest range, then the order VS Code supplied them.

When the range held more than one diagnostic, the action labels name the chosen
one — *Nimbus: Explain this problem (TS2345)* — so the user can see which
squiggle they are about to ask about, and falls back to the plain label when the
diagnostic has no `code`.

---

## Part 2 — Module layout

Following the repo's pure/glue split:

```
src/diagnostics/
  normalize.ts       pure — diagnostic message → index query
  context.ts         pure — diagnostic + document → payload context
  prompts.ts         pure — explain / fix prompt builders
  actions.ts         pure — which actions to offer, given a diagnostic + state
  commands.ts        the three commands over injected deps (mirrors src/scm/commands.ts)
  real-provider.ts   the ONLY file touching registerCodeActionsProvider
```

`actions.ts` returning descriptors — not `vscode.CodeAction` instances — is what
keeps `real-provider.ts` dumb glue and makes "which actions appear when" a plain
unit test rather than something only a running editor can prove.

---

## Part 3 — Normalization

This is the design-heavy piece, because it is the entire value of the third
action. A raw diagnostic message is a mix of two things: **invariant prose** that
another occurrence of the same problem would share, and **call-site tokens** —
paths, positions, local identifiers — that are unique to this line and actively
poison a semantic query.

`normalizeDiagnosticMessage(diagnostic)` returns the query string:

1. **Prepend the code.** `diagnostic.code` (`TS2345`, `no-unused-vars`, `E0499`)
   is the highest-signal exact token available. Missing codes are simply
   omitted.
2. **Collapse whitespace**, including the newlines multi-line messages carry.
3. **Strip positions** — `line N`, `:N:M`, trailing `(N,M)`.
4. **Strip paths** — any token containing a path separator *and* a dot
   extension, plus Windows drive-letter prefixes. The conjunction matters: it
   keeps `Array<string>` and drops `src/foo/bar.ts`.
5. **Apply the per-source quoted-token policy** (below).
6. **Clamp** to 300 characters, cutting on a word boundary.

### The quoted-token policy

Quoted content cannot be treated uniformly, and pretending otherwise is how this
gets subtly wrong:

- TypeScript quotes **types**: *Argument of type `'string'` is not assignable to
  parameter of type `'number'`*. Those quotes are the most useful part of the
  message.
- ESLint quotes **identifiers**: *`'handleFoo'` is defined but never used*. That
  quote is the least useful part — it is this call site, and nothing else.

So: a `Record<string, "keep" | "drop">` keyed on `diagnostic.source`, defaulting
to **`"keep"`**. `eslint` and `biome` map to `"drop"`. Defaulting to keep means
an unrecognised linter degrades to "slightly noisy query", not "query with its
meaning removed".

This table is openly incomplete and will stay incomplete — every language server
words its messages differently. It is a lookup table precisely so extending it
is a one-line change with a one-line test, and so that being wrong about one
source cannot affect any other.

### When normalization yields nothing useful

If the query is under 12 characters after normalization (a bare code, or a
message that was entirely call-site tokens), `actions.ts` does not offer the
action at all. A lightbulb entry that reliably returns nothing is worse than no
entry.

---

## Part 4 — The pre-flight gate

One new `EgressKind`: `"diagnostic"`. It is a **prompting** kind — the extension
chooses the snippet, the user did not type it, which is the same reason the
briefs prompt.

Changes required, all small and all in `src/egress/`:

- `preflight.ts` — add `"diagnostic"` to `EgressKind`.
- `skip-store.ts` — add `"diagnostic"` to `SkippableKind` and its key
  (`nimbus.preflight.skip.diagnostic`).
- `gate.ts` — add it to `skippableKind()` and to `SKIP_LABEL`
  (`"Diagnostic Actions"`).
- `gated-client.ts` — wire the two call sites with the kind fixed at wiring
  time.

**Correction to the brainstorm:** the discussion proposed per-action skip keys
(`diagnostic.explain` / `diagnostic.fix`). The skip store is keyed by
`SkippableKind`, one key per kind, and every existing kind is already coarser
than one call site — `brief` covers six calls, `scm` covers three, `quickAsk`
covers every preset. One `"diagnostic"` key covering both model actions is both
consistent and less machinery; per-action granularity would mean a new sub-key
scheme for a distinction nobody has asked for.

`EgressMeta` per action:

- `action`: `"Explain Problem"` / `"Suggest Fix"`.
- `files`: one entry, `name` redacted to a basename, `scope` reading
  `"lines N–M around the problem"`.
- `omissions`: always states that the rest of the file is not sent; adds a
  truncation note when the snippet hit its budget.

Restricted Mode needs nothing new — the gate already refuses to honour a skip
when `isTrusted()` is false.

---

## Part 5 — Context budget

`buildDiagnosticContext()` takes ±20 lines around the diagnostic range, clamped
to the document bounds, then passed through the existing `clampContext(code,
QUICK_ASK_MAX_CONTEXT_CHARS)` from `src/quick-ask.ts` — the same helper and the
same 50,000-character budget the SCM trio already reuses, rather than a second,
differently-tuned number.

At ±20 lines that clamp will effectively never fire; it is a backstop against a
minified or single-line file where twenty "lines" is the whole bundle. It is
reused rather than reimplemented so that if it *does* fire, the truncation
wording and the recorded omission match every other surface, and the gate's
preview says so instead of quietly showing less than it sends.

---

## Part 6 — Manifest, settings, discoverability

- **Three commands**, hidden from the command palette (`commandPalette` →
  `when: false`): each takes a diagnostic argument and has no meaning without
  one. Keyboard users reach them through `Ctrl+.` / `Cmd+.`, which is the code
  action menu itself, so nothing is lost. A palette variant that operates on the
  diagnostic nearest the cursor is a plausible follow-on and is deliberately not
  in this slice.
- **`contributes.codeActions`** metadata so the actions are discoverable in VS
  Code's own Code Actions settings UI.
- **One setting:** `nimbus.diagnostics.showCodeActions`, boolean, default
  `true`. It must be documented in `docs/settings.md` or `check-settings-docs`
  fails the build.
- **Severity scope:** `Error` and `Warning` only. `Information` and `Hint` are
  where formatters and spell-checkers live; a lightbulb on every one of them
  would make the surface feel like spam. Not configurable in this slice.
- **Connection** is checked before any payload is assembled, matching the SCM
  commands. While disconnected, `actions.ts` offers **nothing at all** —
  including prior-occurrences, because `searchRanked` is an IPC call over the
  same Gateway socket and would fail identically. "Ungated" is not "offline"
  (Part 1).

---

## Part 7 — Testing

| File | Covers |
| --- | --- |
| `diagnostics-normalize.test.ts` | Table-driven over real TS, ESLint, biome, rustc and pyright messages; code prepending; path and position stripping; both quoted-token policies; that unlisted sources (rustc, pyright, gopls) fall through to `"keep"` rather than being guessed at (Part 9); the 300-char clamp; the under-12-character rejection |
| `diagnostics-context.test.ts` | Snippet budget, clamping at both file edges, the truncation omission |
| `diagnostics-actions.test.ts` | Severity filtering, the disconnected case (all three withheld, prior-occurrences included), the setting off, the short-query case, the one-diagnostic selection rule at every tie-break, the code-suffixed labels, the three kinds, and that no descriptor sets `isPreferred` |
| `diagnostics-commands.test.ts` | All three commands over fake deps: spliceable and whole-file fix replies, the read-only fallback, the empty-search wording, gate cancellation |
| `egress-choke-point.test.ts` | Already enforces the rule; must still pass with the new call sites |
| `egress-gate.test.ts` | The new kind prompts, its skip key round-trips, and its label renders |
| `manifest-diagnostics.test.ts` | The three commands exist, are palette-hidden, and the setting is declared |

A test must also assert that `nimbus.diagnosticPriorOccurrences` does **not**
route through the gate — the mirror of the existing test that pins
`agentsWhyPeek` as the sole gate exemption, and the thing that would silently rot
if someone later "tidied" all three actions onto one path.

---

## Part 8 — Honest limits

- **Normalization is language-specific and will be imperfect.** The per-source
  table is a starting point, not coverage. The mitigation is the design, not
  optimism: default to `"keep"`, reject queries too short to be useful, and say
  "nothing indexed matches" rather than "no prior occurrences".
- **The splice heuristic will sometimes fall back** to a read-only tab. That is
  the correct failure — `generateDocstrings` already behaves this way, and a
  wrong diff is worse than no diff.
- **Prior occurrences is only as good as the index.** On a fresh install with
  nothing but `local_files` indexed, the third action will mostly return
  nothing. That is a real first-run weakness and it argues for the wording
  above, not against the feature.
- **Three actions is a lot of lightbulb.** If it reads as noise in the F5 pass,
  the fix is to narrow — errors only, or fold explain and fix into one action —
  and that judgement needs a running editor, not this document.

---

## Part 9 — Deferred, with triggers

Three suggestions from review are deliberately not in this slice. Each is
recorded with the evidence that would pull it in, so deferring is a decision
rather than an omission.

### Caching and debouncing `provideCodeActions`

VS Code does call the provider often. The work per call is a severity filter, a
totally-ordered pick over a handful of diagnostics, and a few regexes over one
short string — no I/O, no RPC, no allocation of consequence. A cache would add
an invalidation surface (diagnostics change under the same range constantly) to
save microseconds nobody has measured.

**Trigger:** a profile showing `provideCodeActions` on a hot path, or observable
typing lag in the F5 pass. The correct first fix then is to defer normalization
out of the provider, not to add a cache.

### Configurable quoted-token policy

Making the keep/drop table user-configurable would ask users to reason about
their language server's quoting conventions to fill in a settings array. That is
a knob almost nobody can set correctly, and it would need docs, validation, and
tests for a decision the extension is better placed to make.

Expanding the built-in table beyond `eslint` and `biome` is also deferred, and
for a more interesting reason: **the keep/drop split is clean for linters and
mixed for compilers.** `rustc` backtick-quotes identifiers in ``cannot borrow `x`
as mutable`` and types in ``expected `u32`, found `String` ``. Pyright quotes an
identifier in `"foo" is not defined` and a type in `Argument of type "int"`. A
single per-source verdict is simply the wrong shape for those sources — which is
precisely why the default is `"keep"` and why the table has two entries rather
than a speculative six. Adding a source on a guess would make its queries worse,
not better.

**Trigger:** an observed bad query from a specific source, which tells us which
way that source should map. Per-*pattern* rules, if ever needed, are a different
design than a per-source table and would get their own review.

### `nimbus.diagnostics.ignoredSources`

The noise this would mute is now largely addressed upstream of it: capping the
Nimbus contribution at three entries for one selected diagnostic (Part 1) means
a verbose linter no longer multiplies the lightbulb. What remains is the case of
a source whose warnings are never worth asking about at all.

**Trigger:** the F5 pass, or early use, showing a source that consistently earns
a useless lightbulb. It is a small addition — one array setting, one filter in
`actions.ts`, one docs line — and cheaper to add on evidence than to tune blind.

---

## Verification

Unit tests cannot prove a code action renders. Before this merges, an Extension
Development Host pass with a Gateway running must confirm:

1. The lightbulb appears on a real TypeScript error and lists exactly three
   Nimbus actions — and does **not** appear on a hint. On a line carrying both a
   compiler error and an ESLint warning, still exactly three, labelled with the
   error's code.
2. `Ctrl+.` reaches all three (they are palette-hidden, so this is the only
   keyboard path), and `Shift+Alt+.` — Auto Fix — fires **none** of them.
3. The pre-flight modal shows kind `"diagnostic"` with the redacted basename and
   the line range, and *Always send here* persists per workspace.
4. The fix action renders a diff scoped to the fix, and the fallback path opens
   a read-only tab rather than a whole-file mismatch.
5. Prior occurrences opens the Quick Pick, and an empty result shows the
   "nothing in the local index matches" wording.

**Existing debt to clear in the same pass:** the Workflows view (#95) and the
workflow run/cancel surface (#96) merged and shipped in `0.16.0` having never
been driven in an Extension Development Host. That pass should happen first —
adding surface area on top of unverified surface area compounds the risk.

## Sequencing

1. F5 pass on the workflow surface (existing debt).
2. `normalize.ts` + `context.ts` + `prompts.ts` + `actions.ts` with tests — pure,
   no `vscode`.
3. The gate kind across the four `src/egress/` files.
4. `commands.ts` over injected deps, with tests.
5. `real-provider.ts`, manifest, setting, settings doc.
6. F5 pass on this surface.
7. Update the roadmap: move the row to *Already shipped*, and mark Phase 3's
   *quick-ask code-editing actions* as partly delivered here.
