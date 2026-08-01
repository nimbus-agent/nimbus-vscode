## Summary

<!-- What does this change and why? -->

## Checklist

- [ ] **PR title is a [Conventional Commit](https://www.conventionalcommits.org)** (`feat:`, `fix:`, `docs:`, `chore:`, …). The repo squash-merges, so this title becomes the commit on `main` — it is what Release Please reads for the version bump and the changelog entry (`pr-title-lint.yml` enforces it).
- [ ] **`CHANGELOG.md` not hand-edited** — Release Please owns it (there is no `Unreleased` section to add to). Your PR title above is what lands there.
- [ ] `bun run typecheck` passes
- [ ] `bun run lint` passes
- [ ] `bun run test` passes (tests added/updated for behavior changes)
- [ ] `bun run build` succeeds, and `bun run check-bundle` + `bun run check-vsix-contents` still pass
- [ ] New/changed runtime or UI surface was driven in an Extension Development Host (F5), not just unit-tested
- [ ] Docs synced for anything user-visible:
  - [ ] New/changed **setting** → `docs/settings.md` **and** the README settings table (CI enforces via `check-settings-docs`)
  - [ ] New **command / surface** → `CLAUDE.md` "Surface today" + the README features list
  - [ ] **Reworded user-facing copy** → grep for the old wording; the same claim is often repeated across the README, `docs/`, and `resources/walkthrough/` (which renders in the Get Started walkthrough)
- [ ] No direct cloud/network calls or imports from the Nimbus gateway (IPC-only via `@nimbus-dev/client`)
