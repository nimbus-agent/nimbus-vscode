import { readFileSync } from "node:fs";
import { join } from "node:path";

// The extension manifest, read once and typed once.
//
// Eleven manifest-*.test.ts files each used to re-read package.json and
// re-declare its own view of `contributes` — the same JSON.parse and the same
// four accessor lines, with the field types drifting between copies (`Command`
// carried `icon` in three of them and not in the other two, and `configuration`
// was an object in one file and an object-or-array in another). Reading it here
// means a manifest test asserts on the manifest, not on its own transcription
// of it.
//
// Not `*.test.ts`, so vitest's `include` does not pick this file up as a suite.

export type ManifestCommand = {
  command: string;
  title: string;
  category?: string;
  icon?: string;
};

export type ManifestMenuEntry = { command: string; when?: string; group?: string };

export type ManifestView = {
  id: string;
  name: string;
  type?: string;
  initialSize?: number;
  visibility?: string;
};

export type ManifestWelcome = { view: string; contents: string; when?: string };

export type ManifestConfigProperty = {
  type?: string;
  default?: unknown;
  description?: string;
  enum?: unknown[];
};

export type ManifestLmTool = {
  name: string;
  displayName?: string;
  modelDescription?: string;
  userDescription?: string;
  canBeReferencedInPrompt?: boolean;
  toolReferenceName?: string;
  tags?: string[];
  inputSchema?: { type?: string; required?: string[]; properties?: Record<string, unknown> };
};

type ConfigurationBlock = { title?: string; properties?: Record<string, ManifestConfigProperty> };

interface Contributes {
  commands?: ManifestCommand[];
  views?: { nimbus?: ManifestView[] };
  viewsWelcome?: ManifestWelcome[];
  menus?: {
    commandPalette?: ManifestMenuEntry[];
    "editor/context"?: ManifestMenuEntry[];
    "view/title"?: ManifestMenuEntry[];
    "view/item/context"?: ManifestMenuEntry[];
  };
  // VS Code accepts a single block or an array of them, and which one this
  // manifest uses is not a fact any test should have to know.
  configuration?: ConfigurationBlock | ConfigurationBlock[];
  languageModelTools?: ManifestLmTool[];
  codeActions?: unknown[];
  chatParticipants?: Array<{ commands?: Array<{ name: string }> }>;
}

export const manifest = JSON.parse(
  readFileSync(join(__dirname, "..", "..", "..", "package.json"), "utf8"),
) as {
  extensionKind?: string[];
  capabilities?: {
    untrustedWorkspaces?: {
      supported?: string;
      description?: string;
      restrictedConfigurations?: string[];
    };
  };
  contributes?: Contributes;
};

export const contributes: Contributes = manifest.contributes ?? {};

export const commands: ManifestCommand[] = contributes.commands ?? [];
export const views: ManifestView[] = contributes.views?.nimbus ?? [];
export const welcome: ManifestWelcome[] = contributes.viewsWelcome ?? [];
export const palette: ManifestMenuEntry[] = contributes.menus?.commandPalette ?? [];
export const editorContext: ManifestMenuEntry[] = contributes.menus?.["editor/context"] ?? [];
export const viewTitle: ManifestMenuEntry[] = contributes.menus?.["view/title"] ?? [];
export const itemContext: ManifestMenuEntry[] = contributes.menus?.["view/item/context"] ?? [];
export const lmTools: ManifestLmTool[] = contributes.languageModelTools ?? [];

/** Every declared setting, flattened across however many configuration blocks. */
export const configProperties: Record<string, ManifestConfigProperty> = (() => {
  const raw = contributes.configuration;
  const blocks = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
  return Object.fromEntries(blocks.flatMap((b) => Object.entries(b.properties ?? {})));
})();
