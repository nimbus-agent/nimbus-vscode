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
2. **Review my changes** — reads the *working* diff, returns findings in a
   read-only markdown tab.
3. **Generate tests / docstrings** — from the current selection or file, returns
   a saveable test buffer or a docstring-annotated rewrite.

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
- `Nimbus: Review Changes` — working diff → a consistently-shaped markdown
  findings tab.
- `Nimbus: Generate Tests` — selection/file → a **named untitled buffer**
  (`quick-ask.ts` → `quick-ask.test.ts`) opened beside the source, ready to save.
- `Nimbus: Generate Docstrings` — selection/file → the code rewritten with doc
  comments, in a read-only tab.
- A narrow, unit-testable git seam: all decision logic pure, `vscode` touched
  only in a thin adapter.
- Path discipline and size clamping on everything sent to the agent.
- Graceful, RPC-free behaviour when the Gateway is disconnected, the git
  extension is disabled, there is no repo, or the diff is empty.

## Non-goals (MVP)

- **Auto-applying** generated code as a `WorkspaceEdit` — that is the Phase 3
  "quick-ask code-editing actions" item. MVP produces suggestions: an unsaved
  untitled buffer or a read-only tab. Nothing on disk is modified.
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
| 4 | Tests/docs differentiation | **File-shaped output.** The `@nimbus` participant already has `/test` and Quick Ask presets already cover "write tests for this". The distinct value is output you can *save*: a named untitled `*.test.*` buffer beside the source. Prose-about-code would be a redundant fourth path. |
| 5 | Privacy | **Clamp + path discipline, no per-call modal.** Repo-relative diff paths are kept verbatim (they are load-bearing for a useful review and leak no username or layout); `repo.rootPath` is never sent; any path *we* add to a prompt goes through `redactPath`. Likely-secret files are skipped by default. |
| 6 | Clamping | **Whole-file granularity.** A diff cut mid-hunk yields confidently wrong reviews. Files are dropped whole and the omission is reported to the user. |
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
| `diff.ts` | pure | Split a unified diff into per-file entries; classify (secret / deprioritized / normal); select within a char budget at whole-file granularity; report what was omitted. |
| `commit-message.ts` | pure | Build the commit prompt (style examples + selected diff); sanitize the agent reply into a commit message. |
| `review.ts` | pure | Build the review prompt (shape instruction + selected diff); wrap the reply into the findings document. |
| `generate.ts` | pure | Build tests/docstrings prompts; derive the target test filename from a source path; extract the code block from a reply. |
| `repo-select.ts` | pure | 0 repos → error; 1 → use it; N → quick-pick rows. |

### Seam shape

`GitApiLike` is deliberately minimal — only what the three commands need:

```ts
export interface GitRepositoryLike {
  readonly rootPath: string;                    // never sent to the agent
  diff(cached: boolean): Promise<string>;       // staged (true) / working (false)
  log(opts: { maxEntries: number }): Promise<Array<{ message: string }>>;
  readonly inputBox: { value: string };
}

export interface GitApiLike {
  repositories(): readonly GitRepositoryLike[];
}
```

Wiring mirrors the existing injectable-dep pattern: `ActivateDeps` gains
`git?: () => Promise<GitApiLike | undefined>` and
`openUntitled?: (opts: { fileName: string; content: string }) => Promise<void>`,
each defaulting to a real implementation and each replaced by a fake in tests.
`activateWithDeps` keeps ownership of user interaction (quick picks, modals,
progress, error toasts); the pure modules take data in and return data out.

### Data flow (per command)

```
command → resolve git api → select repo → read diff → parse + classify + clamp
        → build prompt (paths redacted where we add them)
        → withProgress(agentInvoke, { stream: false, agent? })
        → extractReply → sanitize/format → output surface
```

`extractReply`, `clampContext`, `redactPath`, and `QUICK_ASK_MAX_CONTEXT_CHARS`
are reused from `quick-ask.ts` rather than reimplemented.

## Behaviour

### 1. Generate commit message

Contributed to the SCM title bar (`scm/title`, `when: scmProvider == git`) with a
sparkle icon, and to the command palette.

- Diff source: `repo.diff(true)` (staged). Empty → error toast "Nimbus: nothing
  staged to describe." and stop. We deliberately do **not** silently fall back to
  the working tree — the message must describe what will actually be committed.
- Style: `repo.log({ maxEntries: 10 })` subject lines (first line of each
  message) are included as examples. Empty log → conventional-commit instruction.
- Sanitizing: strip surrounding code fences and conversational preamble
  ("Here's a commit message:"), trim trailing whitespace. No length enforcement —
  the prompt asks for a ≤72-char subject and the style examples reinforce it;
  truncating a message mid-word would be worse than a long one.
- Output: `repo.inputBox.value`. Empty → write. Non-empty → modal
  **Replace / Append / Cancel**; Append joins with a blank line.

### 2. Review changes

- Diff source: `repo.diff(false)` (working tree, unstaged). Empty → info toast
  "Nimbus: no working-tree changes to review."
- The prompt asks for a fixed shape: a one-paragraph summary, then findings
  grouped by file, each tagged with a severity. We do **not** parse the reply —
  the shape instruction exists so the tab reads the same every time.
- Output: `openReadonlyJson("Nimbus review.md", markdown)`, prefixed with a
  header naming the repo (basename only) and the files reviewed/omitted.

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
- **Generate Docstrings** → the reply's code block in a read-only tab
  (`Nimbus docstrings.md`), for the user to diff or copy. No edit is applied.
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

1. Split the raw diff on `diff --git ` boundaries into per-file entries, keeping
   each entry's repo-relative path.
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
   to the budget with an explicit `(truncated)` marker in its header. A dead
   command is worse than an honestly-labelled partial one; this is the single
   documented exception to whole-file granularity.
6. Return the selected text plus counts, so the caller can warn: "Nimbus: 3 of 11
   files omitted — diff too large." Secret-skips are reported separately, so a
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

- `scm-diff.test.ts` — splitting, secret-skip on/off, lockfile deprioritization,
  budget selection, the single-oversized-file truncation fallback, omission
  counts, CRLF and binary-file entries, a diff with no `diff --git` header.
- `scm-commit-message.test.ts` — prompt includes style examples; empty-log
  fallback; sanitizing (fences, preamble, trailing whitespace); append vs replace
  composition.
- `scm-review.test.ts` — prompt shape instruction; document header with
  reviewed/omitted counts.
- `scm-generate.test.ts` — filename derivation table incl. dotted names and
  extensionless files; fenced-block extraction and the bare-code fallback.
- `scm-repo-select.test.ts` — zero / one / many repositories.
- `scm-commands.test.ts` — the four handlers end-to-end against a fake
  `GitApiLike`, a fake client, and the existing window stub: disconnected, git
  disabled, no repo, empty diff, clobber modal each branch, agent throw, empty
  reply, and the happy path asserting exactly what was passed to `agentInvoke`.

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
- **`repo.diff()` excludes untracked files.** "Review my changes" will not see a
  brand-new unstaged file. Documented in the command's output header rather than
  worked around, since surfacing untracked content is a separate privacy call.

## Documentation updates

- `docs/settings.md` — the new setting (CI-enforced).
- `docs/architecture.md` — the `src/scm/` seam.
- `docs/ROADMAP.md` — move "Dev-workflow trio" to **Already shipped**.
- `README.md` — the four commands in the feature list.
- `CLAUDE.md` — the surface summary and layout section.
- `CHANGELOG.md` — via Release Please from the `feat(scm): …` commit.
