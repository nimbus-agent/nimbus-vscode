import { expect } from "chai";
import { EditorView, VSBrowser, Workbench } from "vscode-extension-tester";

const FIXTURE_FILE = "test/ui/fixture-workspace/src/session.ts";

// The harness's own health check: if this fails, nothing else in the suite is
// meaningful. It proves VS Code launched, the extension activated, and its
// commands are reachable — not that any brief works.
describe("harness smoke", () => {
  before(async () => {
    await VSBrowser.instance.waitForWorkbench();
  });

  it("opens the fixture workspace", async () => {
    const title = await new Workbench().getTitleBar().getTitle();
    expect(title).to.contain("fixture-workspace");
  });

  // package.json gates nimbus.brief.why's commandPalette entry on
  // "editorIsOpen" (menus.commandPalette), so this command is invisible with
  // no editor open — not hidden by a bug, by design, the same as the editor
  // context menu's own "editorTextFocus" gate on the same command. Whatever
  // spec ran immediately before this one may have closed every editor in its
  // own afterEach/after, so this test has to open one itself rather than
  // inherit another spec's leftover state — the ordering that happened to
  // leave an editor open by chance is not something this file controls or
  // should depend on.
  //
  // Once that's true, getQuickPicks() is still not settled the instant
  // setText() resolves: VS Code's fuzzy matcher runs on its own render cycle,
  // and the first paint after typing can still be the "recently used
  // commands" list rather than the filtered one. Poll for the exact label,
  // the same discipline every other spec in this suite already uses for a
  // freshly-opened widget.
  it("registers the Nimbus brief commands", async () => {
    await VSBrowser.instance.openResources(FIXTURE_FILE);
    const prompt = await new Workbench().openCommandPrompt();
    await prompt.setText(">Nimbus: Why is this here?");
    let labels: string[] = [];
    await VSBrowser.instance.driver.wait(
      async () => {
        const picks = await prompt.getQuickPicks();
        labels = await Promise.all(picks.map((p) => p.getLabel()));
        return labels.includes("Nimbus: Why is this here?");
      },
      5000,
      'the command palette never filtered down to "Nimbus: Why is this here?"',
    );
    expect(labels).to.include("Nimbus: Why is this here?");
    await prompt.cancel();
  });

  after(async () => {
    await new EditorView().closeAllEditors();
  });
});
