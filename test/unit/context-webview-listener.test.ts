// @vitest-environment jsdom
import { beforeAll, beforeEach, describe, expect, test } from "vitest";

// Mirrors the shell real-context-view.ts serves: two mounts inside #root, with
// aria-live scoped to the informational half only.
const CONTEXT_SHELL = `<main id="root"><section id="signals" aria-live="polite"></section><section id="offers"></section></main>`;

interface VsCodeApi {
  postMessage: (msg: unknown) => void;
}

const posted: unknown[] = [];

// Mirrors test/unit/webview-listener.test.ts's dispatch helper: the VS Code
// host posts messages with a `vscode-webview://<id>` origin — an opaque,
// browser-assigned origin a foreign page cannot forge — and that origin is
// main.ts's trust boundary. dispatch() defaults to a trusted origin; each
// test overrides it to exercise the guard.
function dispatch(origin: string, data: unknown): void {
  const ev = new MessageEvent("message", { origin, data });
  globalThis.dispatchEvent(ev);
}

function rootHtml(): string {
  return document.querySelector("#root")?.innerHTML ?? "";
}

const RENDER_MESSAGE = {
  type: "render",
  generation: 1,
  sections: [{ id: "problems", title: "Problems", rows: [{ label: "Line 3: boom" }] }],
  offers: [],
  isDirty: false,
};

const WITH_OFFER = {
  ...RENDER_MESSAGE,
  generation: 2,
  offers: [
    {
      briefId: "why",
      label: "Why is this here?",
      iconId: "history",
      command: "nimbus.brief.why",
      target: { ref: "src/a.ts", line: 41 },
    },
  ],
};

beforeAll(async () => {
  document.body.innerHTML = CONTEXT_SHELL;
  (globalThis as unknown as { acquireVsCodeApi: () => VsCodeApi }).acquireVsCodeApi = () => ({
    postMessage: (msg) => posted.push(msg),
  });
  await import("../../src/context/webview/main.js");
});

beforeEach(() => {
  // Reset through the real code path rather than by writing innerHTML directly:
  // main.ts skips an identical repaint, so clearing the DOM behind its back
  // would leave its cache claiming the panel still shows the old render.
  dispatch("vscode-webview://abc", { type: "paused", reason: "hidden" });
  posted.length = 0;
});

describe("context webview message listener", () => {
  test("renders a render message from a vscode-webview origin", () => {
    dispatch("vscode-webview://abc", RENDER_MESSAGE);
    expect(rootHtml()).toContain("Line 3: boom");
  });

  test("drops messages with an empty origin", () => {
    dispatch("", RENDER_MESSAGE);
    expect(rootHtml()).not.toContain("Line 3: boom");
  });

  test("drops messages from foreign cross-origin frames", () => {
    dispatch("https://evil.example", RENDER_MESSAGE);
    expect(rootHtml()).not.toContain("Line 3: boom");
  });

  test("ignores payloads that do not look like ExtensionToContextView", () => {
    expect(() => dispatch("vscode-webview://abc", null)).not.toThrow();
    expect(() => dispatch("vscode-webview://abc", "not an object")).not.toThrow();
    expect(() => dispatch("vscode-webview://abc", { noType: true })).not.toThrow();
    expect(rootHtml()).not.toContain("Line 3: boom");
  });

  test("drops a message with an unrecognised type without mutating the DOM", () => {
    dispatch("vscode-webview://abc", RENDER_MESSAGE);
    const before = rootHtml();
    expect(() => dispatch("vscode-webview://abc", { type: "explode" })).not.toThrow();
    expect(rootHtml()).toBe(before);
  });
});

// The host re-collects on a debounce; with PR 1's two signals, moving the cursor
// inside one file produces a byte-identical render. Rewriting innerHTML anyway
// would re-announce the whole aria-live region and destroy keyboard focus.
describe("identical repaints", () => {
  test("leaves the rendered DOM in place when the render is unchanged", () => {
    dispatch("vscode-webview://abc", RENDER_MESSAGE);
    const first = document.querySelector("#signals .row");
    expect(first).not.toBeNull();

    dispatch("vscode-webview://abc", RENDER_MESSAGE);
    expect(document.querySelector("#signals .row")).toBe(first);
  });

  test("keeps focus on an offer button across an identical repaint", () => {
    dispatch("vscode-webview://abc", WITH_OFFER);
    const button = document.querySelector("#offers button.offer");
    if (!(button instanceof HTMLElement)) throw new Error("no offer button rendered");
    button.focus();
    expect(document.activeElement).toBe(button);

    dispatch("vscode-webview://abc", WITH_OFFER);
    expect(document.querySelector("#offers button.offer")).toBe(button);
    expect(document.activeElement).toBe(button);
  });

  test("repaints the moment the render actually changes", () => {
    dispatch("vscode-webview://abc", RENDER_MESSAGE);
    dispatch("vscode-webview://abc", { ...RENDER_MESSAGE, generation: 9, isDirty: true });
    expect(rootHtml()).toContain("Unsaved edits");
  });

  test("repaints only the mount whose content changed", () => {
    dispatch("vscode-webview://abc", WITH_OFFER);
    const button = document.querySelector("#offers button.offer");
    // Same offers, different problems: the offers mount must not be rewritten.
    dispatch("vscode-webview://abc", {
      ...WITH_OFFER,
      generation: 3,
      sections: [{ id: "problems", title: "Problems", rows: [{ label: "Line 7: other" }] }],
    });
    expect(rootHtml()).toContain("Line 7: other");
    expect(document.querySelector("#offers button.offer")).toBe(button);
  });
});

