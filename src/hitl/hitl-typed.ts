import type { HitlRequest } from "@nimbus-dev/client";

import type { WindowApi } from "../vscode-shim.js";

// The gateway's prompt and confirm text are untrusted: they reach an input box as plain
// text only. Control, format and line-separator characters are shown as \u{...} so no text
// can break the layout or pass for another (a bidi override, a line break).
const INVISIBLE = /[\p{Cc}\p{Cf}\u2028\u2029]/gu;

export function visibleText(s: string): string {
  return s.replace(INVISIBLE, (ch) => String.raw`\u{${(ch.codePointAt(0) ?? 0).toString(16)}}`);
}

/**
 * VS Code renders an input box's `prompt` as LINKED text: `[label](https://...)` and
 * `[label](command:...)` become clickable, and a command link runs an editor command. The
 * Gateway's prompt is untrusted, so the two characters that open a link target are pulled apart
 * with a visible space. Nothing else about the text changes.
 */
export function unlinked(s: string): string {
  return s.replaceAll("](", "] (");
}

/**
 * The input box for a type-to-confirm request. Resolves with exactly what the person typed
 * (no trimming, no normalising), or `undefined` when they dismiss it. It is never pre-filled
 * with the confirm text and does not compare the text: the Gateway decides.
 *
 * The text to type goes in the box's TITLE, which VS Code shows as literal text. It cannot go
 * through `unlinked`: a text that is shown changed is a text the person would type wrong. The
 * Gateway's own prompt goes in `prompt`, with link targets broken.
 */
export function createTypedConfirmSurface(window: WindowApi) {
  return async (req: HitlRequest): Promise<string | undefined> => {
    const confirmText = req.confirmText ?? "";
    return await window.showInputBox({
      title: `To approve, type exactly: ${visibleText(confirmText)}`,
      prompt: `${unlinked(visibleText(req.prompt))} Type the text in the title above, exactly, and press Enter. Escape rejects.`,
      placeHolder: "Type the confirm text, or press Escape to reject",
      ignoreFocusOut: true,
    });
  };
}
