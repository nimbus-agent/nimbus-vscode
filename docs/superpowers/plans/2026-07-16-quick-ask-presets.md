# Quick-Ask Preset Actions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add configurable preset actions (Explain / Fix / Review / Docstring) to the existing `nimbus.quickAsk` command — a picker that pre-fills the input box with a canned prompt, plus a Custom-question row that preserves today's free-form flow.

**Architecture:** A new pure module `src/quick-ask-presets.ts` coerces the untrusted `nimbus.quickAsk.presets` setting into typed presets (mirroring `src/sidebar/agents.ts`'s `parseAgents`). The `nimbus.quickAsk` handler in `src/extension.ts` gains one step: after the connection check it shows a `showQuickPick` of the resolved presets plus a `Custom question…` row, then opens the existing input box seeded (via `value`) with the chosen preset's prompt. Everything downstream (`buildQuickAskPrompt`, `agentInvoke`, read-only reply tab) is unchanged.

**Tech Stack:** TypeScript (strict), Vitest, esbuild, Biome, the `vscode` API touched only through `src/vscode-shim.ts`.

## Global Constraints

- TypeScript **strict**; **no `any`** — use `unknown` for external data (Biome `noExplicitAny`).
- Log only via the output channel (`logging.ts`); **no `console`** in `src/` (Biome `noConsole`). No non-null assertions (`noNonNullAssertion`).
- The `vscode` API is touched only through `src/vscode-shim.ts`; tests use `test/unit/vscode-stub.ts`.
- `@nimbus-dev/client` stays a **published** version (`^0.4.0`); this feature adds **no** client dependency — it rides the existing `agentInvoke` RPC.
- Follow existing patterns: untrusted config is coerced with `asRecord` / `asNonEmptyString` from `src/sidebar/parse-helpers.ts`; optional properties are assigned conditionally (project uses `exactOptionalPropertyTypes`).
- Every contributed `nimbus.*` setting MUST be documented in **both** `docs/settings.md` (a `### `nimbus.x`` section) **and** the `README.md` settings table — `scripts/check-settings-docs.mjs` fails CI otherwise.
- Full verification chain (run before each commit that touches `src/`, `package.json`, or the docs): `bun run typecheck && bun run lint && bun run test && bun run build && bun run check-bundle && bun run check-settings-docs`.
- Commit trailer for every commit:

  ```
  Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
  ```

- Work happens on branch `feat/quick-ask-presets` (already checked out).

---

### Task 1: Preset resolution module + settings accessor

**Files:**
- Create: `src/quick-ask-presets.ts`
- Modify: `src/settings.ts` (add `quickAskPresets()` to the interface and the implementation)
- Test: `test/unit/quick-ask-presets.test.ts` (create)
- Test: `test/unit/settings.test.ts` (extend the two existing cases)

**Interfaces:**
- Consumes: `asRecord`, `asNonEmptyString` from `src/sidebar/parse-helpers.ts`; `WorkspaceApi` from `src/vscode-shim.ts` (already imported in `settings.ts`).
- Produces (later tasks rely on these exact names/types):
  - `interface QuickAskPreset { label: string; prompt: string; description?: string }`
  - `const DEFAULT_QUICK_ASK_PRESETS: QuickAskPreset[]`
  - `function resolvePresets(raw: unknown): QuickAskPreset[]`
  - `Settings.quickAskPresets(): unknown` (returns the raw setting value, like `agents()`)

- [ ] **Step 1: Write the failing test for `resolvePresets`**

Create `test/unit/quick-ask-presets.test.ts`:

```ts
import { describe, expect, test } from "vitest";

import {
  DEFAULT_QUICK_ASK_PRESETS,
  resolvePresets,
} from "../../src/quick-ask-presets.js";

describe("resolvePresets", () => {
  test("empty array yields the built-in defaults", () => {
    expect(resolvePresets([])).toEqual(DEFAULT_QUICK_ASK_PRESETS);
  });

  test("a valid list is returned in order, carrying an optional description", () => {
    const raw = [
      { label: "Test", prompt: "Write tests." },
      { label: "Types", prompt: "Improve the types.", description: "type pass" },
    ];
    expect(resolvePresets(raw)).toEqual([
      { label: "Test", prompt: "Write tests." },
      { label: "Types", prompt: "Improve the types.", description: "type pass" },
    ]);
  });

  test("non-array inputs yield the defaults", () => {
    expect(resolvePresets(undefined)).toEqual(DEFAULT_QUICK_ASK_PRESETS);
    expect(resolvePresets("nope")).toEqual(DEFAULT_QUICK_ASK_PRESETS);
    expect(resolvePresets({ label: "x", prompt: "y" })).toEqual(DEFAULT_QUICK_ASK_PRESETS);
  });

  test("invalid entries are dropped; valid ones kept in order", () => {
    const raw = [
      { label: "Good", prompt: "ok" },
      { label: "", prompt: "no label" },
      { label: "No prompt" },
      null,
      42,
      { label: "Also good", prompt: "yes" },
    ];
    expect(resolvePresets(raw)).toEqual([
      { label: "Good", prompt: "ok" },
      { label: "Also good", prompt: "yes" },
    ]);
  });

  test("a list with no valid entries falls back to defaults", () => {
    expect(resolvePresets([{ label: "" }, { prompt: "" }, null])).toEqual(
      DEFAULT_QUICK_ASK_PRESETS,
    );
  });

  test("a non-string description is omitted", () => {
    expect(resolvePresets([{ label: "L", prompt: "P", description: 42 }])).toEqual([
      { label: "L", prompt: "P" },
    ]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bunx vitest run test/unit/quick-ask-presets.test.ts`
Expected: FAIL — cannot resolve `../../src/quick-ask-presets.js` (module does not exist yet).

- [ ] **Step 3: Create `src/quick-ask-presets.ts`**

```ts
import { asNonEmptyString, asRecord } from "./sidebar/parse-helpers.js";

// One preset quick-ask action, projected from the untrusted
// nimbus.quickAsk.presets setting. We own this type; it is not from the SDK.
export interface QuickAskPreset {
  label: string;
  prompt: string;
  description?: string;
}

// Built-in presets shown when nimbus.quickAsk.presets is empty. The labels are
// self-explanatory, so the defaults carry no `description`; the field exists for
// user-defined presets that want a one-line explainer in the picker.
export const DEFAULT_QUICK_ASK_PRESETS: QuickAskPreset[] = [
  { label: "Explain", prompt: "Explain what this code does, step by step." },
  {
    label: "Fix",
    prompt:
      "Identify and fix any bugs or issues in this code. Show the corrected code and explain the changes.",
  },
  {
    label: "Review",
    prompt: "Review this code for correctness, clarity, and potential improvements.",
  },
  { label: "Docstring", prompt: "Write a docstring / doc comment for this code." },
];

// Coerce the untrusted nimbus.quickAsk.presets setting into presets. Non-array
// input, or a list with no valid entries, yields the built-in defaults (Replace
// semantics with a safe fallback so the picker is never left with only the
// custom row). An entry must be an object with a non-empty `label` and `prompt`;
// a non-empty string `description` is carried through, otherwise omitted.
export function resolvePresets(raw: unknown): QuickAskPreset[] {
  if (!Array.isArray(raw)) return DEFAULT_QUICK_ASK_PRESETS;
  const presets: QuickAskPreset[] = [];
  for (const entry of raw) {
    const rec = asRecord(entry);
    if (rec === undefined) continue;
    const label = asNonEmptyString(rec["label"]);
    const prompt = asNonEmptyString(rec["prompt"]);
    if (label === undefined || prompt === undefined) continue;
    const preset: QuickAskPreset = { label, prompt };
    const description = asNonEmptyString(rec["description"]);
    if (description !== undefined) preset.description = description;
    presets.push(preset);
  }
  return presets.length > 0 ? presets : DEFAULT_QUICK_ASK_PRESETS;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bunx vitest run test/unit/quick-ask-presets.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Add the `quickAskPresets()` settings accessor**

In `src/settings.ts`, add the member to the `Settings` interface (after `agents(): unknown;`):

```ts
  agents(): unknown;
  quickAskPresets(): unknown;
```

And add the implementation to the returned object (after the `agents:` line):

```ts
    agents: () => cfg().get<unknown>("agents", []),
    quickAskPresets: () => cfg().get<unknown>("quickAsk.presets", []),
```

- [ ] **Step 6: Extend the settings tests**

In `test/unit/settings.test.ts`, in the **"returns defaults when keys absent"** test, add after the `agents` assertion:

```ts
    expect(s.agents()).toEqual([]);
    expect(s.quickAskPresets()).toEqual([]);
```

In the **"returns user-set values"** test, add `"quickAsk.presets"` to the `makeWorkspace({...})` values:

```ts
        agents: [{ id: "a", label: "A" }],
        "quickAsk.presets": [{ label: "Test", prompt: "Write tests." }],
```

and add the matching assertion alongside the other value checks in that test:

```ts
    expect(s.quickAskPresets()).toEqual([{ label: "Test", prompt: "Write tests." }]);
```

- [ ] **Step 7: Run the full unit suite + typecheck + lint**

Run: `bun run typecheck && bun run lint && bun run test`
Expected: all PASS.

- [ ] **Step 8: Commit**

```bash
git add src/quick-ask-presets.ts src/settings.ts test/unit/quick-ask-presets.test.ts test/unit/settings.test.ts
git commit -m "feat(quick-ask): preset resolution module + quickAskPresets setting

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: QuickPick → seeded input box in the handler (+ package.json config + docs)

**Files:**
- Modify: `src/extension.ts` (imports near lines 16-45; the `nimbus.quickAsk` handler at ~538-591)
- Modify: `package.json` (add `nimbus.quickAsk.presets` under `contributes.configuration.properties`, after the `nimbus.agents` block ~335)
- Modify: `docs/settings.md` (add a `### `nimbus.quickAsk.presets`` section after the `nimbus.agents` section ~57)
- Modify: `README.md` (add a settings-table row after the `nimbus.agents` row ~36)
- Test: `test/unit/extension.test.ts` (widen the fixture `quickPickAnswers` type ~174; add `quickPickAnswers` to the existing connected quick-ask tests; add two new tests)

**Interfaces:**
- Consumes (from Task 1): `resolvePresets`, `type QuickAskPreset` from `./quick-ask-presets.js`; `settings.quickAskPresets()`.
- Consumes (existing): `QuickPickItemLike` type from `./vscode-shim.js`; `deps.window.showQuickPick`, `deps.window.showInputBox` (supports a `value` field for pre-fill); `buildQuickAskPrompt`, `validateQuestion` from `./quick-ask.js`.
- Produces: no new exported symbols — behavior change only. Handler order becomes: editor check → context (+truncation warning) → connection check → **QuickPick** → seeded input box → `agentInvoke` → reply tab.

- [ ] **Step 1: Widen the fixture type and update existing quick-ask tests to fail**

In `test/unit/extension.test.ts`, change the `makeFixture` option type (currently ~line 174):

```ts
  quickPickAnswers?: Array<{ label: string; preset?: { label: string; prompt: string } } | undefined>;
```

Add `quickPickAnswers: [{ label: "Custom question…" }]` to **each of these existing connected quick-ask tests** (the disconnected test at "shows an error and opens no doc when disconnected" returns before the picker — leave it untouched):

- `"quick ask sends the selection and shows the reply"`
- `"quick ask with no selection sends the whole file"`
- `"quick ask falls back to the whole file when the selection is whitespace-only"`
- `"quick ask reports when the agent returns no reply"`
- `"quick ask forwards the configured agent in a stateless one-shot options object"`
- `"quick ask omits the agent when askAgent is unset and stays stateless"`
- `"quick ask surfaces an error and opens no doc when agentInvoke rejects"`

Example (add the one line to each fixture literal):

```ts
    const f = makeFixture({
      activeEditor: { text: "whole", selectionText: "const x = 1", fileName: "/p/a.ts", languageId: "typescript" },
      quickPickAnswers: [{ label: "Custom question…" }],
      inputBoxAnswers: ["what is this?"],
      openClient: makeFakeClient({ /* … unchanged … */ }),
    });
```

Then add the two new tests inside the same `describe` block (next to the other quick-ask tests):

```ts
  test("quick ask seeds the input box with the chosen preset prompt", async () => {
    const inputs: string[] = [];
    const f = makeFixture({
      activeEditor: { text: "x", selectionText: "const x = 1", fileName: "/p/a.ts", languageId: "typescript" },
      quickPickAnswers: [
        { label: "Explain", preset: { label: "Explain", prompt: "Explain what this code does, step by step." } },
      ],
      inputBoxAnswers: ["Explain what this code does, step by step."],
      openClient: makeFakeClient({
        agentInvoke: async (input: string) => {
          inputs.push(input);
          return { reply: "done" };
        },
      } as unknown as Partial<ClientLike>),
    });
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    await cmd(f, "nimbus.quickAsk")();
    const inputBox = f.deps.window.showInputBox as unknown as ReturnType<typeof vi.fn>;
    const opts = inputBox.mock.calls[0]?.[0] as { value?: string } | undefined;
    expect(opts?.value).toBe("Explain what this code does, step by step.");
    expect(inputs[0]).toContain("Explain what this code does, step by step.");
  });

  test("quick ask does nothing when the picker is cancelled", async () => {
    const inputs: string[] = [];
    const f = makeFixture({
      activeEditor: { text: "x", selectionText: "const x = 1", fileName: "/p/a.ts", languageId: "typescript" },
      quickPickAnswers: [undefined],
      inputBoxAnswers: ["should not be used"],
      openClient: makeFakeClient({
        agentInvoke: async (input: string) => {
          inputs.push(input);
          return { reply: "x" };
        },
      } as unknown as Partial<ClientLike>),
    });
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    await cmd(f, "nimbus.quickAsk")();
    expect(inputs).toHaveLength(0);
    expect(f.openedDocs).toHaveLength(0);
    const inputBox = f.deps.window.showInputBox as unknown as ReturnType<typeof vi.fn>;
    expect(inputBox).not.toHaveBeenCalled();
  });
```

- [ ] **Step 2: Run the quick-ask tests to verify the new ones fail**

Run: `bunx vitest run test/unit/extension.test.ts -t "quick ask"`
Expected: the two new tests FAIL — `seeds the input box…` fails because the handler passes no `value` (so `opts.value` is `undefined`), and `does nothing when the picker is cancelled` fails because the handler still calls `showInputBox` and `agentInvoke` (picker not consulted yet). The previously-passing tests still pass (the handler ignores `quickPickAnswers` for now).

- [ ] **Step 3: Add the imports and the picker type to `src/extension.ts`**

After the `./quick-ask.js` import block (ends ~line 23), add:

```ts
import { type QuickAskPreset, resolvePresets } from "./quick-ask-presets.js";
```

Add `QuickPickItemLike` to the `./vscode-shim.js` type import block (~lines 39-45):

```ts
import type {
  CommandsApi,
  DisposableLike,
  ExtensionContextLike,
  QuickPickItemLike,
  WindowApi,
  WorkspaceApi,
} from "./vscode-shim.js";
```

Add this module-scope type just below the `SELECTION_PREFILL_MAX` constant (~line 62, before `export interface ActivateDeps`):

```ts
// A quick-ask picker row: a preset action, or (no `preset`) the custom-question
// row. The handler keys off the presence of `preset`, not the label text, so a
// user-defined preset named "Custom question…" is never mistaken for the custom
// row.
type QuickAskPick = QuickPickItemLike & { preset?: QuickAskPreset };
```

- [ ] **Step 4: Insert the QuickPick step into the `nimbus.quickAsk` handler**

In `src/extension.ts`, the handler currently runs the connection check and then calls `showInputBox`:

```ts
    const client = nimbus();
    if (client === undefined) {
      void deps.window.showErrorMessage("Nimbus: not connected to Gateway.");
      return;
    }
    const question = await deps.window.showInputBox({
      prompt: `Ask a question about the ${scope}`,
      placeHolder: "e.g. What does this do? How can I simplify it?",
      validateInput: validateQuestion,
    });
```

Replace that `const question = await deps.window.showInputBox({...});` call with the picker step followed by the seeded input box:

```ts
    const presets = resolvePresets(settings.quickAskPresets());
    const items: QuickAskPick[] = [
      ...presets.map(
        (preset): QuickAskPick => ({
          label: preset.label,
          ...(preset.description !== undefined ? { detail: preset.description } : {}),
          preset,
        }),
      ),
      { label: "Custom question…" },
    ];
    const pick = await deps.window.showQuickPick(items, {
      placeHolder: `Pick a quick-ask action for the ${scope}`,
      matchOnDetail: true,
    });
    if (pick === undefined) return;
    const question = await deps.window.showInputBox({
      prompt: `Ask a question about the ${scope}`,
      placeHolder: "e.g. What does this do? How can I simplify it?",
      value: pick.preset?.prompt ?? "",
      validateInput: validateQuestion,
    });
```

Leave the rest of the handler (the `if (question === undefined …) return;` guard, `buildQuickAskPrompt`, `agentInvoke`, reply rendering) exactly as-is.

- [ ] **Step 5: Run the quick-ask tests to verify they pass**

Run: `bunx vitest run test/unit/extension.test.ts -t "quick ask"`
Expected: PASS (all quick-ask tests, including the two new ones).

- [ ] **Step 6: Add the `nimbus.quickAsk.presets` configuration to `package.json`**

In `package.json`, inside `contributes.configuration.properties`, add this property immediately after the `nimbus.agents` block (mind the trailing comma on the preceding `}`):

```json
        "nimbus.quickAsk.presets": {
          "type": "array",
          "default": [],
          "description": "Preset actions offered in a picker before the Quick Ask input box. Each item: { \"label\": string, \"prompt\": string, \"description\"?: string }. Empty uses the built-in defaults (Explain, Fix, Review, Docstring); a non-empty list replaces them.",
          "items": {
            "type": "object",
            "required": ["label", "prompt"],
            "properties": {
              "label": { "type": "string" },
              "prompt": { "type": "string" },
              "description": { "type": "string" }
            }
          }
        },
```

- [ ] **Step 7: Document the setting in `docs/settings.md`**

Add this section after the `### `nimbus.agents`` section (before `### `nimbus.hitlAlwaysModal``):

````markdown
### `nimbus.quickAsk.presets`

- **Type:** array · **Default:** `[]`
- Preset actions offered in a picker before the **Quick Ask** input box. Each
  item is an object with a required `label` and `prompt` and an optional
  `description` (shown as picker detail). Picking one pre-fills the input box
  with its `prompt`, editable before you send; a **Custom question…** row keeps
  the free-form flow. Empty shows the built-in defaults (**Explain**, **Fix**,
  **Review**, **Docstring**); a non-empty list **replaces** them.
- Replace semantics — to add one preset while keeping the defaults, start from
  this block:

  ```jsonc
  "nimbus.quickAsk.presets": [
    { "label": "Explain", "prompt": "Explain what this code does, step by step." },
    { "label": "Fix", "prompt": "Identify and fix any bugs or issues in this code. Show the corrected code and explain the changes." },
    { "label": "Review", "prompt": "Review this code for correctness, clarity, and potential improvements." },
    { "label": "Docstring", "prompt": "Write a docstring / doc comment for this code." }
  ]
  ```
````

- [ ] **Step 8: Add the README settings-table row**

In `README.md`, add this row to the settings table immediately after the `nimbus.agents` row:

```markdown
| `nimbus.quickAsk.presets` | `[]` | Quick Ask preset actions (empty = Explain/Fix/Review/Docstring). |
```

- [ ] **Step 9: Run the full verification chain**

Run: `bun run typecheck && bun run lint && bun run test && bun run build && bun run check-bundle && bun run check-settings-docs`
Expected: all PASS; the final line reads `check-settings-docs: OK — all 10 nimbus.* settings documented.`

- [ ] **Step 10: Commit**

```bash
git add src/extension.ts package.json docs/settings.md README.md test/unit/extension.test.ts
git commit -m "feat(quick-ask): preset picker seeds the quick-ask input box

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Changelog + roadmap bookkeeping

**Files:**
- Modify: `CHANGELOG.md` (add a bullet under `## Unreleased`)
- Modify: `docs/ROADMAP.md` (remove the Phase 1 row; note presets on the shipped Quick Ask row)

**Interfaces:** none — documentation only.

- [ ] **Step 1: Add the changelog entry**

In `CHANGELOG.md`, under `## Unreleased`, add this bullet directly after the existing `**Quick Ask**` bullet:

```markdown
- **Quick Ask presets** — the `Nimbus: Quick Ask…` command now opens a picker of
  preset actions (**Explain**, **Fix**, **Review**, **Docstring**) plus a
  **Custom question…** row. Picking a preset pre-fills the input box with its
  prompt, editable before sending. Presets are configurable via
  `nimbus.quickAsk.presets` (a non-empty list replaces the defaults).
```

- [ ] **Step 2: Update the roadmap**

In `docs/ROADMAP.md`, update the **Already shipped** Quick Ask row to mention presets:

```markdown
| **Quick Ask** — one-shot editor quick-ask (preset actions + custom), reply in a read-only tab | `agentInvoke` |
```

And delete the now-shipped Phase 1 row:

```markdown
| Quick-ask **preset actions** (Explain / Fix / Review / Docstring) | Skip retyping the prompt; one click from the editor | `agentInvoke` | S |
```

- [ ] **Step 3: Verify docs still pass the guard and nothing else broke**

Run: `bun run check-settings-docs && bun run test`
Expected: PASS (docs-only change; guard still OK).

- [ ] **Step 4: Commit**

```bash
git add CHANGELOG.md docs/ROADMAP.md
git commit -m "docs: record quick-ask presets in changelog + roadmap

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Notes for the implementer

- **Why the picker sits *after* the connection check:** a disconnected user should get "not connected" immediately, not after choosing a preset and typing. This also keeps the existing disconnected test unchanged (it returns before the picker).
- **Sentinel, not label text:** the handler decides "custom vs preset" by whether `pick.preset` is present, never by comparing the label to `"Custom question…"`. That is deliberate — a user could name a preset that string.
- **`showInputBox` `value`:** the shim's `showInputBox` accepts `value` for pre-fill; the VS Code input box shows it editable with the cursor at the end. The `placeHolder` is only visible when the box is empty, so it is harmless for the Custom row and hidden for presets.
- **`asNonEmptyString` does not trim** (consistent with `parseAgents`): an empty string `""` is dropped, but a whitespace-only `prompt` is technically kept — it is then rejected downstream by `validateQuestion` (which trims) when the user tries to send. This matches the existing codebase convention; do not add trimming here.
