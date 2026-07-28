---
name: verify-extension
description: Verify a change to the nimbus-vscode extension actually works — run the full local gate (test, typecheck, lint, build, bundle, .vsix-contents + settings-doc guards) and, for anything with runtime/UI surface, drive it in an Extension Development Host. Use before committing a non-trivial change, opening a PR, or claiming a fix works.
---

# Verify the nimbus-vscode extension

This is a thin VS Code client over `@nimbus-dev/client` (see `CLAUDE.md`). "Verify"
here means two layers: the automated gate, then — for changes with a runtime or UI
surface — actually driving the feature in a real VS Code window.

## Layer 1 — the full automated gate (always)

Run all of these; every one must pass before a change is "verified":

```bash
bun run test          # vitest — unit tests (vscode is stubbed)
bun run typecheck     # tsc --noEmit (strict; no `any`)
bun run lint          # biome check . (whole repo)
bun run build         # esbuild bundles to dist/ + media/
bun run check-bundle  # asserts vscode is the bundle's only external (run AFTER build)
bun run check-vsix-contents  # asserts the .vsix ships only allowlisted files (run AFTER build)
bun run check-settings-docs  # every nimbus.* setting is documented
```

One-liner: `bun run test && bun run typecheck && bun run lint && bun run build && bun run check-bundle && bun run check-vsix-contents && bun run check-settings-docs`

Notes:
- Editor "stale diagnostic" popups can lag a mid-edit state — trust `bun run typecheck`
  over an IDE squiggle. If they disagree, re-run typecheck.
- `check-bundle` only means something after a fresh `build`.

## Layer 2 — drive it in an Extension Development Host (runtime/UI changes)

Unit tests stub `vscode`, so they cannot prove a command, menu, webview, or
Gateway round-trip actually works. For any change to a command handler, the
sidebar, the chat webview, or client IPC usage, launch the extension and exercise
the real flow:

1. Open the repo in VS Code and press **F5** (the "Run Extension" launch config)
   to open an Extension Development Host window with the extension loaded.
2. Ensure a Nimbus Gateway is running (or set `nimbus.autoStartGateway`), so IPC
   calls resolve.
3. Drive the specific change end to end and observe the real behavior — e.g. for
   a new command, run it from the Command Palette / context menu and confirm the
   result; for a settings change, toggle the setting and confirm it takes effect.

If a change has genuinely no runtime surface (docs, pure refactor covered by
tests), Layer 1 is sufficient — say so explicitly rather than claiming a UI check
you didn't run.

## Reporting

State what you ran and what you observed. If you skipped Layer 2, say why (no
runtime surface). Never claim "verified" on the strength of unit tests alone for a
change that touches a real VS Code surface.
