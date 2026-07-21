# Design — Dev-workflow trio (commit message, review changes, generate tests/docs)

**Date:** 2026-07-20
**Status:** Approved (design); pending implementation plan
**Roadmap:** Phase 2 — "Dev-workflow trio" (`agentInvoke` + SCM API; no client bump)

## Overview

Three editor-native commands backed by the local Nimbus agent, all riding the
already-published one-shot `agentInvoke` RPC plus a new seam over VS Code's
built-in git extension:

1. **Generate commit message** — reads the *staged* diff, drafts a message in the
   repo's own commit style, writes it into the Source Control input box.
2. **Review my changes** — reads all local changes against `HEAD` (staged *and*
   unstaged), returns findings in a read-only markdown tab.
3. **Generate tests / docstrings** — from the current selection or file, returns
   a saveable test buffer, or a docstring-annotated rewrite shown as a
   side-by-side diff against the original.

These are the surfaces developers touch every day, and they are where a
local-first agent is most obviously better than a cloud one: the diff never
leaves the machine except through the Gateway's ledgered egress path.

No new Gateway capability is required. `agentInvoke` is already consumed by Quick
Ask; the only genuinely new surface is the git/SCM API, which is a **VS Code**
API, not a Nimbus one. The load-bearing non-negotiable is intact: the extension
never reaches past the typed `@nimbus-dev/client`.

## Goals

- `Nimbus: Generate Commit Message` — staged diff → SCM input box, matching the
  repo's existing commit style, never clobbering typed text without consent.
- `Nimbus: Review Changes` — all local tracked changes vs `HEAD` → a
  consistently-shaped markdown findings tab, with untracked files counted and
  named in the header but never sent.
- `Nimbus: Generate Tests` — selection/file → a **named untitled buffer**
  (`quick-ask.ts` → `quick-ask.test.ts`) opened beside the source, ready to save.
- `Nimbus: Generate Docstrings` — selection/file → a **side-by-side diff**
  (original ↔ annotated) so additions are reviewable and mergeable with the
  editor's own controls.
- A narrow, unit-testable git seam: all decision logic pure, `vscode` touched
  only in a thin adapter.
- Path discipline and size clamping on everything sent to the agent.
- Graceful, RPC-free behaviour when the Gateway is disconnected, the git
  extension is disabled, there is no repo, or the diff is empty.

## Non-goals (MVP)

- **Auto-applying** generated code as a `WorkspaceEdit` — that is the Phase 3
  "quick-ask code-editing actions" item. MVP produces suggestions: an unsaved
  untitled buffer, or a diff view whose right-hand side is a virtual document.
  Nothing on disk is modified by the extension; every write is the user's own
  editor action.
- **Test-file *location* heuristics** (`src/foo.ts` → `test/foo.test.ts`). MVP
  derives the file *name* and opens it untitled beside the source; because the
  buffer is untitled, Save already opens a location picker, so a wrong directory
  guess costs two clicks. Revisit if that proves annoying in practice.
- **A `nimbus.scm.reviewScope` setting.** Review defaults to all local tracked
  changes vs `HEAD`, which is what "my changes" means to nearly everyone. A knob
  can follow if the default is actually contested.
- **Diagnostics / squiggles** for review findings (see Decision 3 and Risks).
- **A payload pre-flight preview.** The Phase 2 "Preview what leaves" item is the
  right home for that, across all surfaces. These three commands become its
  consumers when it ships; they do not grow a bespoke preview.
- **Streaming or cancellation** — `agentInvoke` is one-shot with no abort until
  the Phase 4 SDK work lands. MVP uses a progress notification, like Quick Ask.
- Any `@nimbus-dev/client` bump. Any `git` CLI invocation or `child_process` use.
- Amend/rewrite of existing commits; staging or committing on the user's behalf.

## Decisions (from brainstorming)

