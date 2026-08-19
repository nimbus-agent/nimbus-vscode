import { expect } from "chai";
import { EditorView, InputBox, VSBrowser, WebView, Workbench } from "vscode-extension-tester";

import { fake } from "../helpers/gateway.js";

const FIXTURE_FILE = "test/ui/fixture-workspace/src/session.ts";
// The attach picker's file items are repo-relative to the opened workspace
// (test/ui/fixture-workspace), so this is just "src/auth.ts" — not prefixed
// with the outer path used to open the resource below. "auth.ts" alone is a
// safe substring match: it's the only fixture file whose name contains it
// (the other is session.ts, already open as the active editor).
const ATTACH_LABEL = "src/auth.ts";
const QUESTION = "What does this file do?";

// The Ask panel is a WebviewPanel (an editor-tab webview created via
// createWebviewPanel), NOT a WebviewView — vscode-extension-tester models
// those as different page objects (WebView extends Editor; WebviewView does
// not). Content assertions have to be made from inside its frame; nothing
// here is workbench chrome, so unlike context-panel.test.ts / briefs specs
// there is no ModalDialog to defend against in afterEach.

// Used inside driver.wait() predicates below, so it must never let an
// exception escape — the same discipline as context-panel.test.ts's
// textInPanel, and for the same reason: the outer iframe's #root does not
// exist until the webview has loaded its script and posted "ready", and
// until then switchToFrame() (or the findWebElement after it) throws. A poll
// has to read that as "not yet", not as a hard failure.
async function textInWebview(view: WebView): Promise<string> {
  try {
    await view.switchToFrame();
    const root = await view.findWebElement({ css: "#root" });
    return await root.getText();
  } catch {
    return "";
  } finally {
    await view.switchBack();
  }
}

// Runs the Attach Context command, which itself opens (or reveals) the Ask
// panel via ensureChatController() before the file picker even renders — see
// attachPicker() in src/extension.ts. There is deliberately no separate
// "open the Ask panel first" step: that IS how a user reaches the panel via
// this command, and driving it any other way would test a path nobody takes.
async function attachFixtureFile(): Promise<WebView> {
  await new Workbench().executeCommand("Nimbus: Attach Context to Ask");
  const picker = await InputBox.create();
  await picker.selectQuickPick(ATTACH_LABEL);
  return new WebView();
}

describe("Ask panel attachments", function () {
  this.timeout(120_000);

  before(async () => {
    await VSBrowser.instance.waitForWorkbench();
  });

  beforeEach(async () => {
    await VSBrowser.instance.openResources(FIXTURE_FILE);
  });

  afterEach(async () => {
    fake().reset();
    await new EditorView().closeAllEditors();
  });

  it("attaches a file, sends it, and detaches it — chips as a live preview and a sent-turn record", async () => {
    const view = await attachFixtureFile();

    // 1. A chip appears bearing the attached file's name.
    await VSBrowser.instance.driver.wait(
      async () => (await textInWebview(view)).includes(ATTACH_LABEL),
      20_000,
      "no chip for the attached file ever rendered in the composer",
    );

    // 2. Send a question.
    await view.switchToFrame();
    try {
      const input = await view.findWebElement({ css: "#input-text" });
      await input.sendKeys(QUESTION);
      const send = await view.findWebElement({ css: "#input-send" });
      await send.click();
    } finally {
      await view.switchBack();
    }

    // Wait for the fake Gateway's reply, which proves the whole round trip —
    // attach, send, stream — actually completed rather than the turn having
    // stalled on an error.
    await VSBrowser.instance.driver.wait(
      async () => (await textInWebview(view)).includes(fake().askReply()),
      20_000,
      "the assistant's reply never rendered",
    );

    // 3a. The composer chip's count is non-zero.
    await view.switchToFrame();
    let sentTurnLabel: string;
    let turnRemoveDisplay: string;
    try {
      const chipCount = await view.findWebElement({ css: "#attach-mount .chip-count" });
      const chars = Number(await chipCount.getText());
      expect(chars).to.be.greaterThan(0);

      // 3b. The sent turn carries its own chip row.
      const turnChipLabel = await view.findWebElement({
        css: ".turn-user .turn-chips .chip-label",
      });
      sentTurnLabel = await turnChipLabel.getText();

      // A sent turn's chips are a RECORD, not a control: same chip markup as
      // the composer, but styles.css hides the remove button on it. This is
      // the one place this spec proves the stylesheet actually loaded under
      // the webview's CSP nonce — a broken <link> would leave every class
      // present but no rule applied, and this button would render visible.
      const turnRemoveBtn = await view.findWebElement({
        css: ".turn-user .turn-chips .chip-remove",
      });
      turnRemoveDisplay = await turnRemoveBtn.getCssValue("display");
    } finally {
      await view.switchBack();
    }
    expect(sentTurnLabel).to.include(ATTACH_LABEL);
    expect(turnRemoveDisplay).to.equal("none");

    // 4. Detach, and the composer chip disappears — but the sent turn's own
    // record does not, proving detach only affects what a FUTURE turn would
    // carry, not what already went out.
    await view.switchToFrame();
    try {
      const removeBtn = await view.findWebElement({ css: "#attach-mount .chip-remove" });
      await removeBtn.click();
    } finally {
      await view.switchBack();
    }
    await VSBrowser.instance.driver.wait(
      async () => {
        await view.switchToFrame();
        try {
          const chips = await view.findWebElements({ css: "#attach-mount .chip" });
          return chips.length === 0;
        } catch {
          return false;
        } finally {
          await view.switchBack();
        }
      },
      20_000,
      "the composer chip never disappeared after detaching",
    );
    const textAfterDetach = await textInWebview(view);
    expect(textAfterDetach).to.include(ATTACH_LABEL); // the sent turn's record survives
  });
});
