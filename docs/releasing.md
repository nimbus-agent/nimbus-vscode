# Releasing

Releases are **tag-driven**. Pushing a `vX.Y.Z` tag runs
[`.github/workflows/publish.yml`](../.github/workflows/publish.yml), which
publishes to the VS Code Marketplace and Open VSX and mirrors the `.vsix` on a
GitHub Release. There is no manual `vsce publish` from a laptop.

## How the version is set

The `version` in [`package.json`](../package.json) is only a **baseline**. At
publish time the workflow:

1. Strips the leading `v` from the tag (`v0.3.0` → `0.3.0`) and validates it as
   semver — a non-semver tag fails the run.
2. Stamps that version into `package.json` (`npm pkg set version=…`) so the
   Marketplace, Open VSX, and the `.vsix` filename all match the tag.

So the tag is the source of truth. You do **not** need to bump `package.json`
before tagging (though keeping it roughly in sync is tidy).

## Prerequisites (one-time)

Two repository secrets must exist in the **`release`** environment:

| Secret | What | Scope |
| --- | --- | --- |
| `VSCE_PAT` | Azure DevOps Personal Access Token | **Marketplace (Manage)**, publisher `nimbus-agent` |
| `OVSX_PAT` | Open VSX token | namespace `nimbus-agent` |

The workflow fails fast with a clear error if either is missing, so it never
gets halfway through a release.

## Cutting a release

1. Make sure `main` is green and the full gate passes locally:
   ```bash
   bun run typecheck && bun run lint && bun run test && bun run build && bun run check-bundle
   ```
2. Update [`CHANGELOG.md`](../CHANGELOG.md) for the new version.
3. Tag and push:
   ```bash
   git tag v0.3.0
   git push origin v0.3.0
   ```
4. Watch the **Publish VS Code Extension** workflow run. On success it:
   - typechecks, lints, and tests;
   - stamps the version, builds, and packages `nimbus-<version>.vsix`;
   - publishes to the Marketplace and Open VSX;
   - uploads the `.vsix` as a workflow artifact and attaches it to a GitHub
     Release (with auto-generated notes).

## When a release fails

The publish job is mostly idempotent up to the publish steps. Common cases:

| Symptom | Cause / fix |
| --- | --- |
| Run fails at "Resolve version from tag" | Tag isn't `vMAJOR.MINOR.PATCH` (optionally a `-prerelease` suffix). Delete the tag, re-tag correctly. |
| Fails at "Verify required publish secrets" | `VSCE_PAT` or `OVSX_PAT` missing/expired in the `release` environment. Rotate the token, then re-run. |
| Marketplace publish fails, Open VSX didn't run | The two publishes are separate steps. Fix the cause (usually an expired `VSCE_PAT`) and **re-run the failed jobs** — the version stamp is derived from the tag, so a re-run is safe. |
| Open VSX publish fails after Marketplace succeeded | Don't re-tag (the Marketplace already has this version). Re-run the job, or publish the built `.vsix` to Open VSX manually with `ovsx publish`. |

If you must retract, unpublish from the Marketplace / Open VSX dashboards and cut
a new patch tag — published versions are immutable.