| # | Decision | Choice |
| - | -------- | ------ |
| 1 | Scope | **One spec, three commands, one PR.** They differ only in prompt-building and output surface; the git seam is shared and would otherwise be designed once and stretched twice. The plan still sequences them as independently reviewable tasks. |
| 2 | Git access | **Built-in git extension API only** (`extensions.getExtension("vscode.git")` → `getAPI(1)`). It is the only way to write the SCM input box, needs no process spawning, and gives diffs, repo list, and `log()`. No `child_process`, no second notion of "what is a repo". |
| 3 | Review output | **Read-only markdown tab** via the existing `openReadonlyJson` opener. Diff-hunk-line → file-line mapping is error-prone, and a hallucinated line number becomes a squiggle on innocent code. Diagnostics are a follow-up, next to the Phase 3 "Ask Nimbus about this problem" item, and only once a validated findings schema exists. |
| 4 | Tests/docs differentiation | **File-shaped output.** The `@nimbus` participant already has `/test` and Quick Ask presets already cover "write tests for this". The distinct value is output you can *act on*: a named untitled `*.test.*` buffer for tests, a side-by-side diff for docstrings. Prose-about-code would be a redundant fourth path. |
| 5 | Privacy | **Clamp + path discipline, no per-call modal.** Repo-relative diff paths are kept verbatim (they are load-bearing for a useful review and leak no username or layout); `repo.rootPath` is never sent; any path *we* add to a prompt goes through `redactPath`. Likely-secret files are skipped by default. |
| 6 | Clamping | **Whole-file granularity.** A diff cut mid-hunk yields confidently wrong reviews. Files are dropped whole and the omission is reported to the user. The one oversized-single-file fallback truncates at a **hunk boundary**, never mid-hunk, so what is sent is always a syntactically valid diff. |
| 9 | Diff acquisition | **Per-file, not one mega-diff.** The seam asks the git API for the changed *file list* and then each file's diff. This removes unified-diff *parsing* from the design entirely — classification and clamping operate on real paths from git rather than on paths recovered from `diff --git` headers. |
| 10 | Review scope | **All local tracked changes vs `HEAD`** — staged and unstaged. "Review my changes" returning "nothing to review" because the user staged their work first would be a bad first experience. Untracked files are counted and named in the header, but their content is never sent. |
| 11 | Style-example hygiene | **Filter the log.** Merge commits, release-bot commits, and dependency-bump commits are excluded before the ~10 examples are chosen, so the agent learns the *human* commit style rather than the automation's. |
| 12 | In-flight repo loss | **Re-validate before writing.** The selected repository is captured up front, and its continued presence is re-checked after the (uncancellable) `agentInvoke` returns, before anything is written to an input box. |
| 7 | Commit style | **Learn from `repo.log()`** — feed the last ~10 subject lines as style examples so the draft matches the repo, whether or not it uses conventional commits. Zero config. Falls back to a conventional-commit instruction on an empty log. |
| 8 | Clobber safety | Empty SCM input box → write directly. Non-empty → modal with **Replace / Append / Cancel**. The input box has no undo, so silent replacement would destroy typed work irrecoverably. |

## Architecture

Follows the codebase's discipline — **pure logic behind narrow interfaces**, with
`vscode` touched only in a thin adapter — mirroring how `participant.ts` (pure)
relates to `real-participant.ts` (vscode glue).

### New modules (`src/scm/`)

