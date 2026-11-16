import { describe, expect, test, vi } from "vitest";
import { createTypedConfirmSurface, unlinked, visibleText } from "../../src/hitl/hitl-typed.js";
import type { WindowApi } from "../../src/vscode-shim.js";

function windowWith(answer: string | undefined) {
  const showInputBox = vi.fn(async (_o?: unknown) => answer);
  return { win: { showInputBox } as unknown as WindowApi, showInputBox };
}

describe("typed confirmation surface", () => {
  test("shows the prompt and the confirm text as plain text, never pre-filled", async () => {
    const { win, showInputBox } = windowWith("x");
    await createTypedConfirmSurface(win)({
      requestId: "r",
      prompt: "Merge [it](https://evil.example) <b>now</b>?",
      confirmText: "github/merge org/repo#7",
    });
    const opts = showInputBox.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(opts["value"]).toBeUndefined();
    expect(opts["ignoreFocusOut"]).toBe(true);
    // The text to type is in the TITLE, which VS Code shows literally, and is shown unchanged.
    expect(opts["title"]).toBe("To approve, type exactly: github/merge org/repo#7");
    // The Gateway's prompt is in `prompt`, where VS Code makes links: its link target is broken.
    expect(String(opts["prompt"])).toContain("Merge [it] (https://evil.example) <b>now</b>?");
    expect(String(opts["prompt"])).not.toContain("](");
  });

  test("a command link in the Gateway's prompt cannot become clickable", async () => {
    const { win, showInputBox } = windowWith("x");
    await createTypedConfirmSurface(win)({
      requestId: "r",
      prompt: "See [Review](command:workbench.action.terminal.new) and [docs](https://x.example)",
      confirmText: "aws/invoke fn",
    });
    const opts = showInputBox.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(String(opts["prompt"])).not.toMatch(/\]\((command|https?|file):/);
    expect(unlinked("a](b) c](d)")).toBe("a] (b) c] (d)");
    expect(unlinked("no link here")).toBe("no link here");
  });

  test("a confirm text that looks like a link is still shown exactly, in the title", async () => {
    const { win, showInputBox } = windowWith("x");
    const confirmText = "svc/[a](command:x)";
    await createTypedConfirmSurface(win)({ requestId: "r", prompt: "p", confirmText });
    const opts = showInputBox.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(opts["title"]).toBe(`To approve, type exactly: ${confirmText}`);
    expect(String(opts["prompt"])).not.toContain(confirmText);
  });

  test("returns exactly what was typed, and undefined when dismissed", async () => {
    const req = { requestId: "r", prompt: "p", confirmText: "c" };
    expect(await createTypedConfirmSurface(windowWith(" C ").win)(req)).toBe(" C ");
    expect(await createTypedConfirmSurface(windowWith(undefined).win)(req)).toBeUndefined();
  });

  test("control, bidi and line-break characters are made visible, not rendered", () => {
    expect(visibleText("a\nb\u202Ec\u2028")).toBe("a\\u{a}b\\u{202e}c\\u{2028}");
    expect(visibleText("plain text")).toBe("plain text");
  });
});
