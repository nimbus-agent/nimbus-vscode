import { expect } from "chai";
import { EditorView, VSBrowser, Workbench } from "vscode-extension-tester";

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

  it("registers the Nimbus brief commands", async () => {
    const prompt = await new Workbench().openCommandPrompt();
    await prompt.setText(">Nimbus: Why is this here?");
    const picks = await prompt.getQuickPicks();
    expect(picks.length).to.be.greaterThan(0);
    await prompt.cancel();
  });

  after(async () => {
    await new EditorView().closeAllEditors();
  });
});
