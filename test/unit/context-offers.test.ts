import { describe, expect, test } from "vitest";

import { BRIEF_CATALOG, needsEditor } from "../../src/briefs/catalog.js";
import { offersFor } from "../../src/context/offers.js";
import { buildSnapshot } from "../../src/context/snapshot.js";

const withFile = buildSnapshot({
  generation: 1,
  editor: {
    path: "src/a.ts",
    scheme: "file",
    languageId: "typescript",
    line: 41,
    selection: "",
    isDirty: false,
  },
});
const withoutFile = buildSnapshot({ generation: 2 });

describe("offersFor", () => {
  test("offers every brief when a file and a cursor line are known", () => {
    expect(offersFor(withFile)).toHaveLength(BRIEF_CATALOG.length);
  });

  test("pre-fills the editor target for the briefs that take one", () => {
    const why = offersFor(withFile).find((o) => o.briefId === "why");
    expect(why?.target).toEqual({ ref: "src/a.ts", line: 41 });
    expect(why?.command).toBe("nimbus.brief.why");
  });

  test("omits the editor-backed briefs when there is no file", () => {
    const ids = offersFor(withoutFile).map((o) => o.briefId);
    expect(ids).toEqual(["huddle", "janitor", "preflight"]);
  });

  test("leaves the prompted briefs without a target — they ask for their own input", () => {
    const janitor = offersFor(withFile).find((o) => o.briefId === "janitor");
    expect(janitor?.target).toBeUndefined();
  });

  // The other half of protocol.ts's derived allowlist: a target is attached for
  // exactly the briefs needsEditor names, so the panel never posts an argument
  // the host validator refuses.
  test("attaches a target for exactly the briefs needsEditor names", () => {
    const withTarget = offersFor(withFile)
      .filter((o) => o.target !== undefined)
      .map((o) => o.command);
    expect(withTarget).toEqual(BRIEF_CATALOG.filter((s) => needsEditor(s)).map((s) => s.command));
  });

  test("never invents a command outside the catalog", () => {
    const known = new Set(BRIEF_CATALOG.map((b) => b.command));
    for (const offer of offersFor(withFile)) expect(known.has(offer.command)).toBe(true);
  });

  test("preserves catalog order so the panel is stable between renders", () => {
    expect(offersFor(withFile).map((o) => o.briefId)).toEqual(BRIEF_CATALOG.map((b) => b.id));
  });
});