| Module | Purity | Responsibility |
| --- | --- | --- |
| `git-types.ts` | types only | `GitRepositoryLike`, `GitApiLike`, `ScmDeps` — the narrow structural interfaces the rest of the code programs against. |
| `real-git.ts` | vscode glue | `getExtension("vscode.git")` → `activate()` → `getAPI(1)`, adapted to `GitApiLike`. Returns `undefined` when git is unavailable. Coverage-excluded, like `real-participant.ts`. |
| `diff.ts` | pure | Classify changed files (secret / deprioritized / normal); order them; select within a char budget at whole-file granularity; hunk-boundary-truncate the single-oversized-file case; report what was omitted and why. |
| `commit-message.ts` | pure | Build the commit prompt (style examples + selected diff); sanitize the agent reply into a commit message. |
| `review.ts` | pure | Build the review prompt (shape instruction + selected diff); wrap the reply into the findings document. |
| `generate.ts` | pure | Build tests/docstrings prompts; derive the target test filename from a source path; extract the code block from a reply. |
| `repo-select.ts` | pure | 0 repos → error; 1 → use it; N → quick-pick rows. |

### Seam shape

`GitApiLike` is deliberately minimal — only what the three commands need:

```ts
export type DiffScope = "staged" | "all";      // index-vs-HEAD | worktree-vs-HEAD

export interface ChangedFile {
  readonly path: string;                        // repo-relative, from git
  readonly status: string;                      // added / modified / deleted / …
}

export interface GitRepositoryLike {
  readonly rootPath: string;                    // never sent to the agent
  changedFiles(scope: DiffScope): Promise<readonly ChangedFile[]>;
  fileDiff(scope: DiffScope, path: string): Promise<string>;
  untrackedPaths(): Promise<readonly string[]>; // counted/named, never sent
  log(maxEntries: number): Promise<readonly string[]>;  // commit messages
  readonly inputBox: { value: string };
}

export interface GitApiLike {
  repositories(): readonly GitRepositoryLike[];
}
```

`real-git.ts` maps this onto the git extension's `diffIndexWithHEAD()` /
`diffWithHEAD()` (file lists) and their single-path overloads (per-file diffs),
plus `state.untrackedChanges` and `log({ maxEntries })`. Keeping those overload
shapes inside the adapter is deliberate: the rest of the codebase programs
against the four verbs above, not against VS Code's git API shape.

Per-file acquisition costs one call per changed file. That is bounded by
`SCM_MAX_FILES = 100`: beyond it, the extra files are reported as omitted rather
than fetched, so a 2 000-file branch cannot fan out into 2 000 calls.

Wiring mirrors the existing injectable-dep pattern: `ActivateDeps` gains `git?: () => Promise<GitApiLike | undefined>`,
`openUntitled?: (opts: { fileName: string; content: string }) => Promise<void>`,
and `openDiff?: (opts: { title: string; left: string; right: string;
languageId: string }) => Promise<void>`, each defaulting to a real
implementation and each replaced by a fake in tests.
`activateWithDeps` keeps ownership of user interaction (quick picks, modals,
progress, error toasts); the pure modules take data in and return data out.

### Data flow (per command)

```
command → resolve git api → select repo → list changed files
        → classify + order + budget-select → fetch each selected file's diff
        → build prompt (paths redacted where we add them)
        → withProgress(agentInvoke, { stream: false, agent? })
        → extractReply → sanitize/format → re-validate repo → output surface
```

`extractReply`, `clampContext`, `redactPath`, and `QUICK_ASK_MAX_CONTEXT_CHARS`
are reused from `quick-ask.ts` rather than reimplemented.

## Behaviour

### 1. Generate commit message

Contributed to the SCM title bar (`scm/title`, `when: scmProvider == git`) with a
sparkle icon, and to the command palette.

- Diff source: scope `"staged"`. Empty → error toast "Nimbus: nothing staged to
  describe." and stop. We deliberately do **not** silently fall back to the
  working tree — the message must describe what will actually be committed.
- Style: `repo.log(30)` subject lines (first line of each message), **filtered**
  before the first 10 survivors are used as examples. Excluded: merges
  (`^Merge (branch|pull request|remote|tag)\b`), release automation
  (`^chore\(release\):`, `^chore: release`, `^Release v?\d`), and dependency
  bumps (`^(Bump|build\(deps\):|chore\(deps\):)`). Without this the examples in a
  bot-heavy repo are mostly automation, and the agent dutifully imitates it.
  No survivors → conventional-commit instruction.