describe("per-section updates", () => {
  test("a section message replaces only that section", () => {
    dispatch("vscode-webview://abc", {
      type: "render",
      generation: 1,
      sections: [
        { id: "problems", title: "Problems", rows: [{ label: "P" }] },
        { id: "blame", title: "History", rows: [], loading: true },
      ],
      offers: [],
      isDirty: false,
    });
    dispatch("vscode-webview://abc", {
      type: "section",
      generation: 1,
      section: { id: "blame", title: "History", rows: [{ label: "Ada" }] },
    });
    const html = document.getElementById("signals")?.innerHTML ?? "";
    expect(html).toContain("Ada");
    expect(html).toContain("P");
    // Replaced, not appended. Without these two, an implementation that
    // pushed the incoming section instead of swapping it would still pass:
    // the loading placeholder would sit above the answer, and "History"
    // would be rendered twice.
    expect(html).not.toContain("Loading…");
    expect(document.querySelectorAll('#signals [data-signal="blame"]')).toHaveLength(1);
  });

  test("ignores a section message carrying no section object", () => {
    dispatch("vscode-webview://abc", {
      type: "render",
      generation: 1,
      sections: [{ id: "blame", title: "History", rows: [], loading: true }],
      offers: [],
      isDirty: false,
    });
    const before = document.getElementById("signals")?.innerHTML ?? "";
    expect(() =>
      dispatch("vscode-webview://abc", { type: "section", generation: 1 }),
    ).not.toThrow();
    expect(() =>
      dispatch("vscode-webview://abc", { type: "section", generation: 1, section: { rows: [] } }),
    ).not.toThrow();
    expect(document.getElementById("signals")?.innerHTML ?? "").toBe(before);
  });

  test("ignores a section from a superseded generation", () => {
    dispatch("vscode-webview://abc", {
      type: "render",
      generation: 2,
      sections: [{ id: "blame", title: "History", rows: [], loading: true }],
      offers: [],
      isDirty: false,
    });
    dispatch("vscode-webview://abc", {
      type: "section",
      generation: 1,
      section: { id: "blame", title: "History", rows: [{ label: "stale" }] },
    });
    expect(document.getElementById("signals")?.innerHTML ?? "").not.toContain("stale");
  });
});

// The producer half of the webview→host boundary, and the only exercise of the
// data-target JSON round trip that protocol.ts then validates.
describe("clicking an offer", () => {
  test("posts the command and the target that rode in the data attribute", () => {
    dispatch("vscode-webview://abc", WITH_OFFER);
    const button = document.querySelector("#offers button.offer");
    if (!(button instanceof HTMLElement)) throw new Error("no offer button rendered");
    button.click();
    expect(posted).toEqual([
      { type: "run", command: "nimbus.brief.why", args: [{ ref: "src/a.ts", line: 41 }] },
    ]);
  });

  test("posts no argument for a brief that carries no target", () => {
    dispatch("vscode-webview://abc", {
      ...RENDER_MESSAGE,
      generation: 4,
      offers: [
        {
          briefId: "huddle",
          label: "Team huddle",
          iconId: "organization",
          command: "nimbus.brief.huddle",
        },
      ],
    });
    const button = document.querySelector("#offers button.offer");
    if (!(button instanceof HTMLElement)) throw new Error("no offer button rendered");
    button.click();
    expect(posted).toEqual([{ type: "run", command: "nimbus.brief.huddle", args: [] }]);
  });

  test("says nothing when the click lands outside an offer button", () => {
    dispatch("vscode-webview://abc", WITH_OFFER);
    const heading = document.querySelector("#signals h2");
    if (!(heading instanceof HTMLElement)) throw new Error("no heading rendered");
    heading.click();
    expect(posted).toEqual([]);
  });
});
