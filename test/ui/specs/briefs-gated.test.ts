import { expect } from "chai";
import { EditorView, ModalDialog, TextEditor, VSBrowser, Workbench } from "vscode-extension-tester";

import { fake } from "../helpers/gateway.js";

const FIXTURE_FILE = "test/ui/fixture-workspace/src/session.ts";

// ModalDialog's getters do a single findElement with no built-in wait, so
// asking for one the instant executeCommand() resolves is a race: the gate's
// showWarningMessage call still has to cross the extension host and render.
// Poll via the page object's own API (getMessage) rather than a raw selector,
// so this cannot pass on a dialog that never appears — it only absorbs the
// render delay of one that does.
async function waitForModal(): Promise<ModalDialog> {
  let dialog: ModalDialog | undefined;
  await VSBrowser.instance.driver.wait(
    async () => {
      const candidate = new ModalDialog();
      try {
        await candidate.getMessage();
      } catch {
        return false;
      }
      dialog = candidate;
      return true;
    },
    10000,
    "no pre-flight modal appeared",
  );
  if (dialog === undefined) throw new Error("no pre-flight modal appeared");
  return dialog;
}

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
    await new EditorView().closeAllEditors();
  });

  it("shows a pre-flight modal naming the ref, and Cancel sends nothing", async () => {
    await new Workbench().executeCommand("Nimbus: Who knew this code?");
    const dialog = await waitForModal();
    expect(await dialog.getDetails()).to.contain("src/session.ts");
    await dialog.pushButton("Cancel");
    expect(fake().requests()).to.deep.equal([]);
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