- Sanitizing: strip surrounding code fences and conversational preamble
  ("Here's a commit message:"), trim trailing whitespace. No length enforcement —
  the prompt asks for a ≤72-char subject and the style examples reinforce it;
  truncating a message mid-word would be worse than a long one.
- Output: `repo.inputBox.value` on the **captured** repository. Empty → write.
  Non-empty → modal **Replace / Append / Cancel**; Append joins with a blank
  line.
- **Stale-repo guard.** `agentInvoke` is uncancellable and can run for a while;
  the user may close the folder meanwhile. Before writing, the captured repo is
  re-checked against `api.repositories()` by `rootPath`. If it is gone, the draft
  is not silently dropped — it opens in a read-only tab with a toast explaining
  the repository closed, so the generated message is still recoverable.

### 2. Review changes

- Diff source: scope `"all"` — every tracked file differing from `HEAD`, staged
  or not. Empty → info toast "Nimbus: no local changes to review."
- The prompt asks for a fixed shape: a one-paragraph summary, then findings
  grouped by file, each tagged with a severity. We do **not** parse the reply —
  the shape instruction exists so the tab reads the same every time.
- Output: `openReadonlyJson("Nimbus review.md", markdown)`, prefixed with a
  **coverage header** that states exactly what was and was not reviewed:
  the repo basename, the files reviewed, and — each only when non-empty —
  the files omitted for size, the files skipped as secret-bearing, and the
  **untracked** files (named, content never sent). A user must never be able to
  read this tab and wrongly conclude their brand-new file was reviewed; the
  header is the mechanism, and it is asserted in tests.

### 3. Generate tests / docstrings

Two commands, both in the editor context menu and the palette, both operating on
the active selection or — when the selection is empty/whitespace — the whole file,
matching Quick Ask's existing rule.

- **Generate Tests** → untitled buffer named from the source path:

  | Source | Target |
  | --- | --- |
  | `quick-ask.ts` | `quick-ask.test.ts` |
  | `helpers.py` | `test_helpers.py` |
  | `Widget.java` | `WidgetTest.java` |
  | `thing.rb` | `thing_spec.rb` |
  | anything else | `<base>.test.<ext>` |

  Opened beside the editor via an `untitled:<name>` URI, so the tab carries the
  right name and language. The buffer is unsaved; closing it discards. If a real
  file already exists at that name, VS Code's own save-overwrite confirmation is
  the guard — we do not write to disk ourselves.
- **Generate Docstrings** → a **side-by-side diff**: the original document on the
  left, the annotated version on the right, opened with the `vscode.diff`
  command and titled `<basename> ↔ Nimbus docstrings`. Reading annotated code out
  of a markdown tab and hand-merging it is tedious and error-prone; a diff shows
  exactly what was added and lets the editor's own controls do the merging.
  - The right-hand side is a **virtual read-only document**, served by the same
    content-provider machinery that already backs `openReadonlyJson`
    (generalized out of `createReadonlyJsonOpener`). The extension never applies
    an edit — any change to the real file is the user's own action in the diff
    editor, which keeps the Phase 3 auto-apply boundary intact.
  - When the scope is a **selection**, the right-hand document is the full
    original text with the selected range replaced by the rewrite, so the diff
    shows only the annotated region rather than a whole-file mismatch. This needs
    selection offsets, so `TextEditorLike` in the shim gains
    `document.offsetAt(position)` and `selection.start` / `selection.end`
    (structurally satisfied by the real `vscode.TextEditor`). Splicing itself is
    a pure function and is unit-tested.
- Both extract the fenced code block from the reply when present, falling back to
  the whole reply when the agent returned bare code.

### Repo, connection, and git-availability handling

