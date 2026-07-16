# Quick-Ask Preset Actions — Design

**Date:** 2026-07-16
**Status:** Approved (brainstorming) → ready for implementation plan
**Roadmap item:** Phase 1 — "Quick-ask preset actions (Explain / Fix / Review / Docstring)" (effort S)

## Summary

Add canned prompt presets to the existing `nimbus.quickAsk` one-shot editor
quick-ask. Instead of always typing a question, the user picks a preset
(Explain / Fix / Review / Docstring) from a QuickPick; the input box then opens
**pre-filled** with that preset's prompt (editable, Enter to send). A
`Custom question…` row preserves today's free-form behavior. Presets are
**user-configurable** via a new `nimbus.quickAsk.presets` setting with
**Replace** semantics (empty = the four built-in defaults).

This rides the existing `agentInvoke` RPC — no `@nimbus-dev/client` bump, no new
Gateway capability.

## Goals

- One click from the editor to a common action, skipping prompt retyping.
- Keep the surface minimal: one command, one context-menu row.
- Preserve the existing free-form quick-ask unchanged.
- Let power users override the preset list via settings.

## Non-goals (YAGNI)

- No preset `id` field, no merge-onto-defaults behavior.
- No per-preset agent selection.
- No streaming / cancellation (Phase 4).
- No apply-as-`WorkspaceEdit` / code-editing actions (separate Phase 3 item).

## Current behavior (baseline)

`nimbus.quickAsk` in `src/extension.ts` (~line 538):

1. Require an active editor.
2. Selection (non-whitespace) → "selected code"; else whole file → "active
   file". Clamp context to `QUICK_ASK_MAX_CONTEXT_CHARS` (50k); warn on
   truncation.
3. Require a connected client.
4. `showInputBox` for the free-form question (`validateQuestion`).
5. `buildQuickAskPrompt({ question, code, filePath: redactPath(...), languageId,
   truncated })`.
6. `agentInvoke(prompt, { stream: false, agent? })` inside `withProgress`.
7. `extractReply` → `openReadonlyJson("Nimbus reply.md", reply)`; else info
   message.

Pure helpers live in `src/quick-ask.ts` and are already unit-tested.

## Design

### Flow (changed step in **bold**)

1. Resolve editor context exactly as today (selection vs whole file, clamp,
   truncation warning). **Unchanged.**
2. **Resolve presets from settings and show a QuickPick:** the resolved presets
   in order, followed by a `Custom question…` row.
3. **Open the input box seeded with the picked preset's `prompt`** (editable,
   Enter to send). `Custom question…` seeds it empty — i.e. today's input box.
4. Build the prompt, call `agentInvoke`, render the reply in a read-only tab.
   **Unchanged.**

Cancelling either the QuickPick or the input box aborts silently, as today. The
`validateQuestion` guard still applies to the (possibly edited) input value, so
a preset whose text is cleared to whitespace is rejected the same as an empty
custom question.

### New module — `src/quick-ask-presets.ts`

`vscode`-free pure module, mirroring `src/sidebar/agents.ts` (`parseAgents`):

```ts
export interface QuickAskPreset {
  label: string;
  prompt: string;
}

export const DEFAULT_QUICK_ASK_PRESETS: QuickAskPreset[] = [
  { label: "Explain", prompt: "Explain what this code does, step by step." },
  {
    label: "Fix",
    prompt:
      "Identify and fix any bugs or issues in this code. Show the corrected code and explain the changes.",
  },
  {
    label: "Review",
    prompt:
      "Review this code for correctness, clarity, and potential improvements.",
  },
  { label: "Docstring", prompt: "Write a docstring / doc comment for this code." },
];

// Coerce the untrusted nimbus.quickAsk.presets setting into presets.
// Non-array input, or a list with no valid entries, yields the built-in
// defaults (Replace semantics with a safe fallback). Entries that are not
// objects or lack a non-empty `label` or `prompt` are dropped.
export function resolvePresets(raw: unknown): QuickAskPreset[];
```

