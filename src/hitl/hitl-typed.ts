import type { HitlRequest } from "@nimbus-dev/client";

import type { WindowApi } from "../vscode-shim.js";

// The gateway's prompt and confirm text are untrusted: they reach an input box as plain
// text only. Control, format and line-separator characters are shown as \u{...} so no text
// can break the layout or pass for another (a bidi override, a line break).
const INVISIBLE = /[\p{Cc}\p{Cf}\u2028\u2029]/gu;

export function visibleText(s: string): string {
  return s.replace(INVISIBLE, (ch) => `\\u{${(ch.codePointAt(0) ?? 0).toString(16)}}`);
}

/**
 * The input box for a type-to-confirm request. Resolves with exactly what the person typed
 * (no trimming, no normalising), or `undefined` when they dismiss it. It is never pre-filled
 * with the confirm text and does not compare the text: the Gateway decides.
 */
export function createTypedConfirmSurface(window: WindowApi) {
  return async (req: HitlRequest): Promise<string | undefined> => {
    const confirmText = req.confirmText ?? "";
    return await window.showInputBox({
      prompt: `${visibleText(req.prompt)} To approve, type exactly: ${visibleText(confirmText)}`,
      placeHolder: "Type the confirm text, or press Escape to reject",
      ignoreFocusOut: true,
    });
  };
}