| Condition | Behaviour |
| --- | --- |
| Git extension missing/disabled | Error toast: "Nimbus: the built-in Git extension is disabled — enable it to use this command." No RPC. |
| Zero repositories | Error toast: "Nimbus: no Git repository in this workspace." |
| One repository | Used silently. |
| Multiple repositories | Quick pick of repo basenames (`rootPath` basename only — the full path is not shown or sent). Cancel → no-op. |
| Gateway disconnected | Error toast: "Nimbus: not connected to Gateway." — checked *before* reading any diff. |
| `agentInvoke` throws | Logged via `logging.ts` at error, plus an error toast. Matches Quick Ask. |
| Empty reply | Info toast: "Nimbus: the agent returned no reply." |

## Privacy and clamping

Budget: `SCM_MAX_DIFF_CHARS = QUICK_ASK_MAX_CONTEXT_CHARS` (50 000) — one number,
shared, already justified.

Selection algorithm (`diff.ts`), deterministic and unit-tested:

1. Start from the changed-file list git reports (repo-relative paths), capped at
   `SCM_MAX_FILES = 100`. No unified-diff parsing is involved — paths come from
   git, not from `diff --git` headers.
2. Drop **secret-bearing** files when `nimbus.scm.skipSecretFiles` is true
   (default): `.env*`, `*.pem`, `*.key`, `id_rsa*`, `*.p12`, `*.pfx`. A staged
   `.env` reaching a cloud LLM is the one unrecoverable mistake available here.
3. Partition the rest into **normal** and **deprioritized** (lockfiles —
   `package-lock.json`, `bun.lockb`, `yarn.lock`, `pnpm-lock.yaml`, `Cargo.lock`,
   `poetry.lock`; plus `*.min.*` and `*.snap`). A 4 000-line lockfile diff would
   otherwise eat the whole budget and starve the code that matters.
4. Greedily take whole files in order — normal first, then deprioritized —
   while the running total fits the budget.
5. **Fallback:** if not even the first file fits, include that one file truncated
   **at the last complete hunk (`@@ … @@`) boundary that fits**, with an explicit
   `(truncated — N of M hunks)` marker in its header. A raw character slice would
   cut mid-hunk and hand the agent malformed diff syntax, which produces
   confident nonsense; cutting at a hunk boundary keeps what is sent a valid
   diff. If even the first hunk exceeds the budget, the file is dropped and
   reported — we do not send a broken hunk. This is the single documented
   exception to whole-file granularity.
6. Return the selected text plus per-reason omission lists, so the caller can
   warn ("Nimbus: 3 of 11 files omitted — diff too large") and so the review
   coverage header can name them. Secret-skips are reported separately, so a
   skipped `.env` is visible rather than silent.

Path discipline:

- Repo-relative diff paths are sent verbatim — they are what makes a review
  useful, and they contain no username or absolute layout.
- `repo.rootPath` is never sent; only its basename is ever *displayed*.
- Any path we add ourselves (the tests/docstrings prompt header, taken from
  `document.fileName`) goes through `redactPath`, exactly as Quick Ask does.
- The byte count actually sent is logged via `logging.ts` at debug.

## Settings

One new setting, keeping the surface small:

| Setting | Type | Default | Meaning |
| --- | --- | --- | --- |
| `nimbus.scm.skipSecretFiles` | boolean | `true` | Exclude likely-secret files (`.env*`, `*.pem`, `*.key`, `id_rsa*`, `*.p12`, `*.pfx`) from diffs sent to the agent. |

Added to `package.json` `contributes.configuration`, to `Settings` in
`src/settings.ts`, and to `docs/settings.md` — the last is enforced by
`bun run check-settings-docs`, which will fail CI otherwise.

Diff size reuses the existing quick-ask constant rather than adding a knob.
Agent selection reuses the existing `nimbus.askAgent`.

## Commands and contributions

