// Compiles the UI specs, starts the fake Gateway, runs ExTester against the
// fixture workspace, and always stops the fake.
//
// The VS Code version is pinned HERE and nowhere else — there is nothing to
// keep it in step with, because no workflow runs this suite: it is local-only
// (see docs/development.md → "UI tests" for the upstream ExTester limitation).
// The pin still matters locally, so two developers download the same editor.
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ExTester, ReleaseQuality } from "vscode-extension-tester";

export const VSCODE_VERSION = "1.104.0";

// Fail-fast: used only before the fake Gateway exists, so there is nothing
// yet for a `finally` to clean up.
const run = (cmd, args) => {
  const r = spawnSync(cmd, args, { stdio: "inherit", shell: process.platform === "win32" });
  if (r.status !== 0) process.exit(r.status ?? 1);
};

// The extension under test is what `dist/extension.js` (package.json's
// `main`) actually contains — esbuild has to run before the specs do, or the
// suite silently exercises whatever was last built rather than the code
// under test. No CI job builds ahead of this one (nothing runs `test:ui` at
// all), so this line is the only thing that makes the run honest.
run("node", ["esbuild.mjs"]);

// tsc does not remove outputs for sources that were since deleted or renamed,
// so a stale compiled spec keeps running under its old name — already
// observed producing 13 passing instead of 12 after a rename. A spec deleted
// for being wrong must not keep passing locally.
rmSync("out", { recursive: true, force: true });
run("bunx", ["tsc", "-p", "tsconfig.ui.json"]);

const { createFakeGateway } = await import("../out/ui/fake-gateway.js");
const gateway = createFakeGateway();
await gateway.start();
console.log(`[run-ui-tests] fake Gateway listening at ${gateway.socketPath}`);

// Everything from here on must be guarded by the gateway.stop() in `finally`
// below: mkdirSync/writeFileSync can throw (e.g. a read-only or full disk),
// and a throw before the try started would leave the fake's `net` server
// listening — holding the event loop open so the script hangs instead of
// exiting, and on POSIX leaking the socket file in tmpdir().
let status = 0;
try {
  // The specs read this off `globalThis` via test/ui/helpers/gateway.ts. That
  // only works because the test run below goes through ExTester's JS API
  // (`setupAndRunTests`), which loads the compiled specs into THIS process via
  // `mocha.addFile()` + `mocha.run()`. The `extest` CLI (`bunx extest ...`)
  // forks a brand-new Node process instead, which can never see a global set
  // here — confirmed by running Task 3's first fake()-using spec against the
  // CLI form: it failed every case with "fake gateway not started by the
  // runner". Keep this call in-process; do not swap back to the CLI form.
  globalThis.__nimbusFakeGateway = gateway;

  // The extension reads nimbus.socketPath from settings, so the path has to be
  // written before VS Code opens. This file is generated into out/ (gitignored)
  // and installed at USER scope via ExTester's own `settings:` RunOption below
  // — NOT written into the fixture workspace's tracked .vscode/settings.json.
  // That file doesn't exist any more (deleted): writing a live pipe path into a
  // committed file left the worktree permanently dirty, and this exact mechanism
  // already put a personal path into a commit on this branch once (177ba5f).
  // A workspace-scope settings.json would also have been a trap the other way —
  // a workspace-scope `nimbus.socketPath: ""` overrides a user-scope value, so
  // keeping both would have made the fixture workspace's file win.
  mkdirSync("out", { recursive: true });
  const settingsPath = join("out", "ui-settings.json");
  writeFileSync(
    settingsPath,
    `${JSON.stringify(
      {
        "nimbus.socketPath": gateway.socketPath,
        "nimbus.autoStartGateway": false,
        "nimbus.egress.showStatusBarBadge": false,
        "nimbus.briefs.showHoverBlame": false,
        // WITHOUT THIS, TASK 4 CANNOT WORK. VS Code renders a modal
        // showWarningMessage as a NATIVE OS dialog by default, and Selenium
        // cannot see, read or click a native dialog — ExTester's ModalDialog page
        // object only drives the HTML one. The gate's whole surface is modal, so
        // every Group B spec would hang until it timed out, with a failure that
        // looks like a broken extension rather than a missing setting.
        // (ExTester also defaults this to "custom" itself — see browser.js's
        // defaultSettings — but it's pinned here explicitly rather than relying
        // on an upstream default that could change.)
        "window.dialogStyle": "custom",
      },
      null,
      2,
    )}\n`,
  );

  // Equivalent to `bunx extest setup-and-run ./out/ui/specs/**/*.test.js
  // -c VSCODE_VERSION -m .mocharc.ui.js -s ./test-resources
  // -r ./test/ui/fixture-workspace`, arg-for-arg — see ExTester's own `cli.ts`
  // `setup-and-run` action for the mapping from CLI flags to this call. The
  // difference from the CLI form is only WHERE it runs: in this process,
  // instead of a `bunx`-forked one, which is what lets the specs see
  // `globalThis.__nimbusFakeGateway` set above.
  //
  // The third argument, extensionsDir, matters: omitting it makes
  // installExt run `--force --install-extension <vsix>` with no
  // `--extensions-dir` against the downloaded stable VS Code, whose default
  // extensions directory is the SAME `~/.vscode/extensions` a developer's own
  // editor uses — every run would force-install this locally-packaged build
  // over whatever they had there. Pointing it at test-resources/extensions
  // also makes "which copy is under test" deterministic.
  const extest = new ExTester(
    "./test-resources",
    ReleaseQuality.Stable,
    "./test-resources/extensions",
  );
  status = await extest.setupAndRunTests(
    ["./out/ui/specs/**/*.test.js"],
    VSCODE_VERSION,
    {},
    {
      config: ".mocharc.ui.js",
      // resources: the folder VS Code opens.
      resources: ["./test/ui/fixture-workspace"],
      // Installed at USER scope (codeUtil.js's parseSettings, merged into
      // browser.js's defaultSettings) — see the comment above settingsPath.
      settings: settingsPath,
    },
  );
} finally {
  await gateway.stop();
  console.log("[run-ui-tests] fake Gateway stopped");
}
process.exit(status);
