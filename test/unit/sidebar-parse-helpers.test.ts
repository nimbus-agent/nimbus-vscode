import { describe, expect, test } from "vitest";

import { nodePayload, parseAll } from "../../src/sidebar/parse-helpers.js";

// The two helpers the sidebar views and the tree-node commands share. Both exist
// for a defensive reason that is easy to drop in a rewrite, so they are pinned
// here directly rather than only through the views that use them.

describe("nodePayload", () => {
  test("returns the payload a tree node carries", () => {
    expect(nodePayload({ label: "row", payload: { workflowName: "nightly" } })).toEqual({
      workflowName: "nightly",
    });
  });

  // `typeof null === "object"`, so the null check is not redundant: without it
  // this reads `.payload` off null and throws. A command invoked with no
  // argument at all — by a keybinding, or another extension's executeCommand —
  // arrives here as undefined, which is the same hazard.
  test.each([
    ["null", null],
    ["undefined", undefined],
    ["a string", "nightly-sync"],
    ["a number", 7],
  ])("%s yields undefined rather than throwing", (_case, node) => {
    expect(nodePayload(node)).toBeUndefined();
  });

  test("a node with no payload key yields undefined", () => {
    expect(nodePayload({ label: "row" })).toBeUndefined();
  });
});

describe("parseAll", () => {
  const asPositive = (row: unknown): number | undefined =>
    typeof row === "number" && row > 0 ? row : undefined;

  // A malformed row from the Gateway costs its own row, never the whole view.
  test("keeps what parses and drops what does not", () => {
    expect(parseAll([1, "x", 2, null, -3], asPositive)).toEqual([1, 2]);
  });

  test("an all-malformed batch is empty, not a list of holes", () => {
    expect(parseAll(["x", null, undefined], asPositive)).toEqual([]);
  });

  test("an empty batch stays empty", () => {
    expect(parseAll([], asPositive)).toEqual([]);
  });
});
