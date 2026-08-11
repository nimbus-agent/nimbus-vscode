import { describe, expect, test } from "vitest";

import { BRIEF_CATALOG, type BriefId, briefSpec, needsEditor } from "../../src/briefs/catalog.js";

describe("brief catalog", () => {
  test("carries all six briefs", () => {
    expect(BRIEF_CATALOG.map((b) => b.id)).toEqual([
      "why",
      "ghost",
      "conflicts",
      "huddle",
      "janitor",
      "preflight",
    ]);
  });

  // whyPeek is deliberately absent from the catalog: it is a hover, not a row,
  // and an entry would put a dead row in the sidebar. Its gate exemption is
  // enforced by egress-choke-point.test.ts, which DISCOVERS call shapes rather
  // than trusting a hand-kept list.
  test("every entry is gated", () => {
    expect(BRIEF_CATALOG.filter((b) => !b.gated)).toEqual([]);
  });

  test("command ids are unique and namespaced", () => {
    const commands = BRIEF_CATALOG.map((b) => b.command);
    expect(new Set(commands).size).toBe(commands.length);
    for (const c of commands) expect(c.startsWith("nimbus.brief.")).toBe(true);
  });

  test("labels are human sentences, not agent names", () => {
    expect(briefSpec("why").label).toBe("Why is this here?");
    expect(briefSpec("ghost").label).toBe("Who knew this code?");
    expect(briefSpec("conflicts").label).toBe("Who else is touching this?");
    expect(briefSpec("huddle").label).toBe("Team huddle");
    expect(briefSpec("janitor").label).toBe("Is this idle?");
    expect(briefSpec("preflight").label).toBe("Safe to deploy?");
  });

  test("context matches what each RPC actually requires", () => {
    expect(briefSpec("why").context).toBe("fileAndLine");
    expect(briefSpec("ghost").context).toBe("file");
    expect(briefSpec("conflicts").context).toBe("file");
    expect(briefSpec("huddle").context).toBe("none");
    expect(briefSpec("janitor").context).toBe("prompted");
    expect(briefSpec("preflight").context).toBe("prompted");
  });

  test("briefSpec throws on an unknown id rather than returning undefined", () => {
    expect(() => briefSpec("nope" as BriefId)).toThrow(/unknown brief/i);
  });

  test("only the editor-context briefs need an editor", () => {
    expect(BRIEF_CATALOG.filter(needsEditor).map((b) => b.id)).toEqual([
      "why",
      "ghost",
      "conflicts",
    ]);
  });
});