| Command id | Title | Surfaces |
| --- | --- | --- |
| `nimbus.generateCommitMessage` | Nimbus: Generate Commit Message | `scm/title` (icon, `scmProvider == git`), palette |
| `nimbus.reviewChanges` | Nimbus: Review Changes | palette, status-bar quick menu |
| `nimbus.generateTests` | Nimbus: Generate Tests | editor context menu (`editorTextFocus`), palette |
| `nimbus.generateDocstrings` | Nimbus: Generate Docstrings | editor context menu, palette |

## Testing

Vitest, `vscode` aliased to the stub, following `participant.test.ts` and
`chat-controller.test.ts`:

- `scm-diff.test.ts` — secret-skip on/off, lockfile deprioritization, budget
  selection, the `SCM_MAX_FILES` cap, hunk-boundary truncation (including the
  first-hunk-too-big drop), per-reason omission lists, CRLF diffs, and binary
  files (no hunks at all).
- `scm-commit-message.test.ts` — prompt includes style examples; **merge / release-bot
  / dependency-bump commits are filtered out** and a log of nothing but those
  falls back to the conventional-commit instruction; sanitizing (fences,
  preamble, trailing whitespace); append vs replace composition.
- `scm-review.test.ts` — prompt shape instruction; and the coverage header,
  asserting that size-omitted, secret-skipped, and untracked files each appear
  when present and that the section is absent when empty.
- `scm-generate.test.ts` — filename derivation table incl. dotted names and
  extensionless files; fenced-block extraction and the bare-code fallback;
  **selection splicing** (start, middle, end of file; empty selection).
- `scm-repo-select.test.ts` — zero / one / many repositories.
- `scm-commands.test.ts` — the four handlers end-to-end against a fake
  `GitApiLike`, a fake client, and the existing window stub: disconnected, git
  disabled, no repo, empty diff, clobber modal each branch, agent throw, empty
  reply, **the stale-repo guard (repository disappears mid-invoke → read-only
  fallback, no write)**, and the happy path asserting exactly what was passed to
  `agentInvoke`.

`real-git.ts` is coverage-excluded in `vitest.config.ts`, consistent with the
other vscode-glue adapters.

## Risks and follow-ups

- **Git extension API is untyped from our side.** We declare the structural
  interface ourselves, so a VS Code change to `getAPI(1)` would fail at runtime,
  not compile time. Mitigated by adapting defensively in `real-git.ts` (every
  access guarded, `undefined` on any mismatch) and by the Layer 2 verification
  gate in a real Extension Development Host.
- **Review findings are unvalidated prose.** The agent could be wrong or vague.
  This is inherent to MVP; the diagnostics follow-up is where structure and
  validation belong.
- **One-shot with no cancel.** A large diff on a slow model leaves a progress
  notification the user cannot abort. This is the known `agentInvoke` limitation
  tracked in Phase 4; when abort ships, all three commands gain Stop for free.
- **Untracked files are still not reviewed.** Their content is deliberately never
  sent — reading files git does not track is a privacy call this feature should
  not make unilaterally. The mitigation is honesty, not coverage: they are
  counted and named in the review header, and that assertion is a test.
- **Per-file diff fetching is N calls.** Bounded by `SCM_MAX_FILES = 100`, but a
  100-file review is still 100 round-trips to the git extension before the agent
  call starts. If that proves slow in Layer 2 verification, the fallback is to
  fetch the mega-diff for the whole repo and split it — the parsing we avoided —
  so this is a reversible bet, not a one-way door.

## Documentation updates

- `docs/settings.md` — the new setting (CI-enforced).
- `docs/architecture.md` — the `src/scm/` seam.
- `docs/ROADMAP.md` — move "Dev-workflow trio" to **Already shipped**.
- `README.md` — the four commands in the feature list.
- `CLAUDE.md` — the surface summary and layout section.
- `CHANGELOG.md` — via Release Please from the `feat(scm): …` commit.
