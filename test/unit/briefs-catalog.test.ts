import { describe, expect, test } from "vitest";

import { BRIEF_CATALOG, type BriefId, briefSpec } from "../../src/briefs/catalog.js";

describe("brief catalog", () => {
  test("carries exactly the four briefs PR 1 implements", () => {
    expect(BRIEF_CATALOG.map((b) => b.id)).toEqual(["why", "ghost", "conflicts", "huddle"]);
  });

  test("every entry is gated — whyPeek, the only exemption, is not in this PR", () => {
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
  });

  test("context matches what each RPC actually requires", () => {
    expect(briefSpec("why").context).toBe("fileAndLine");
    expect(briefSpec("ghost").context).toBe("file");
    expect(briefSpec("conflicts").context).toBe("file");
    expect(briefSpec("huddle").context).toBe("none");
  });

  test("briefSpec throws on an unknown id rather than returning undefined", () => {
    expect(() => briefSpec("nope" as BriefId)).toThrow(/unknown brief/i);
  });
});
