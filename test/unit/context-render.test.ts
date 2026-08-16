import { describe, expect, test } from "vitest";

import {
  escapeHtml,
  renderOffers,
  renderSections,
  renderSignals,
} from "../../src/context/webview/render.js";

const section = {
  id: "problems" as const,
  title: "Problems",
  rows: [{ label: "Line 3: boom", iconId: "error" }],
};

describe("escapeHtml", () => {
  test("escapes the five HTML metacharacters", () => {
    expect(escapeHtml(`<a href="x">'y&'</a>`)).toBe(
      "&lt;a href=&quot;x&quot;&gt;&#39;y&amp;&#39;&lt;/a&gt;",
    );
  });
});

describe("renderSections", () => {
  test("renders a row per finding", () => {
    const html = renderSections([section]);
    expect(html).toContain("Problems");
    expect(html).toContain("Line 3: boom");
  });

  test("renders the empty text instead of rows when there are none", () => {
    const html = renderSections([
      { id: "git", title: "Git", rows: [], empty: "No git repository here." },
    ]);
    expect(html).toContain("No git repository here.");
  });

  test("escapes a diagnostic message rather than trusting it as markup", () => {
    const nasty = { ...section, rows: [{ label: "<img src=x onerror=alert(1)>" }] };
    expect(renderSections([nasty])).not.toContain("<img");
  });

  // The row still CARRIES an iconId — the sidebar tree views draw the same ids
  // as ThemeIcons — but no codicon font ships with this webview, so a
  // `<span class="codicon …">` would render as an empty element and a stray
  // flex gap before every label. Pinned so re-adding one has to ship the font.
  test("renders no icon markup, because no codicon font ships with the panel", () => {
    expect(renderSections([section])).not.toContain("codicon");
  });
});

describe("renderOffers", () => {
  test("carries the command and its pre-filled target on the button", () => {
    const html = renderOffers([
      {
        briefId: "why",
        label: "Why is this here?",
        iconId: "history",
        command: "nimbus.brief.why",
        target: { ref: "src/a.ts", line: 4 },
      },
    ]);
    expect(html).toContain("nimbus.brief.why");
    expect(html).toContain("src/a.ts");
    expect(html).toContain("Why is this here?");
  });

  test("renders nothing but a note when no brief fits", () => {
    expect(renderOffers([])).toContain("Open a file");
  });

  test("renders no icon markup on a button either", () => {
    const html = renderOffers([
      {
        briefId: "huddle",
        label: "Team huddle",
        iconId: "organization",
        command: "nimbus.brief.huddle",
      },
    ]);
    expect(html).not.toContain("codicon");
    expect(html).toContain("Team huddle");
  });
});

describe("renderSignals", () => {
  test("marks unsaved edits so blame is never read as authoritative", () => {
    expect(renderSignals({ sections: [section], isDirty: true })).toContain("Unsaved edits");
  });

  test("says nothing about unsaved edits for a clean file", () => {
    expect(renderSignals({ sections: [section], isDirty: false })).not.toContain("Unsaved edits");
  });

  test("carries no offer markup — the offers render into their own mount", () => {
    expect(renderSignals({ sections: [section], isDirty: false })).not.toContain("button");
  });
});
