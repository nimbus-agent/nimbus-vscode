// Compiles the UI specs, starts the fake Gateway, runs ExTester against the
// fixture workspace, and always stops the fake.
//
// The VS Code version is pinned HERE and nowhere else. CI keys its download
// cache on the same value, so local and CI cannot silently diverge.
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

export const VSCODE_VERSION = "1.104.0";

const run = (cmd, args) => {
  const r = spawnSync(cmd, args, { stdio: "inherit", shell: process.platform === "win32" });
  if (r.status !== 0) process.exit(r.status ?? 1);
};

run("bunx", ["tsc", "-p", "tsconfig.ui.json"]);

const { createFakeGateway } = await import("../out/ui/fake-gateway.js");
const gateway = createFakeGateway();
await gateway.start();
console.log(`[run-ui-tests] fake Gateway listening at ${gateway.socketPath}`);

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

try {
  run("bunx", [
    "extest",
    "setup-and-run",
    "./out/ui/specs/**/*.test.js",
    "-c",
    VSCODE_VERSION,
    "-m",
    ".mocharc.ui.js",
    "-s",
    "./test-resources",
    // -r / --open_resource: the folder VS Code opens. NOT -o.
    "-r",
    "./test/ui/fixture-workspace",
  ]);
} finally {
  await gateway.stop();
}
