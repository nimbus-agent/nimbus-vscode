import { expect } from "chai";
import { EditorView, ModalDialog, TextEditor, VSBrowser, Workbench } from "vscode-extension-tester";

import { fake } from "../helpers/gateway.js";
import { waitForModal } from "../helpers/modal.js";

const FIXTURE_FILE = "test/ui/fixture-workspace/src/session.ts";

// A freshly-shown notification's action buttons are not reliably readable the
// instant getNotifications() resolves: NotificationButton's label is read via
// the element's own rendered text, and that text can still be empty a tick
// after the toast appears. Poll the whole read — message AND action titles —
// through the page objects' own API until both the detail text and the named
// action show up, catching the transient read failure as "not yet" rather
// than papering over a genuinely missing action: if `action` never appears,
// driver.wait's TimeoutError propagates and the case fails.
async function waitForNotification(
  detail: string,
  action: string,
): Promise<{ messages: string[]; actionTitles: string[] }> {
  let messages: string[] = [];
  let actionTitles: string[] = [];
  await VSBrowser.instance.driver.wait(
    async () => {
      try {
        const notifications = await new Workbench().getNotifications();
        messages = await Promise.all(notifications.map((n) => n.getMessage()));
        const actionsByNotification = await Promise.all(notifications.map((n) => n.getActions()));
        actionTitles = await Promise.all(actionsByNotification.flat().map((a) => a.getTitle()));
      } catch {
        return false;
      }
      return messages.some((m) => m.includes(detail)) && actionTitles.includes(action);
    },
    10000,
    `no notification containing "${detail}" with a "${action}" action appeared`,
  );
  return { messages, actionTitles };
}

// Group B: briefs that DO reach the gate. The fake's recording is what proves
// it — a modal appearing is not proof nothing was sent, and a rendered tab is
// not proof of what the wire actually carried.
describe("briefs through the gate", () => {
  before(async () => {
    await VSBrowser.instance.waitForWorkbench();
  });

  // Every case needs the fixture file focused — "why" reads the cursor
  // position from it, and "ghost" derives its ref from the active editor. The
  // afterEach below closes every tab, so re-opening it before each case (not
  // just once, in `before`) is what keeps cases 2+ from running with no
  // active editor at all.
  beforeEach(async () => {
    await VSBrowser.instance.openResources(FIXTURE_FILE);
  });

  afterEach(async () => {
    fake().reset();
    // Best-effort: a case that fails between waitForModal() and pushButton()
    // leaves a modal open, which blocks closeAllEditors() below and cascades
    // into every later case (including, with .mocharc.ui.js's retries: 2, the
    // retried attempts of THIS case). A clean run never has a modal open here,
    // so getMessage() throwing is the expected, silent path.
    try {
      const dialog = new ModalDialog();
      await dialog.getMessage();
      await dialog.pushButton("Cancel");
    } catch {
      // no modal open — the common case.
    }
    // Best-effort: an undismissed toast (e.g. this file's own "Retry" case)
    // survives into the next case, and with retries: 2 a retried attempt's
    // waitForNotification() can match that LEFTOVER toast and pass green even
    // if the retried send never happened. Wrapped in try/catch so a clean run
    // — nothing to clear — isn't destabilised by this cleanup.
    try {
      await (await new Workbench().openNotificationsCenter()).clearAllNotifications();
    } catch {
      // nothing to clear.
    }
    await new EditorView().closeAllEditors();
  });

  it("shows a pre-flight modal naming the ref, and Cancel sends nothing", async () => {
    await new Workbench().executeCommand("Nimbus: Who knew this code?");
    const dialog = await waitForModal();
    expect(await dialog.getDetails()).to.contain("src/session.ts");
    await dialog.pushButton("Cancel");
    // A leaked send would originate in the extension host and cross the same
    // socket as everything else, so its absence can't be proven by reading
    // immediately after the click resolves — that only proves the click was
    // dispatched, not that the extension host finished reacting to it. Instead
    // make the absence ORDERED: provoke a second, real send (confirmed through
    // the gate) as a sentinel and assert the fake recorded ONLY that one. A
    // leaked Cancel-send would have to arrive on the wire first, making this
    // array longer than one entry and failing the deep-equal below.
    await new Workbench().executeCommand("Nimbus: Why is this here?");
    await (await waitForModal()).pushButton("Send");
    expect(
      fake()
        .requests()
        .map((r) => r.method),
    ).to.deep.equal(["agents.why"]);
  });

  it("sends and renders the brief when the modal is confirmed", async () => {
    await new Workbench().executeCommand("Nimbus: Who knew this code?");
    await (await waitForModal()).pushButton("Send");
    const editor = new TextEditor();
    const text = await editor.getText();
    expect(text).to.contain("Who knew");
    expect(text).to.contain("Dana");
    expect(
      fake()
        .requests()
        .map((r) => r.method),
    ).to.deep.equal(["agents.ghost"]);
  });

  // VS Code counts lines from 0 and the Gateway counts from 1. This asserts the
  // conversion at the wire, which no unit test can do.
  it("sends a 1-based line for why", async () => {
    const editor = new TextEditor();
    await editor.moveCursor(3, 1);
    await new Workbench().executeCommand("Nimbus: Why is this here?");
    await (await waitForModal()).pushButton("Send");
    const sent = fake()
      .requests()
      .find((r) => r.method === "agents.why");
    expect(sent?.params).to.deep.equal({ ref: "src/session.ts", line: 3 });
  });

  it("surfaces the Gateway's own error detail with a Retry", async () => {
    fake().queueError("agents.huddle", "no peers configured");
    await new Workbench().executeCommand("Nimbus: Team huddle");
    await (await waitForModal()).pushButton("Send");
    // The title promises "with a Retry" — asserting on the message text alone
    // would let a regression that dropped the action pass silently.
    const { messages, actionTitles } = await waitForNotification("no peers configured", "Retry");
    expect(messages.join(" ")).to.contain("no peers configured");
    expect(actionTitles).to.contain("Retry");
  });
});
