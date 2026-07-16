# Design Review: Quick-Ask Preset Actions

This document contains suggestions, improvements, and open questions regarding the design spec in [2026-07-16-quick-ask-presets-design.md](file:///C:/gitrep/nimbus-vscode/docs/superpowers/specs/2026-07-16-quick-ask-presets-design.md).

---

## 1. User Experience & UX Friction

### The "Extra Click" Problem for Custom Questions
* **Issue:** Under the current design, triggering `quickAsk` changes from a 1-step flow (open input box and type) to a 2-step flow (select "Custom question..." from QuickPick, then open input box and type). This introduces friction/an extra keystroke for the baseline free-form use case.
* **Suggestions:**
  1. **Dual Command Entry Points:** Keep `nimbus.quickAsk` as the direct free-form prompt, and introduce a new command `nimbus.quickAskPresets` (or similar) mapped to the QuickPick menu.
  2. **Direct Typing in QuickPick:** VS Code's `showQuickPick` supports free-text input filtering. If the user starts typing something that doesn't match any preset label, could we offer a dynamically generated item `"Ask: '<user text>'"` as the active/default selection? Pressing Enter would then immediately submit or move to the input box with that text.
  3. **Remember Last Selection:** Default the active QuickPick item to the user's last-selected option (preset or custom) to save keystrokes on repeated operations.

---

## 2. Enhancing the Preset Schema (Forwards Compatibility)

While keeping Phase 1 minimal is a goal, defining a schema that requires breaking changes later should be avoided.

### Description Field
* **Suggestion:** Add an optional `description` field to the `QuickAskPreset` schema.
* **Why:** In the QuickPick, this description can be displayed as detail text below the label, explaining what the preset does before the user selects it and seeds their input box.
```ts
export interface QuickAskPreset {
  label: string;
  prompt: string;
  description?: string; // e.g., "Step-by-step code explanation"
}
```

### Future-Proofing for Agent/Model Routing
* **Suggestion:** Allow optional `agent` or `model` properties in the schema, even if they are ignored or simply parsed and validated but not yet utilized in Phase 1.
* **Why:** Power users may want a "Review" preset to run via a specialized `reviewer` agent, while "Fix" runs via a standard code agent.

---

## 3. Settings Semantics: Replace vs. Merge

* **Issue:** The spec proposes "Replace" semantics for `nimbus.quickAsk.presets`. If a user wants to add just *one* custom preset, they have to copy-paste the default presets (Explain, Fix, Review, Docstring) into their configuration to keep them.
* **Suggestions:**
  * Consider supporting standard "append" behavior or letting users explicitly define their presets.
  * If "Replace" is kept for simplicity, document the default presets clearly in the settings description so users can easily copy/paste them.

---

## 4. Prompt Variables & Placeholders

* **Question:** Do the presets support placeholders or context variables?
* **Details:**
  * Can a user write a preset prompt like `"Compare this code with the function in ${fileName}: ..."`?
  * If context substitution is supported or planned, we should define the syntax early (e.g., `${selectedText}`, `${fileName}`, `${languageId}`) to ensure presets can be parameterized.

---

## 5. Telemetry & Analytics

* **Suggestion:** Log which preset action was chosen (e.g., `explain`, `fix`, `review`, `docstring`, or `custom`) when telemetry is sent.
* **Why:** Helps determine which presets are actually valuable and whether certain defaults can be tuned.
