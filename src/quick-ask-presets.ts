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
export const DEFAULT_QUICK_ASK_PRESETS: readonly QuickAskPreset[] = Object.freeze([
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
  {
    label: "Write tests",
    prompt:
      "Write focused unit tests for this code, following the project's existing test framework and conventions.",
  },
]);

// Ops presets keyed to infra file types (Stage 2b): shown ABOVE the generic
// presets when the active file is infrastructure — the questions an on-call /
// platform engineer actually asks of such a file.
const OPS_PRESETS: readonly QuickAskPreset[] = Object.freeze([
  { label: "Blast radius", prompt: "What breaks if I apply this change?" },
  { label: "Ownership", prompt: "Who owns this service or resource?" },
  { label: "Recent changes", prompt: "What changed here recently, and why?" },
]);

const K8S_HINT_RE = /\b(apiVersion|kind|helm|chart)\b/i;

// Return the ops presets when (fileName, languageId) identifies an infra file:
// Terraform, Kubernetes/Helm YAML, Dockerfiles, GitHub workflow definitions.
// `contentHead` (the file's first chunk) disambiguates generic YAML.
export function filePresetsFor(
  fileName: string,
  languageId: string,
  contentHead = "",
): QuickAskPreset[] {
  const base = fileName.replaceAll("\\", "/").toLowerCase();
  const isTerraform =
    languageId === "terraform" || base.endsWith(".tf") || base.endsWith(".tfvars");
  const isDockerfile = languageId === "dockerfile" || /(^|\/)dockerfile[^/]*$/.test(base);
  const isWorkflow = /\.github\/workflows\/[^/]+\.ya?ml$/.test(base);
  const isK8sYaml =
    (languageId === "yaml" || base.endsWith(".yaml") || base.endsWith(".yml")) &&
    (K8S_HINT_RE.test(contentHead) ||
      /(^|\/)(k8s|kubernetes|helm|charts?|manifests?)\//.test(base));
  if (isTerraform || isDockerfile || isWorkflow || isK8sYaml) return [...OPS_PRESETS];
  return [];
}

// Coerce the untrusted nimbus.quickAsk.presets setting into presets. Non-array
// input, or a list with no valid entries, yields the built-in defaults (Replace
// semantics with a safe fallback so the picker is never left with only the
// custom row). An entry must be an object with a non-empty `label` and `prompt`;
// a non-empty string `description` is carried through, otherwise omitted.
export function resolvePresets(raw: unknown): readonly QuickAskPreset[] {
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
