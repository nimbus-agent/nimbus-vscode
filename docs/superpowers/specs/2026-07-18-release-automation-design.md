# Automated Releases via Release Please — Design

**Date:** 2026-07-18
**Status:** Approved (brainstorming) — pending spec review

## Goal

Automate the nimbus-vscode release flow so cutting a release no longer means a
hand-edited CHANGELOG, a manual prep PR, and a manual `git tag`. Mirror the main
[Nimbus repo](https://github.com/nimbus-agent/Nimbus), which uses
[Release Please](https://github.com/googleapis/release-please): a bot that reads
Conventional Commits on `main` and maintains a standing **release PR**; merging it
creates the tag + GitHub Release, which drives publishing.

## Non-goals

- No change to *what* gets published or *how* (`.vsix` → VS Code Marketplace +
  Open VSX). The existing `publish.yml` remains the publisher.
- No local `commitlint`/git-hook tooling (YAGNI). A CI **PR-title** guard *is*
  included (see Components) — the repo squash-merges, so the PR title is the commit
  Release Please reads, and it's worth protecting from a malformed title.
- Release Please does **not** own the 0.4.0 release (see Sequencing).

## Model

```
push to main (conventional commits)
   └─ release-please.yml → creates/updates a "release PR" (version bump + CHANGELOG)
        └─ human merges the release PR
             └─ release-please creates tag vX.Y.Z + GitHub Release   ← pushed as RELEASE_PLEASE_PAT
                  └─ publish.yml (on: push tags v*) → Marketplace + Open VSX
                       └─ publish.yml `release` job → attaches nimbus-<ver>.vsix to the release
```

**Why a PAT (`RELEASE_PLEASE_PAT`):** a tag/release created with the default
`GITHUB_TOKEN` does **not** trigger other workflows (GitHub's loop-prevention), so
`publish.yml` would never fire. Creating the tag as a PAT identity makes the
`push: tags: v*` event fire normally. This mirrors the Nimbus repo
(`token: ${{ secrets.RELEASE_PLEASE_PAT || github.token }}`).

## Components

### New: `.github/workflows/release-please.yml`
Adapted from Nimbus (`googleapis/release-please-action@v5`), single-package:
- Triggers: `push: branches: [main]` and `workflow_dispatch`.
- Job perms: `contents: write`, `pull-requests: write`.
- `step-security/harden-runner` (audit egress), consistent with the other
  workflows in this repo.
- `token: ${{ secrets.RELEASE_PLEASE_PAT || github.token }}` — falls back to the
  default token (which creates the PR but won't trigger publish) if the PAT is
  absent, so the workflow never hard-fails on a missing secret.
- `config-file: .release-please-config.json`, `manifest-file: .release-please-manifest.json`.

### New: `.release-please-config.json`
Single package at repo root (no monorepo `node-workspace` plugin):
```json
{
  "$schema": "https://raw.githubusercontent.com/googleapis/release-please/main/schemas/config.json",
  "bootstrap-sha": "<the v0.4.0 release commit on main — pinned at implementation>",
  "packages": {
    ".": {
      "release-type": "node",
      "package-name": "nimbus-vscode",
      "include-component-in-tag": false,
      "include-v-in-tag": true,
      "changelog-path": "CHANGELOG.md"
    }
  }
}
```
- `release-type: node` → Release Please reads/bumps `package.json` `version` and
  writes `CHANGELOG.md`. (This makes `package.json` the tracked version rather than
  a frozen `0.2.0` baseline — `publish.yml` still stamps from the tag, so they stay
  consistent.)
- `include-v-in-tag: true` + `include-component-in-tag: false` → tag is exactly
  `vX.Y.Z`, matching `publish.yml`'s `on: push: tags: v*`.

**Lockfile (`bun.lock`):** Release Please's `node` type updates `package.json` (and
standard npm/yarn/pnpm lockfiles), but this repo uses `bun.lock`, which Release
Please does not touch. That is fine here: `bun.lock`'s root workspace entry records
`name` + dependencies but **no `version` field** (verified), so bumping
`package.json`'s `version` cannot desync it, and `publish.yml`'s
`bun install --frozen-lockfile` is unaffected. Rollout sanity check: after the
first Release Please bump, run `bun install --frozen-lockfile` locally to confirm a
clean, no-change install.

### New: `.release-please-manifest.json`
```json
{ ".": "0.4.0" }
```
Reflects the last released version, so the first automated run computes the next
version from commits **after** the v0.4.0 tag.

### Edit: `.github/workflows/publish.yml` (`release` job)
Release Please already creates the GitHub Release with changelog-derived notes.
The current `release` job uses `softprops/action-gh-release` with `name:` and
`generate_release_notes: true`, which would **overwrite** those notes. Change it to
only attach the `.vsix` asset to the existing release — drop `name` and
`generate_release_notes` (keep `tag_name` + `files`). `action-gh-release` updates
the existing release in place, so the asset lands on Release Please's release
without clobbering its title/body. No other `publish.yml` change.

### New: `.github/workflows/pr-title-lint.yml`
A `pull_request` workflow (`amannn/action-semantic-pull-request`, SHA-pinned,
harden-runner, `ubuntu-24.04`) that fails when a PR title isn't a Conventional
Commit. Because the repo squash-merges, the PR title is what lands on `main` and
what Release Please parses — this stops a malformed title from silently producing
no release / miscategorized notes. Default type set, no required scope. (The same
guard is being added to the Nimbus main repo, which had the same gap.)

### Edit: `docs/releasing.md`
Rewrite from the manual "update CHANGELOG, tag, push" procedure to the automated
flow: land Conventional-Commit PRs → review/merge the Release Please PR → publish
happens automatically. Keep the "when a release fails" troubleshooting, adding the
PAT-expiry case (release PR created but no tag/publish → `RELEASE_PLEASE_PAT`
missing/expired).

## Manual step (owner action, documented — cannot be automated)
Create a **fine-grained** Personal Access Token and add it as repo secret
`RELEASE_PLEASE_PAT`:
- Repository access: this repo only.
- Permissions: **Contents: Read and write** (create tags/releases/version-bump
  commits) and **Pull requests: Read and write** (open/update the release PR).
- Without it, the workflow still opens the release PR (via `github.token`) but the
  tag won't trigger `publish.yml` — a clear, documented failure mode.

**Verify no tag/ruleset restriction blocks the PAT actor.** Branch protection on
`main` does not cover tags, but a **tag protection rule** or a **repository ruleset**
that restricts tag creation (or requires signed tags) could make Release Please's
tag push fail. Before relying on automation, confirm in *Settings → Rules/Tags*
that the PAT's actor may create `v*` tags (the fine-grained PAT above has no signing
key, so a "require signed tags" rule would block it).

## Sequencing / rollout

0.4.0 is already prepped by hand (PR #26) with detailed notes, so ship it the
current way and start automation from 0.5.0:

1. Merge PR #26; tag & push `v0.4.0` (manual, one last time) → publishes 0.4.0.
2. Add the `RELEASE_PLEASE_PAT` secret.
3. Merge this release-automation PR with `.release-please-manifest.json` at
   `0.4.0` and `bootstrap-sha` pinned to the v0.4.0 release commit. Get that SHA
   with (after step 1, on an up-to-date `main`):
   ```bash
   git rev-parse v0.4.0^{commit}   # deref the tag to its commit (works for annotated + lightweight)
   git branch --contains "$(git rev-parse v0.4.0^{commit})"   # confirm it lists main
   ```
4. The next `feat:`/`fix:` merged to `main` makes Release Please open the 0.5.0
   release PR. Merging it publishes 0.5.0 end-to-end — the first fully automated
   release.

## Testing / validation

- YAML + JSON validity (`node -e JSON.parse`, and the CI `actionlint` if present).
- Dry-run confidence without publishing: `workflow_dispatch` the release-please
  job on the branch after merge-to-main is not possible pre-merge, so validation
  is (a) schema/lint locally, (b) confirm the release PR appears after step 3, and
  (c) the first real 0.5.0 cut is the end-to-end proof. No unit tests apply
  (workflow/config only).
- Confirm no double-release: after a test cut, exactly one GitHub Release for the
  tag, carrying both Release Please's notes and the `.vsix` asset.

## Risks & mitigations

- **PAT expiry** → release PR appears but nothing publishes. Mitigation:
  documented failure mode + `docs/releasing.md` troubleshooting row; use a
  long-lived fine-grained PAT and calendar its expiry.
- **CHANGELOG format drift** → Release Please prepends its own
  `## [x.y.z](link) (date)` sections above the existing hand-written ones; the
  older sections are left untouched. Cosmetic only.
- **Squash-merge titles** → Release Please derives the changelog from the PR/commit
  title on `main`. The repo already squash-merges with Conventional-Commit titles,
  so this is consistent; call it out in `docs/releasing.md`. A non-conforming title
  (e.g. `update stuff`) silently produces no version bump / miscategorized notes —
  see the optional PR-title guard below.
- **Tag/ruleset restriction** → a tag protection rule, restrictive ruleset, or a
  "require signed tags" rule can block the PAT actor's tag push, so the release PR
  merges but nothing publishes. Mitigation: the rollout verification under *Manual
  step*; symptom is identical to PAT-expiry (release created, no tag/publish).

## Deferred / optional enhancements

- **PR-title validation** — *now included* (see Components → `pr-title-lint.yml`),
  and additionally added to the Nimbus main repo, which had the same gap. Promoted
  from deferred at the owner's request.
- **Local `commitlint` / git hooks** — still out of scope (YAGNI); the CI PR-title
  check covers the case that actually feeds Release Please.

