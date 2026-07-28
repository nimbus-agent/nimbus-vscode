# Releasing

Releases are **automated with [Release Please](https://github.com/googleapis/release-please)**.
You do not hand-edit the CHANGELOG or run `git tag`.

## How it works

1. Land PRs on `main` with **Conventional Commit** titles (`feat: …`, `fix: …`,
   `docs: …`, `chore: …`). The repo squash-merges, so the **PR title** becomes the
   commit on `main` — that is what Release Please reads. A
   [PR-title check](../.github/workflows/pr-title-lint.yml) fails the PR when the
   title isn't a valid Conventional Commit, so a malformed title can't slip in.
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

| Secret | Where | What | Why |
| --- | --- | --- | --- |
| `RELEASE_BOT_CLIENT_ID` / `RELEASE_BOT_PRIVATE_KEY` | Organization (`nimbus-agent`) | Credentials for the **"Nimbus Release Bot"** GitHub App, installed on this repo with Contents / Pull requests / Issues write | `release-please.yml` mints a short-lived App token from them and pushes the tag as that identity so `publish.yml` fires (with only the default `GITHUB_TOKEN`, the release PR opens but the tag never triggers publishing). Issues write lets it create the `autorelease:*` labels on the first run. These replaced the retired `RELEASE_PLEASE_PAT` in PR #42. |
| `VSCE_PAT` | Repository | Azure DevOps PAT, **Marketplace (Manage)**, publisher `nimbus-agent` | Marketplace publish. |
| `OVSX_PAT` | Repository | Open VSX token, namespace `nimbus-agent` | Open VSX publish. |

> **Note on the `release` environment.** `publish.yml`'s job declares
> `environment: release`, but `VSCE_PAT` and `OVSX_PAT` are currently configured
> as **repository** secrets, and the `release` environment has no protection
> rules. Publishing works, but the environment provides no approval gate or
> secret isolation today. To get that isolation, move both secrets onto the
> `release` environment (Settings → Environments → release) and add a required
> reviewer; until then, treat any workflow on this repo as able to read them.

Also confirm no **tag protection rule / ruleset** (or "require signed tags") blocks
the Release Bot App from creating `v*` tags (Settings → Rules/Tags).

## Manual release (fallback)

If you must release without Release Please (e.g. it's misconfigured), the tag path
still works: update `CHANGELOG.md` by hand, then `git tag vX.Y.Z && git push origin
vX.Y.Z`. `publish.yml` runs the same way; the GitHub Release will carry the `.vsix`
but no auto notes (Release Please normally writes those).

## When a release fails

| Symptom | Cause / fix |
| --- | --- |
| Release PR opens, but no tag/publish after merge | The Release Bot App token wasn't minted (missing `RELEASE_BOT_CLIENT_ID`/`RELEASE_BOT_PRIVATE_KEY`, the App uninstalled from this repo, or its Contents/Pull-requests/Issues permissions revoked) → the tag was created by `GITHUB_TOKEN` (or not at all) and didn't trigger `publish.yml`. Check the App installation and its repository permissions, then recover by tag state: **no `vX.Y.Z` tag exists** → re-run `release-please` (it creates the tag → publish fires), or push the tag from your machine (`git tag vX.Y.Z <sha> && git push origin vX.Y.Z`). **Tag already exists** (created by `GITHUB_TOKEN`) → re-pushing it is a no-op and won't re-trigger; delete and recreate it from your machine (`git push origin :vX.Y.Z` then `git tag vX.Y.Z <sha> && git push origin vX.Y.Z`), or publish the built `.vsix` by hand (`vsce publish` / `ovsx publish`). |
| No release PR appears after merging `feat:`/`fix:` PRs | PR titles weren't Conventional Commits (nothing to release), or `release-please` didn't run — check the Actions tab. |
| Tag push rejected | A tag protection rule / ruleset (or required signed tags) blocks the Release Bot App. Adjust the rule or exempt the actor. |
| `publish.yml` fails at "Resolve version from tag" | Tag isn't `vMAJOR.MINOR.PATCH` (optionally `-prerelease`). |
| `publish.yml` fails at "Verify required publish secrets" | `VSCE_PAT`/`OVSX_PAT` missing or expired. Check **repository** secrets first — that is where both currently live (see the note above); check the `release` environment only if they have since been moved there. Rotate, then re-run the failed job (safe — version derives from the tag). |
| Marketplace succeeded, Open VSX failed (or vice-versa) | Separate steps. Don't re-tag; re-run the failed job, or publish the built `.vsix` manually (`ovsx publish` / `vsce publish`). |

Published versions are immutable — to retract, unpublish from the dashboards and cut
a new patch.