Validation reuses `asRecord` / `asNonEmptyString` from
`src/sidebar/parse-helpers.ts`. Rationale for the all-invalid fallback: a
misconfigured setting should never leave the menu with only `Custom question…`.

### Settings

- `src/settings.ts`: add `quickAskPresets(): unknown` →
  `cfg().get<unknown>("quickAsk.presets", [])` (returns raw, like `agents()`;
  validation lives in `resolvePresets`). Add to the `Settings` interface.
- `package.json` → `contributes.configuration.properties`: add
  `nimbus.quickAsk.presets`:

```jsonc
"nimbus.quickAsk.presets": {
  "type": "array",
  "default": [],
  "description": "Preset quick-ask actions shown before the input box. Each item: { \"label\": string, \"prompt\": string }. Empty = built-in defaults (Explain, Fix, Review, Docstring). A non-empty list replaces the defaults.",
  "items": {
    "type": "object",
    "required": ["label", "prompt"],
    "properties": {
      "label": { "type": "string" },
      "prompt": { "type": "string" }
    }
  }
}
```

### Command / menu wiring

Unchanged. Still one `nimbus.quickAsk` command in the editor context menu
(`nimbus@3`, `when: editorTextFocus`) and the command palette. The QuickPick is
internal to the handler.

### QuickPick construction

Build items from `resolvePresets(settings.quickAskPresets())`:

- One item per preset: `{ label: preset.label }` (optionally a codicon later —
  not required for v1).
- A trailing `{ label: "Custom question…" }` item.

Picking maps back to the seed value: a preset → `preset.prompt`; the custom row
→ `""`. Use a sentinel (e.g. a `preset?: QuickAskPreset` field on the item, or
identity comparison) rather than matching on label text, so a user-configured
preset literally named "Custom question…" is not misread as the custom row.

### vscode-shim

`window.showQuickPick` is already part of the shim (Search uses it), so no new
seam is required. Confirm the existing signature supports the item shape used
here; extend the stub in `test/unit/vscode-stub.ts` only if needed.

## Testing

Unit tests for `resolvePresets` (new `test/unit/quick-ask-presets.test.ts` or
alongside existing quick-ask tests):

- Empty `[]` → `DEFAULT_QUICK_ASK_PRESETS`.
- Valid list → that list, in order.
- Non-array inputs (string, object, `null`, `undefined`, number) → defaults.
- Mixed valid + invalid entries → valid entries only, in order.
- All-invalid entries (missing/blank `label` or `prompt`, non-object) →
  defaults.

The QuickPick/input-box glue is thin over `vscode-shim`; cover the seam only to
the extent the existing quick-ask handler is covered (no over-testing the
vscode surface).

## Docs (CI-enforced)

- `docs/settings.md`: document `nimbus.quickAsk.presets`. **`scripts/check-settings-docs.mjs`
  fails CI if a contributed setting is undocumented — mandatory.**
- `CHANGELOG.md`: add an entry.
- `docs/ROADMAP.md`: move the "Quick-ask preset actions" row from Phase 1 to
  **Already shipped**.

## Files touched

| File | Change |
| --- | --- |
| `src/quick-ask-presets.ts` | **new** — `QuickAskPreset`, `DEFAULT_QUICK_ASK_PRESETS`, `resolvePresets` |
| `src/settings.ts` | add `quickAskPresets()` + interface member |
| `src/extension.ts` | `nimbus.quickAsk` handler: QuickPick → seeded input box |
| `package.json` | add `nimbus.quickAsk.presets` configuration property |
| `test/unit/quick-ask-presets.test.ts` | **new** — `resolvePresets` tests |
| `docs/settings.md` | document the setting |
| `CHANGELOG.md` | entry |
| `docs/ROADMAP.md` | item → Already shipped |

## Verification

`bun run typecheck && bun run lint && bun run test && bun run build &&
bun run check-bundle && bun run check-settings-docs`.
