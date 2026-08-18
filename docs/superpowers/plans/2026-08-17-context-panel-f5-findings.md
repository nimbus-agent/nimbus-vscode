# Ambient context panel — Extension Development Host findings

**Run:** 2026-08-17, against `f03d0a1` (v0.18.0), Gateway 2.2.0, Windows 11.
Workspace: this repo, indexed (`nimbus init` — 8693 items, 1153 `filesystem`).
The panel had never been driven in a real editor: PR 1 (#109) and PR 2 (#112)
both merged on a green unit suite alone.

The checklists are `2026-08-16-ambient-context-panel-pr1.md` Task 7 Step 9
(sixteen points) and `2026-08-16-ambient-context-panel-pr2.md` Task 8 Step 6
(nineteen). This file records what was observed, not what was expected.

The automated gate was green first: 1262 tests / 95 files, `typecheck`, `lint`,
`build`, `check-bundle`, `check-vsix-contents` (18 files), `check-settings-docs`
(16 settings).

## Verified working

1. **The view resolves and is first** in the Nimbus container, on activation,
   with no Gateway round-trip needed for its local half. (PR1 #1)
2. **Problems is live.** Pasting `const f5probe: number = 'not a number';` into
   `src/logging.ts` put `Line 11: Type 'string' is not assignable to type …` in
   the section within a second; undo removed it. (PR1 #2, #3)
3. **Git reports the real branch** (`main`). (PR1 #2)
4. **No icons, no stray indent.** No codicon font ships and the spans were
   removed in PR 1; rows and buttons read cleanly. (PR1 #11)
5. **The dirty marker works** — "Unsaved edits — history may not line up with
   what is on screen." appeared on the unsaved edit and cleared on save.
   (PR1 #6)
6. **Offers are catalog-derived and context-correct.** With a file and line:
   all six briefs. With no editor open: exactly the three that need no editor
   context — *Team huddle*, *Is this idle?*, *Safe to deploy?* (PR1 #4)
7. **An offer routes through the pre-flight gate.** Clicking *Why is this here?*
   raised the modal — "Send this to the Nimbus agent? / Why is this here?
   (agents.why) — 1 file, 43 characters / src/logging.ts:11 — the extension
   sends this path, not the file's contents" — with *Send*, *Show full text*,
   *Always send Agent Briefs here*, *Cancel*. No `refused a message` log, so the
   offer list and the command allowlist have not drifted. (PR1 #4, #16)
8. **The blame line number is right — the highest-value check in either list.**
   `src/logging.ts` lines 13–17 belong to `aa2d2b79` and lines 12 and 18 to
   `6c9167de`. With the cursor on line 13 the panel showed `Asaf · 33d ago ·
   aa2d2b7`; on line 11 it showed `AsafGolombek · 56d ago · 6c9167d`. The
   one-based conversion in `whyParams` holds against a live Gateway. (PR2 #11)
9. **Offers while disconnected** report `Nimbus: not connected to the Gateway.`
   and log no refusal. (PR1 #16)
10. **Losing the Gateway re-renders without touching the editor.** `nimbus stop`
    flipped History and Related to "Needs the Nimbus Gateway." on their own,
    while Problems and Git kept working. (PR2 #6, #10)
11. **Regaining it refills them**, again with no editor interaction. (PR2 #6)
12. **The git watcher fires without editor interaction** — creating an untracked
    file moved the count to "1 changed file" on its own. (PR2 #9, first half)
13. **No file open** renders "No file open." in Problems, History and Related
    rather than blanking. (PR1 #5)
14. **Related keys on the selection.** A multi-line selection made the query the
    selected text (which matched nothing); clearing it returned to the path
    query and results came back. (PR2 #5)

## Findings

### F1 — The view is ~140 px tall by default, so most of it is unreachable

Predicted by PR1 #14, now confirmed. On a profile with all seven Nimbus views
visible, the Context webview resolves to roughly two sections' worth of height
with an internal scrollbar: **Problems and Git are visible; History, Related and
every offer button are below the fold.** The surface's whole premise — offering
agents for what is on screen — is invisible until the user scrolls inside a
scrollbar most people will not notice, or hides other views.

Dragging the sash between Context and the view below it did not enlarge it.

### F2 — Every Related row is the open file's own symbol, repeated

`relatedSection` excludes `i.name !== snapshot.path`. **Index item names are
symbol names, never repo-relative paths** — this answers PR2 #17 with a flat
*no*, so the self-exclusion is dead code in a filesystem-indexed repo.

Observed: on `ops-commands.ts`, three rows all reading `runOpsCommand
(function) · filesystem`. On `logging.ts`, six rows alternating `createLogger
(function)` and `errMsg (function)` — all from the file already on screen. A
direct `searchRanked({name: "src/chat-participant/ops-commands.ts", limit: 20})`
against the live Gateway returns exactly those three, so the panel is rendering
what it is given.

The item payload carries `rawMeta.file` (`src/chat-participant/ops-commands.ts`),
which is the field an exclusion can actually key on, and duplicates need
collapsing too.

### F3 — "changed files" counts unstaged-only, and drops when you stage

Predicted by PR2 #12, now confirmed against `git status`:

| Working tree | `git status --short` | Panel |
| --- | --- | --- |
| clean | *(empty)* | `0 changed files` |
| one untracked file | `?? f5-untracked.txt` | `1 changed file` |
| that file staged | `A  f5-untracked.txt` | `0 changed files` |

`changedPathsNow` reads the git extension's `workingTreeChanges`, which is
unstaged-only and — under the default `git.untrackedChanges: "mixed"` —
includes untracked files. So the number falls as you stage, and a fully staged
repo reads "0 changed files" beside a dirty tree. PR 2 left the decision open:
either fold the index changes in (a seam addition) or relabel the row to say
what it counts. A clean tree also renders `0 changed files` rather than omitting
the row.

### F4 — The gate's redaction note contradicts the payload it is describing

`REDACTION_NOTE` (`src/egress/preflight.ts:43`) — "Paths sent as file names only
— no directories, no repository path." — is appended by `footerLines` whenever a
payload has any files. The briefs put the repo-relative `ref` in as the file name
(`src/briefs/commands.ts:84`, `:93`), so the modal displayed **`src/logging.ts:11`
directly above a line claiming no directories are sent**.

Pre-existing, not caused by the panel — but the panel is now the easiest way to
reach a brief, and this is the trust surface, where a false claim costs the most.
The repo-relative path is what the Gateway needs to resolve the file, so the fix
belongs in the note (make it conditional on the payload actually being redacted),
not in the payload.

### F5 — The panel logs nothing, so the cadence checks cannot be run

The Output channel shows only activation and connection lines; no collection,
cache hit, or invalidation is logged at any level. Four checklist points —
PR1 #7 and #15, PR2 #2 and #13 — are phrased as "watch the output channel" for
debounce cadence, git churn, and silence while hidden. **None of them is
answerable as the code stands.** Either a debug-level line per collection lands,
or those points come off the list as unverifiable.

(The steady `Connect failed (ENOENT)` lines at 3 s intervals while the Gateway is
down are the connection manager's normal retry, not the panel.)

## Not run

Recorded so the gap is explicit rather than implied:

- Multi-root window, two repos on different branches (PR1 #12), and a second
  repository opened mid-session (PR2 #18).
- Focus survival across a re-render, and screen-reader announcements
  (PR1 #13, PR2 #15).
- Hiding the Context view and confirming silence (PR1 #15), the typing-storm
  cadence (PR1 #8, PR2 #7) and git churn (PR2 #13) — all blocked by F5.
- A repository that has not been indexed (PR2 #3) — this workspace is indexed.
- A file outside every workspace root (PR2 #16).
- Commit invalidation (PR2 #14).
- Ctrl+A over a large file (PR1 #9).
- The selected-text egress against the ledger (PR2 #19).
- Related refreshing on save (PR2 #8).

## How this pass was driven

Screen capture plus synthetic mouse and keyboard input against the Extension
Development Host, rather than narration by a human at the keyboard. Two things
are worth knowing for the ExTester spec that PR 3 owes:

- `SendKeys` does not reach an Electron window; `keybd_event` does.
- View headers in the sidebar are drag handles, so a click intended to collapse
  one can reorder the container instead.

---

## PR 3 pass — 2026-08-18

Run against the PR 3 branch (`worktree-context-panel-pr3`, head `9f0f258`),
Gateway 2.2.0, in an Extension Development Host launched with a disposable
`--user-data-dir` and `nimbus.logLevel: debug`.

### Automated gate

1289 tests / 95 files, `typecheck`, `lint`, `build`, `check-bundle`,
`check-vsix-contents` (18 files), `check-settings-docs` (17 settings) — all green.
The ExTester suite was run by the controller directly: **23 passing**, including
the three new context-panel cases.

### F1 — the correction

**F1 is FIXED, and the three measurements recorded during implementation were
wrong.** Those runs used `code --profile <name>` against the default
user-data-dir, which carries existing view state and masks a manifest's
`visibility` defaults. Re-measured with a genuinely clean `--user-data-dir`, the
six tree views open **collapsed** and the Context view fills the sidebar:
Problems, Git, History, Related and all six offers visible at once, no internal
scrollbar.

What the manifest cannot do is change a layout VS Code has already stored for an
existing user — that is inherent to defaults, not a defect. So: fixed for a fresh
profile, unchanged for anyone who already has the container laid out.

The lesson worth keeping: `--profile` is not a clean slate. `--user-data-dir` is.

### The other four, verified in the editor

- **F2 — Related.** The open file's own rows are excluded. Where duplicates still
  appear, they are real: this repo's index holds `src/logging.ts` alongside
  `.claude/worktrees/briefs-pr3/src/logging.ts` and
  `.claude/worktrees/ambient-context-panel/src/logging.ts` from earlier PRs'
  worktrees — genuinely different files that share symbol names. A repo whose
  index contains several checkouts will show one row per checkout.
- **F3 — the count.** Untracked file → "1 changed file". `git add` it → **still
  "1 changed file"** (it fell to zero before this branch). Clean tree → the row is
  omitted entirely.
- **F4 — the pre-flight note.** With a folder workspace, the modal reads
  `src/logging.ts:18` above "Paths sent relative to the repository root — no
  absolute paths, no machine layout." With a single file open and no workspace
  root, the ref degrades to the basename `logging.ts:18` and the modal correctly
  reverts to the stronger "file names only" claim. Both branches confirmed live.
- **F5 — the log.** One line per collection, one per debounce tier rather than per
  keystroke:
  `context collect #13 logging.ts:13 [problems=local git=local blame=fetch related=cached]`.
  Three of the four labels observed (`local`, `fetch`, `cached`) plus the
  `(no file):-` fallback that no unit test covers.

### Also observed

- `nimbus.context.enabled` off → the view stays and says it is off; back on → the
  panel refills with no cursor move, file switch or reload.
- Stopping the Gateway flips History and Related to "Needs the Nimbus Gateway"
  while Problems and Git keep working.
- Cancelling at the gate is recorded as
  `nimbus.brief.why cancelled at the pre-flight preview` — nothing sent.
- A file opened outside any workspace root degrades to a basename ref, and blame
  still resolves.
- Zero `[warn]` or `[error]` lines in the channel across the whole session.

### Still not verified

- The `skipped` log label. Inconclusive rather than absent: the window reloaded
  when the folder was opened, and VS Code started a fresh channel file that had
  not flushed by the end of the session.
- Multi-root windows, a second repository opened mid-session, focus survival
  across a re-render, an unindexed repository, commit invalidation, Ctrl+A on a
  large file, the selected-text egress checked against the ledger, and Related
  refreshing on save. These were on the original "not run" list and remain there.

### F1 — the retraction, 2026-08-18

The "F1 — the correction" section above turned out to be wrong: it credited
the fix to `--profile` masking the manifest's `visibility` default. A
follow-up isolation pass on clean, disposable `--user-data-dir` launches (not
`--profile`, which carries stored view state from prior runs) tested the
manifest properties directly:

1. `initialSize` alone, `visibility: collapsed` removed → six tree views
   collapsed, Context view full height.
2. **Neither property present** → **identical result**: six tree views
   collapsed, Context view full height, every section and offer visible.

Removing both properties changed nothing. That makes them inert: a fresh
profile already opens the Context view at full height because it is a
webview view placed first in its container, which is VS Code's own default
regardless of manifest hints. The real ~140px case from the original pass was
never a manifest question — it was a profile that already had a layout
stored from an earlier version, with all seven views expanded. No manifest
default can rewrite a layout VS Code has already saved for a user.

Conclusion: F1 is a stored-layout phenomenon, not a manifest defect, and has
no manifest-level fix. `initialSize` and `visibility` were reverted. Where a
profile already shows the panel short, the remedy is the user's — collapse
the other views, or drag the sash.
