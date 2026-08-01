import { describe, expect, test } from "vitest";
import { GIT_STATUS_UNTRACKED, untrackedPathsFrom } from "../../src/scm/untracked.js";

// Status values from the git extension's API enum, for readability below.
const MODIFIED = 5;
const DELETED = 6;
const INDEX_ADDED = 1;

describe("untrackedPathsFrom", () => {
  test("reads the dedicated untracked group (git.untrackedChanges: separate)", () => {
    const paths = untrackedPathsFrom(
      [{ path: ".env.local", status: GIT_STATUS_UNTRACKED }],
      [{ path: "billing.ts", status: MODIFIED }],
    );
    expect(paths).toEqual([".env.local"]);
  });

  // The regression this function exists for: under the DEFAULT
  // `git.untrackedChanges: "mixed"`, VS Code leaves the dedicated group empty
  // and files untracked entries in the working tree alongside real edits. A
  // reader of the dedicated group alone sees nothing, so Review Changes would
  // silently drop a brand-new .env from "Not reviewed".
  test("finds untracked entries in the working tree when the group is empty", () => {
    const paths = untrackedPathsFrom(
      [],
      [
        { path: "billing.ts", status: MODIFIED },
        { path: ".env.local", status: GIT_STATUS_UNTRACKED },
      ],
    );
    expect(paths).toEqual([".env.local"]);
  });

  test("never reports a tracked change as untracked", () => {
    const paths = untrackedPathsFrom(
      [],
      [
        { path: "billing.ts", status: MODIFIED },
        { path: "gone.ts", status: DELETED },
        { path: "staged.ts", status: INDEX_ADDED },
      ],
    );
    expect(paths).toEqual([]);
  });

  test("reports a path once when it appears in both groups", () => {
    const paths = untrackedPathsFrom(
      [{ path: ".env.local", status: GIT_STATUS_UNTRACKED }],
      [{ path: ".env.local", status: GIT_STATUS_UNTRACKED }],
    );
    expect(paths).toEqual([".env.local"]);
  });

  test("no changes yields no paths", () => {
    expect(untrackedPathsFrom([], [])).toEqual([]);
  });
});
