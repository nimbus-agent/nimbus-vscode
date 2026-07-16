## Summary

<!-- What does this change and why? -->

## Checklist

- [ ] `bun run typecheck` passes
- [ ] `bun run lint` passes
- [ ] `bun run test` passes (tests added/updated for behavior changes)
- [ ] `bun run build` succeeds, and `bun run check-bundle` still passes
- [ ] New/changed runtime or UI surface was driven in an Extension Development Host (F5), not just unit-tested
- [ ] Docs synced for anything user-visible:
  - [ ] New/changed **setting** → `docs/settings.md` **and** the README settings table (CI enforces via `check-settings-docs`)
  - [ ] New **command / surface** → `CLAUDE.md` "Surface today" + the README features list
  - [ ] User-visible change → `CHANGELOG.md` (Unreleased)
- [ ] No direct cloud/network calls or imports from the Nimbus gateway (IPC-only via `@nimbus-dev/client`)
