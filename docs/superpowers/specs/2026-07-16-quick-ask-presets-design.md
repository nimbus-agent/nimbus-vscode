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
  description?: string; // shown as QuickPick detail; optional
}

// Built-in defaults carry no `description` — the labels are self-explanatory.
// The field exists for user-defined presets that want a one-line explainer.
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
// objects or lack a non-empty `label` or `prompt` are dropped; a non-empty
// `description`, when present, is carried through (else omitted).
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
      "prompt": { "type": "string" },
      "description": { "type": "string" }
    }
  }
}
```

Because the setting uses **Replace** semantics, `docs/settings.md` includes the
four default presets as a ready-to-paste JSON block so a user who wants to add
one preset can start from the defaults rather than reconstructing them. (The
`package.json` `description` string names the defaults but does not inline all
four full prompts — that would bloat the Settings UI; the copy-paste block lives
in `docs/settings.md`.)

### Command / menu wiring

Unchanged. Still one `nimbus.quickAsk` command in the editor context menu
(`nimbus@3`, `when: editorTextFocus`) and the command palette. The QuickPick is
internal to the handler.

### QuickPick construction

Build items from `resolvePresets(settings.quickAskPresets())`:

- One item per preset: `{ label: preset.label }`, plus `detail: preset.description`
  when present (codicon optional, not required for v1).
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
- Optional `description`: carried through when a non-empty string; omitted when
  absent, blank, or non-string.

The QuickPick/input-box glue is thin over `vscode-shim`; cover the seam only to
the extent the existing quick-ask handler is covered (no over-testing the
vscode surface).

## Docs (CI-enforced)

- `docs/settings.md`: document `nimbus.quickAsk.presets`, including the four
  default presets as a copy-paste JSON block (Replace semantics — see above).
  **`scripts/check-settings-docs.mjs` fails CI if a contributed setting is
  undocumented — mandatory.**
- `CHANGELOG.md`: add an entry.
- `docs/ROADMAP.md`: move the "Quick-ask preset actions" row from Phase 1 to
  **Already shipped**.

## Deferred (from design review, 2026-07-16)

Considered in [the review](./2026-07-16-quick-ask-presets-design-review.md) and
intentionally **not** in this v1. Each is safely additive later (optional
fields / new commands), so deferring costs no future breaking change.

- **Live-typed custom item in the QuickPick** (type a question, Enter to submit
  without the "Custom question…" round-trip). This is the *right* fix for the
  one-extra-interaction cost that "QuickPick-first" imposes on pure free-form
  use — but it needs the lower-level `window.createQuickPick()` (with an
  `onDidChangeValue` handler) rather than `showQuickPick`, i.e. a new
  `vscode-shim` seam and an event-driven handler + stub. That turns an S into an
  M. **Strongest follow-up candidate** if the extra step proves annoying.
- **Dual command entry points** (`nimbus.quickAsk` free-form + a separate
  presets command). Rejected: it fragments the surface and hides presets behind
  a second command, contradicting the approved "one command, one menu row" goal.
- **Remember last selection.** Needs persisted `globalState`; saves at most one
  keystroke. Not worth the state for v1.
- **`agent` / `model` routing fields on a preset.** Parsing fields that do
  nothing in v1 is misleading dead config (a user sets `agent` and reasonably
  expects it to route). Add them only when per-preset agent selection is
  actually wired — additive at that point.
- **Prompt variable substitution** (`${fileName}`, `${selectedText}`, …).
  Separate feature with its own design: it partly duplicates the existing
  context injection (`buildQuickAskPrompt` already appends the fenced code +
  file header), and `${fileName}`-style templating risks re-introducing the
  absolute-path leak that `redactPath` deliberately prevents. Out of scope.
- **Telemetry / analytics of chosen preset.** No telemetry infrastructure
  exists, and adding it cuts against the local-first / privacy positioning
  (CLAUDE.md: no cloud calls, the privacy moat). A debug-level output-channel
  log line is acceptable if useful; network analytics is not.

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
