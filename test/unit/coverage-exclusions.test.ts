import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

// Coverage exclusions live in TWO independent lists:
//
//   * `coverage.exclude` in vitest.config.ts — what leaves the v8/lcov denominator.
//   * `sonar.coverage.exclusions` in sonar-project.properties — what leaves
//     SonarCloud's.
//
// Nothing connected them, and they drifted: `src/scm/real-git.ts` sits in the
// first and not the second, so vitest emits no lcov record for it and Sonar
// scores the file 0.0% — an artifact of the mismatch, not a coverage gap, and it
// has been read as a gap more than once. The properties file's own comment says
// the two lists must be kept in step while describing only ONE of the two
// divergences, so the comment was itself out of date.
//
// This test does not decide what belongs on either list. It asserts only that
// every divergence is DELIBERATE — named below with a reason — so a new one has
// to be argued for in a diff rather than discovered later in a Sonar report.
//
// Adding a file to both lists needs no edit here. Adding it to one of them does.

const REPO_ROOT = join(__dirname, "..", "..");

/**
 * Files deliberately excluded in one tool and measured by the other.
 *
 * The key is the file; the value is why the asymmetry is correct. Both entries
 * are load-bearing today — read the reason before "fixing" either one.
 */
const KNOWN_DIVERGENCES: Readonly<Record<string, string>> = {
  "src/scm/real-git.ts":
    "vitest-only. The thin adapter over VS Code's built-in git extension, excluded " +
    "from the vitest denominator like the other real-*.ts seams. It is NOT in " +
    "sonar.coverage.exclusions, so Sonar reports it at 0.0% — deliberately left " +
    "visible there rather than hidden by a second exclusion.",
  "src/chat/webview/main.ts":
    "sonar-only. jsdom actually exercises this webview entry point, so vitest " +
    "measures it (~95% statements); Sonar excludes it as browser glue. Removing " +
    "the Sonar exclusion would be the change here, never adding a vitest one.",
};

/** Concrete `src/…` paths in vitest.config.ts's `coverage.exclude`. */
function vitestExclusions(): string[] {
  const config = readFileSync(join(REPO_ROOT, "vitest.config.ts"), "utf8");
  const body = /exclude:\s*\[([\s\S]*?)\]/.exec(config)?.[1];
  if (body === undefined) {
    throw new Error("vitest.config.ts: no `coverage.exclude` array found");
  }
  return [...body.matchAll(/"([^"]+)"/g)].map((m) => m[1] ?? "");
}

/** Entries of `sonar.coverage.exclusions` in sonar-project.properties. */
function sonarExclusions(): string[] {
  const props = readFileSync(join(REPO_ROOT, "sonar-project.properties"), "utf8");
  const line = props.split(/\r?\n/).find((l) => l.startsWith("sonar.coverage.exclusions="));
  if (line === undefined) {
    throw new Error("sonar-project.properties: no `sonar.coverage.exclusions=` line found");
  }
  return line
    .slice("sonar.coverage.exclusions=".length)
    .split(",")
    .map((s) => s.trim());
}

// A glob (`src/**/*.d.ts`) is not a file and cannot be compared path-to-path;
// both tools carry their own, and neither list's globs have ever drifted.
const concrete = (entries: readonly string[]): string[] =>
  entries.filter((e) => e.length > 0 && !e.includes("*")).sort();

describe("coverage exclusions stay in step across vitest and Sonar", () => {
  const vitest = concrete(vitestExclusions());
  const sonar = concrete(sonarExclusions());

  // Fail closed: an empty read means a parser that stopped matching, and every
  // assertion below would pass vacuously on it.
  test("both lists parse to something", () => {
    expect(vitest.length).toBeGreaterThan(0);
    expect(sonar.length).toBeGreaterThan(0);
  });

  test("every divergence is a documented, deliberate one", () => {
    const onlyVitest = vitest.filter((f) => !sonar.includes(f));
    const onlySonar = sonar.filter((f) => !vitest.includes(f));
    const diverging = [...onlyVitest, ...onlySonar].sort();

    expect(
      diverging,
      "A file excluded from one coverage denominator but not the other. Add it to " +
        "BOTH lists, or record why it is asymmetric in KNOWN_DIVERGENCES above.",
    ).toEqual(Object.keys(KNOWN_DIVERGENCES).sort());
  });

  test("no divergence is recorded for a file neither list mentions", () => {
    // Keeps the record honest in the other direction: a file dropped from both
    // lists must lose its entry here too, or this file starts documenting a
    // divergence that no longer exists.
    const listed = new Set([...vitest, ...sonar]);
    const stale = Object.keys(KNOWN_DIVERGENCES).filter((f) => !listed.has(f));
    expect(stale).toEqual([]);
  });

  test("each documented divergence carries a reason", () => {
    for (const [file, reason] of Object.entries(KNOWN_DIVERGENCES)) {
      expect(reason.length, `${file} needs a reason, not an empty string`).toBeGreaterThan(40);
    }
  });
});
