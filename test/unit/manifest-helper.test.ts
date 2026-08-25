import { describe, expect, test } from "vitest";

import {
  commands,
  configProperties,
  contributes,
  editorContext,
  itemContext,
  lmTools,
  palette,
  views,
  viewTitle,
  welcome,
} from "./helpers/manifest.js";

// Fail-closed guard for the shared manifest reader that eleven manifest-*.test.ts
// files assert against.
//
// Every accessor in that helper ends in `?? []` or `?? {}`, which is right — a
// test should not crash on a manifest that has not grown a section yet — but it
// means a helper that stopped finding `contributes` hands all eleven suites an
// empty list instead of an error. Most of their assertions do notice (emptying
// `contributes` reds 37 of 47), yet the ten that are NEGATIVE assertions — "no
// command is missing a category", "nothing outside the allow-list appears in the
// palette" — pass on an empty list precisely because there is nothing left to
// violate them. Those ten are the ones this file protects: it is the only place
// that says the lists are non-empty at all.
//
// The numbers below are deliberately floors, not exact counts. An exact count
// here would turn every added command into a two-file edit for no benefit — the
// per-section suites already assert what each entry has to look like. This
// file's only job is "the manifest was actually read".

describe("the shared manifest helper reads a manifest that is actually there", () => {
  test("contributes is a populated object, not the `?? {}` fallback", () => {
    expect(Object.keys(contributes).length).toBeGreaterThan(0);
  });

  // One case per list the eleven suites draw on. Floors are set an order of
  // magnitude below today's counts (58 commands, 8 views, 7 welcome entries,
  // 15 palette rows, 10 editor/context rows, 9 view/title rows, 13
  // view/item/context rows, 2 LM tools, 17 settings) so this never fights a
  // deletion — only a read that returned nothing.
  test.each([
    ["commands", commands.length, 10],
    ["views", views.length, 3],
    ["viewsWelcome", welcome.length, 3],
    ["menus.commandPalette", palette.length, 3],
    ["menus.editor/context", editorContext.length, 3],
    ["menus.view/title", viewTitle.length, 3],
    ["menus.view/item/context", itemContext.length, 3],
    ["languageModelTools", lmTools.length, 1],
  ])("contributes.%s parsed to at least %i entries", (_section, actual, floor) => {
    expect(actual).toBeGreaterThanOrEqual(floor);
  });

  // configProperties flattens across however many configuration blocks the
  // manifest uses, so it fails in a second way the lists above cannot: the
  // manifest is a single block today, and a change to an array of blocks that
  // the helper failed to flatten would empty it while `contributes` stayed
  // populated.
  test("configProperties flattened to a populated map of nimbus.* settings", () => {
    const keys = Object.keys(configProperties);
    expect(keys.length).toBeGreaterThanOrEqual(5);
    expect(keys.every((k) => k.startsWith("nimbus."))).toBe(true);
  });
});
