// Compiles the UI specs, starts the fake Gateway, runs ExTester against the
// fixture workspace, and always stops the fake.
//
// The VS Code version is pinned HERE and nowhere else. CI keys its download
// cache on the same value, so local and CI cannot silently diverge.
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { ExTester } from "vscode-extension-tester";

export const VSCODE_VERSION = "1.104.0";

// Fail-fast: used only before the fake Gateway exists, so there is nothing
// yet for a `finally` to clean up.
const run = (cmd, args) => {
  const r = spawnSync(cmd, args, { stdio: "inherit", shell: process.platform === "win32" });
  if (r.status !== 0) process.exit(r.status ?? 1);
};

run("bunx", ["tsc", "-p", "tsconfig.ui.json"]);

const { createFakeGateway } = await import("../out/ui/fake-gateway.js");
const gateway = createFakeGateway();
await gateway.start();
console.log(`[run-ui-tests] fake Gateway listening at ${gateway.socketPath}`);

// The specs read this off `globalThis` via test/ui/helpers/gateway.ts. That
// only works because the test run below goes through ExTester's JS API
// (`setupAndRunTests`), which loads the compiled specs into THIS process via
// `mocha.addFile()` + `mocha.run()`. The `extest` CLI (`bunx extest ...`)
// forks a brand-new Node process instead, which can never see a global set
// here — confirmed by running Task 3's first fake()-using spec against the
// CLI form: it failed every case with "fake gateway not started by the
// runner". Keep this call in-process; do not swap back to the CLI form.
globalThis.__nimbusFakeGateway = gateway;

// The extension reads nimbus.socketPath from the fixture workspace's settings,
// so the path has to be written before VS Code opens.
const settingsPath = join("test", "ui", "fixture-workspace", ".vscode", "settings.json");
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
let status = 0;
try {
  const extest = new ExTester("./test-resources");
  status = await extest.setupAndRunTests(
    ["./out/ui/specs/**/*.test.js"],
    VSCODE_VERSION,
    {},
    {
      config: ".mocharc.ui.js",
      // resources: the folder VS Code opens.
      resources: ["./test/ui/fixture-workspace"],
    },
  );
} finally {
  await gateway.stop();
  console.log("[run-ui-tests] fake Gateway stopped");
}
process.exit(status);
