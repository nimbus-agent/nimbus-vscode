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

> **Note on the `release` environment.** The environment now carries a
> **deployment branch policy** admitting only `main` and `v*` tags, so a
> workflow added on a feature branch cannot deploy to it. Both jobs that read a
> publish PAT declare `environment: release` — `publish.yml`'s `publish` and
> `secret-health.yml`'s `check` — and `main` is in the policy because the latter
> runs on a Monday cron, which executes from the default branch.
>
> **`VSCE_PAT` and `OVSX_PAT` are still configured as repository secrets**, so
> every workflow on this repo can currently read them; the branch policy does
> not change that. To get real isolation, re-add both under Settings →
> Environments → release → Environment secrets and then **delete the
> repository-scoped copies** — the delete is the step that closes the hole.
> Safe to do here because both consumers are already environment-scoped
> (unlike the monorepo, where several release secrets are read by jobs that do
> not declare the environment).
>
> A required reviewer is deliberately *not* configured: it would suspend every
> release on a manual approval, which defeats the Release Please automation.
> Add one only if you want that trade.

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
| `publish.yml` fails before any step with "not allowed to deploy to release" | The tag or branch is outside the `release` environment's deployment branch policy (`main` + `v*`). Expected for a non-`v*` tag; otherwise widen the policy under Settings → Environments → release. |
| Marketplace succeeded, Open VSX failed (or vice-versa) | Separate steps. Don't re-tag; re-run the failed job, or publish the built `.vsix` manually (`ovsx publish` / `vsce publish`). |

Published versions are immutable — to retract, unpublish from the dashboards and cut
a new patch.

## The weekly credential monitor

`secret-health.yml` runs Mondays 09:00 UTC. It probes both publish tokens against
their real services and classifies each into one verdict
(`scripts/secret-health.ts`, unit-tested in `test/unit/secret-health.test.ts`).

The split that matters is **rejected vs dated**, because the two look similar in a
table and need opposite responses:

| Verdict | Where it comes from | Job outcome | What to do |
| --- | --- | --- | --- |
| `dead` | a **live probe** — the marketplace rejected the token this run | ❌ fails | **Rotate now.** Publishing is blocked today. |
| `not-configured` | the secret is absent | ❌ fails | **Provision.** Do *not* rotate — there is nothing to rotate. |
| `unrecognised` | the probe returned something unexpected | ❌ fails | Diagnose the probe (renamed output, bumped action ref) before trusting any verdict. |
| `expiry-critical` | the **calendar** — ≤14 days of recorded runway | ❌ fails | Replace this week. The token still works; it is about to stop. |
| `expiry-overdue` | the calendar — recorded expiry passed, but the token still authenticates | ❌ fails | **Correct the record**, don't rotate blindly: the token was probably regenerated without updating the date. |
| `expiry-approaching` | the calendar — 15–90 days out | 🟡 warns, job stays green | Schedule the regeneration. This is not an emergency and is not a rotation trigger. |
| `unreachable` | the probe could not reach the service | 🟡 warns | Re-run. This is **not** evidence of revocation. |

An issue is filed only for a ❌ verdict. `expiry-approaching` is true for up to 76
consecutive days, and an issue left open that long is how the *next* real finding
gets skimmed past — so the warning half lives in the run's `::warning::`
annotations and step summary, which cannot accumulate. When an issue is filed, its
body carries every row under its own heading, so a dated row is still visible
there and can never appear under **BROKEN**.

**Where the dates come from.** `DECLARED_EXPIRY` in `scripts/secret-health.ts` is a
*mirror*. The source of truth is `scripts/release/credential-registry.ts` in
[`nimbus-agent/Nimbus`](https://github.com/nimbus-agent/Nimbus), whose own weekly
monitor audits this repo's secrets org-wide. When a token is regenerated, update
the registry first, then the mirror. Drift can only produce a spurious *warning* —
never a false "healthy", because the liveness probe is never softened by a date.
