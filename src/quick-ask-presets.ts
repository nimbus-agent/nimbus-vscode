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
