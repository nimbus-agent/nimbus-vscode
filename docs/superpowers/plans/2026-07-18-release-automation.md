# Automated Releases via Release Please — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automate nimbus-vscode releases so cutting one means merging a bot-maintained "release PR" — no hand-edited CHANGELOG, no manual `git tag` — with the existing `publish.yml` doing the actual Marketplace/Open VSX publish.

**Architecture:** Add [Release Please](https://github.com/googleapis/release-please) (mirroring the main Nimbus repo). On every push to `main` it reads Conventional Commits and maintains a release PR (version bump + CHANGELOG). Merging that PR creates the `vX.Y.Z` tag + GitHub Release; the tag is pushed as a PAT identity so the existing `publish.yml` (`on: push: tags: v*`) fires and publishes.

**Tech Stack:** GitHub Actions (YAML), Release Please config (JSON), `release-type: node` (bumps `package.json` + writes `CHANGELOG.md`).

**Spec:** [docs/superpowers/specs/2026-07-18-release-automation-design.md](../specs/2026-07-18-release-automation-design.md)

## Global Constraints

- **Single package** — one package at repo root (`"."`); no monorepo `node-workspace` plugin.
- **Tag shape** — `include-v-in-tag: true`, `include-component-in-tag: false` → tag is exactly `vX.Y.Z`, matching `publish.yml`'s `on: push: tags: v*`.
- **PAT trigger** — the workflow token is `${{ secrets.RELEASE_PLEASE_PAT || github.token }}`; a tag created by the default `GITHUB_TOKEN` will **not** trigger `publish.yml`, so the PAT is what makes publishing fire.
- **Pin actions by SHA** — every `uses:` is pinned to a full commit SHA with a `# vX.Y.Z` comment, matching this repo's existing workflows.
- **Harden runner** — every job's first step is `step-security/harden-runner@9af89fc71515a100421586dfdb3dc9c984fbf411 # v2.19.4` with `egress-policy: audit`.
- **`publish.yml` is otherwise unchanged** — only its final "attach .vsix to release" step is edited so it does not overwrite the notes Release Please writes.
- **Manifest baseline** — `.release-please-manifest.json` starts at `0.4.0` (0.4.0 ships manually via PR #26; automation owns 0.5.0+).
- **PR-title lint is included** — a `pull_request` workflow enforces Conventional-Commit PR titles (squash-merge uses the title as the `main` commit Release Please reads). No `commitlint`/local hooks (still YAGNI).

## Prerequisites / rollout ordering (owner actions — see final section)

This plan produces the release-automation files on a branch. It is **prepared now** but its PR should **merge only after** 0.4.0 has been released manually and the `RELEASE_PLEASE_PAT` secret exists. The tasks below are safe to author at any time; Task 4 documents the manual rollout.

## File Structure

- **Task 1 — Release Please setup:** create `.github/workflows/release-please.yml`, `.release-please-config.json`, `.release-please-manifest.json`, and `.github/workflows/pr-title-lint.yml` (guards the Conventional-Commit titles Release Please depends on).
- **Task 2 — publish integration:** modify `.github/workflows/publish.yml` (the final release-asset step only).
- **Task 3 — docs:** rewrite `docs/releasing.md` for the automated flow.
- **Task 4 — rollout checklist:** manual owner actions (PAT, sequencing, verification) — documentation, no code.

---

## Task 1: Release Please config + workflow

**Files:**
- Create: `.release-please-config.json`
- Create: `.release-please-manifest.json`
- Create: `.github/workflows/release-please.yml`
- Create: `.github/workflows/pr-title-lint.yml`

**Interfaces:**
- Consumes: the repo's `package.json` (`version`, `name: nimbus-vscode`) and `CHANGELOG.md`.
- Produces: a `release-please` workflow on `main` that maintains a release PR and, on merge, creates tag `vX.Y.Z` + a GitHub Release (the tag Task 2's `publish.yml` consumes), plus a `pull_request` workflow that fails when a PR title isn't a Conventional Commit (protecting the titles Release Please reads).

- [ ] **Step 1: Create `.release-please-manifest.json`**

```json
{
  ".": "0.4.0"
}
```

- [ ] **Step 2: Create `.release-please-config.json`**

`bootstrap-sha` is the current `main` tip (a real commit — the walkthrough merge). Once `v0.4.0` is tagged, the tag governs the "last release" and this only bounds the first history scan; Step 6 of Task 4 re-pins it to the v0.4.0 commit before the automation PR merges.

```json
{
  "$schema": "https://raw.githubusercontent.com/googleapis/release-please/main/schemas/config.json",
  "bootstrap-sha": "eec2112b82cf6c09aa5e66769179ac58e1c6dc8c",
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

- [ ] **Step 3: Create `.github/workflows/release-please.yml`**

```yaml
name: release-please

# On every push to main, Release Please reads Conventional Commits and maintains
# a "release PR" (version bump + CHANGELOG). Merging that PR creates the vX.Y.Z
# tag + GitHub Release. The tag is pushed as RELEASE_PLEASE_PAT so publish.yml
# (on: push tags v*) fires — a tag from the default GITHUB_TOKEN would not.
on:
  push:
    branches: [main]
  workflow_dispatch:

permissions:
  contents: read
  pull-requests: read

jobs:
  release-please:
    runs-on: ubuntu-24.04
    timeout-minutes: 10
    permissions:
      contents: write
      pull-requests: write
    steps:
      - name: Harden Runner
        uses: step-security/harden-runner@9af89fc71515a100421586dfdb3dc9c984fbf411 # v2.19.4
        with:
          egress-policy: audit

      - uses: googleapis/release-please-action@45996ed1f6d02564a971a2fa1b5860e934307cf7 # v5.0.0
        with:
          config-file: .release-please-config.json
          manifest-file: .release-please-manifest.json
          token: ${{ secrets.RELEASE_PLEASE_PAT || github.token }}
```

- [ ] **Step 3b: Create `.github/workflows/pr-title-lint.yml`**

Guards the Conventional-Commit PR titles Release Please reads (the repo
squash-merges, so the PR title becomes the `main` commit).

```yaml
name: Lint PR Title

# The repo squash-merges, so the PR title becomes the commit on `main` that
# Release Please reads to compute the version bump and changelog. Enforce a
# Conventional Commit title so a malformed one can't silently break a release.
on:
  pull_request:
    types: [opened, edited, synchronize, reopened]

permissions:
  contents: read

jobs:
  lint-pr-title:
    name: Validate PR title
    runs-on: ubuntu-24.04
    timeout-minutes: 5
    permissions:
      pull-requests: read
    steps:
      - name: Harden Runner
        uses: step-security/harden-runner@9af89fc71515a100421586dfdb3dc9c984fbf411 # v2.19.4
        with:
          egress-policy: audit

      - uses: amannn/action-semantic-pull-request@0723387faaf9b38adef4775cd42cfd5155ed6017 # v5.5.3
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

- [ ] **Step 4: Validate the two JSON files parse**

Run:
```bash
node -e "JSON.parse(require('fs').readFileSync('.release-please-config.json','utf8')); JSON.parse(require('fs').readFileSync('.release-please-manifest.json','utf8')); console.log('json ok')"
```
Expected: `json ok`.

- [ ] **Step 5: Validate the workflow YAML**

Run whichever is available (bun is the repo's toolchain, so the `bunx` form needs no Python):
```bash
bunx yaml-lint .github/workflows/release-please.yml .github/workflows/pr-title-lint.yml   # Node fallback (no Python)
```
Expected: `√ YAML Lint successful.` for both. Last resort: push the branch and let GitHub's workflow validator catch a malformed file (a bad workflow surfaces as a failed/skipped run in the Actions tab).

- [ ] **Step 6: Commit**

```bash
git add .release-please-config.json .release-please-manifest.json .github/workflows/release-please.yml .github/workflows/pr-title-lint.yml
git commit -m "ci: add Release Please + Conventional-Commit PR-title lint

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: publish.yml integration (don't clobber Release Please's notes)

**Files:**
- Modify: `.github/workflows/publish.yml` (the final `release` job's "Upload .vsix to GitHub Release" step)

**Interfaces:**
- Consumes: the `vX.Y.Z` tag + GitHub Release created by Task 1 (Release Please writes the release title/body from the changelog).
- Produces: the same publish behavior, but the release step now only *attaches* the `.vsix` asset instead of setting `name`/`generate_release_notes` (which would overwrite Release Please's notes).

- [ ] **Step 1: Edit the release-asset step**

In `.github/workflows/publish.yml`, replace this step:

```yaml
      - name: Upload .vsix to GitHub Release
        uses: softprops/action-gh-release@718ea10b132b3b2eba29c1007bb80653f286566b # v3.0.1
        with:
          files: dist-vsix/nimbus-${{ needs.publish.outputs.version }}.vsix
          tag_name: ${{ github.ref_name }}
          name: VS Code extension ${{ needs.publish.outputs.version }}
          generate_release_notes: true
```

with (drop `name` and `generate_release_notes` so Release Please owns the release title/body; the action updates the existing release in place, adding the asset):

```yaml
      - name: Attach .vsix to the GitHub Release
        # Release Please already created the release with changelog-derived notes;
        # only attach the packaged .vsix, don't overwrite its title/body. (For a
        # manual tag with no pre-existing release, this creates a bare release with
        # just the asset — the expected exception now that releases are automated.)
        uses: softprops/action-gh-release@718ea10b132b3b2eba29c1007bb80653f286566b # v3.0.1
        with:
          files: dist-vsix/nimbus-${{ needs.publish.outputs.version }}.vsix
          tag_name: ${{ github.ref_name }}
```

- [ ] **Step 2: Validate the workflow YAML**

Run whichever is available:
```bash
bunx yaml-lint .github/workflows/publish.yml                                                     # Node fallback (no Python)
python -c "import yaml; yaml.safe_load(open('.github/workflows/publish.yml')); print('yaml ok')" # if pyyaml is present
```
Expected: valid YAML confirmed.

- [ ] **Step 3: Confirm no other publish behavior changed**

Run:
```bash
git diff --stat .github/workflows/publish.yml
git diff .github/workflows/publish.yml
```
Expected: the diff touches **only** the single release-asset step (renamed step, two removed keys). If anything else changed, revert it.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/publish.yml
git commit -m "ci: publish attaches .vsix without overwriting Release Please notes

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Rewrite `docs/releasing.md` for the automated flow

**Files:**
- Modify: `docs/releasing.md` (full rewrite)

**Interfaces:**
- Consumes: the workflows from Tasks 1–2 and the `RELEASE_PLEASE_PAT` secret (Task 4).
- Produces: contributor-facing docs describing the automated release flow + troubleshooting.

- [ ] **Step 1: Replace the file contents**

Overwrite `docs/releasing.md` with:

```markdown
# Releasing

Releases are **automated with [Release Please](https://github.com/googleapis/release-please)**.
You do not hand-edit the CHANGELOG or run `git tag`.

## How it works

1. Land PRs on `main` with **Conventional Commit** titles (`feat: …`, `fix: …`,
   `docs: …`, `chore: …`). The repo squash-merges, so the **PR title** becomes the
   commit on `main` — that is what Release Please reads.
2. [`release-please.yml`](../.github/workflows/release-please.yml) runs on every
   push to `main` and maintains a standing **"release PR"** that bumps the version
   in `package.json` and prepends a `CHANGELOG.md` section from the commits since
   the last release. `feat:` → minor, `fix:` → patch, `feat!:`/`BREAKING CHANGE` →
   major.
3. **Merging the release PR** makes Release Please create the `vX.Y.Z` tag and a
   GitHub Release (notes from the changelog).
4. That tag triggers [`publish.yml`](../.github/workflows/publish.yml), which
   stamps the version, builds, packages `nimbus-<version>.vsix`, publishes to the
   VS Code Marketplace and Open VSX, and attaches the `.vsix` to the release.

So a release is: **merge feature PRs → review & merge the release PR → done.**

## The version tag

The tag is the source of truth for the published version (`publish.yml` stamps it
into `package.json` at build time). Release Please also keeps `package.json`'s
`version` field in sync in the release PR, so the two agree. `bun.lock` is not
affected — it records dependencies, not this package's own version.

## Prerequisites (one-time)

Repository secrets:

| Secret | What | Why |
| --- | --- | --- |
| `RELEASE_PLEASE_PAT` | Fine-grained PAT — **Contents: RW** + **Pull requests: RW**, this repo only | Release Please pushes the tag as this identity so `publish.yml` fires. With only the default `GITHUB_TOKEN`, the release PR still opens but the tag never triggers publishing. |
| `VSCE_PAT` | Azure DevOps PAT, **Marketplace (Manage)**, publisher `nimbus-agent` | Marketplace publish (in the `release` environment). |
| `OVSX_PAT` | Open VSX token, namespace `nimbus-agent` | Open VSX publish (in the `release` environment). |

Also confirm no **tag protection rule / ruleset** (or "require signed tags") blocks
the PAT actor from creating `v*` tags (Settings → Rules/Tags).

## Manual release (fallback)

If you must release without Release Please (e.g. it's misconfigured), the tag path
still works: update `CHANGELOG.md` by hand, then `git tag vX.Y.Z && git push origin
vX.Y.Z`. `publish.yml` runs the same way; the GitHub Release will carry the `.vsix`
but no auto notes (Release Please normally writes those).

## When a release fails

| Symptom | Cause / fix |
| --- | --- |
| Release PR opens, but no tag/publish after merge | `RELEASE_PLEASE_PAT` missing or expired → the tag was created by `GITHUB_TOKEN` (or not at all) and didn't trigger `publish.yml`. Rotate the PAT; re-run `release-please` (or push a lightweight `vX.Y.Z` tag manually to trigger publish for the already-merged version). |
| No release PR appears after merging `feat:`/`fix:` PRs | PR titles weren't Conventional Commits (nothing to release), or `release-please` didn't run — check the Actions tab. |
| Tag push rejected | A tag protection rule / ruleset (or required signed tags) blocks the PAT actor. Adjust the rule or exempt the actor. |
| `publish.yml` fails at "Resolve version from tag" | Tag isn't `vMAJOR.MINOR.PATCH` (optionally `-prerelease`). |
| `publish.yml` fails at "Verify required publish secrets" | `VSCE_PAT`/`OVSX_PAT` missing/expired in the `release` environment. Rotate, then re-run the failed job (safe — version derives from the tag). |
| Marketplace succeeded, Open VSX failed (or vice-versa) | Separate steps. Don't re-tag; re-run the failed job, or publish the built `.vsix` manually (`ovsx publish` / `vsce publish`). |

Published versions are immutable — to retract, unpublish from the dashboards and cut
a new patch.
```

- [ ] **Step 2: Sanity-check the doc**

Run:
```bash
grep -n "RELEASE_PLEASE_PAT\|release-please.yml\|publish.yml" docs/releasing.md
```
Expected: references to all three appear (the doc names the workflows and the PAT).

- [ ] **Step 3: Commit**

```bash
git add docs/releasing.md
git commit -m "docs: rewrite releasing.md for the automated Release Please flow

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Rollout checklist (manual owner actions — no code)

These steps are performed by a maintainer with repo-admin access; they cannot be
scripted here. Do them in order. **Do not merge the release-automation PR (Tasks
1–3) until steps 1–2 are done.**

- [ ] **Step 1: Ship 0.4.0 the manual way.** Merge PR #26, then:
  ```bash
  git checkout main && git pull --ff-only origin main
  git tag v0.4.0 && git push origin v0.4.0
  ```
  Watch **Publish VS Code Extension** succeed (Marketplace + Open VSX + Release).

- [ ] **Step 2: Create the `RELEASE_PLEASE_PAT` secret.** GitHub → *Settings →
  Developer settings → Fine-grained tokens*: this repo only, **Contents: Read and
  write** + **Pull requests: Read and write**. Add it as a repo secret named
  `RELEASE_PLEASE_PAT`. Confirm no tag protection rule blocks it.

- [ ] **Step 3: Re-pin `bootstrap-sha` to the v0.4.0 commit** (in the
  release-automation branch, before merging its PR):
  ```bash
  git rev-parse v0.4.0^{commit}                 # copy this SHA
  git branch --contains "$(git rev-parse v0.4.0^{commit})"   # must list main
  ```
  Set `.release-please-config.json`'s `bootstrap-sha` to that SHA, commit, push.

- [ ] **Step 4: Merge the release-automation PR** (Tasks 1–3).

- [ ] **Step 5: Verify automation.** On the next `feat:`/`fix:` merged to `main`,
  confirm a **release PR** appears (titled e.g. `chore(main): release 0.5.0`).
  Merging it should create `v0.5.0` + a Release and trigger `publish.yml`. Confirm
  exactly **one** GitHub Release for `v0.5.0`, carrying both the changelog notes and
  the `.vsix`. `bun.lock` needs no attention — verified empirically that bumping
  `package.json`'s `version` leaves `bun.lock` unchanged and still passes
  `bun install --frozen-lockfile` (the lockfile tracks dependencies, not this
  package's own version).

---

## Notes for the implementer

- Tasks 1–3 are authored on a feature branch (`feat/release-automation`) and ship as one PR; Task 4 is the human rollout around merging it.
- Action SHAs (`harden-runner`, `release-please-action`, `action-gh-release`) match those already used in this repo / the Nimbus repo — keep them pinned.
- No unit tests apply (workflow + config only); validation is JSON/YAML parse + the first real 0.5.0 cut as the end-to-end proof (spec § Testing).
