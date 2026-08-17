import { expect } from "chai";
import {
  ActivityBar,
  EditorView,
  ModalDialog,
  VSBrowser,
  WebviewView,
} from "vscode-extension-tester";

import { fake } from "../helpers/gateway.js";
import { waitForModal } from "../helpers/modal.js";

const FIXTURE_FILE = "test/ui/fixture-workspace/src/session.ts";

// The panel is a WebviewView (a sidebar view backed by a WebviewViewProvider),
// NOT an editor-tab webview — vscode-extension-tester models those as two
// different page objects (`WebView` extends `Editor`; `WebviewView` does not).
// Every assertion about its CONTENT has to be made from inside its frame.
// Everything about the gate modal is made from outside it — a modal is
// workbench chrome, not webview content.
async function openContextView(): Promise<WebviewView> {
  const control = await new ActivityBar().getViewControl("Nimbus");
  if (control === undefined) throw new Error("no Nimbus control in the activity bar");
  await control.openView();
  return new WebviewView();
}

// Used inside driver.wait() predicates (see the three call sites below), so
// this must never let an exception escape: the outer iframe.webview.ready
// element does not exist until the webview signals ready, and until then
// WebviewMixin's switchToFrame() sees getViewToSwitchTo() return undefined
// and silently no-ops rather than throwing (`if (!view) { return; }`) —
// leaving the driver in the main document, where findWebElement's #root
// lookup then throws NoSuchElementError. driver.wait() does not swallow a
// thrown error from its predicate; it rejects the whole wait immediately
// instead of retrying. Catching here, and returning "" rather than
// propagating, is what lets the poll actually absorb the load latency it
// exists to absorb. switchToFrame() itself is inside the try (not just
// findWebElement) for the same reason on the other failure mode: if the outer
// iframe DOES exist but the inner active-frame never renders within
// switchToFrame()'s own 5s wait, it throws from partway through having
// already switched into the outer frame — that has to reach the same finally
// too, or a later poll attempt is left searching the wrong document.
async function textInPanel(view: WebviewView): Promise<string> {
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

describe("ambient context panel", function () {
  this.timeout(120_000);

  before(async () => {
    await VSBrowser.instance.waitForWorkbench();
  });

  beforeEach(async () => {
    await VSBrowser.instance.openResources(FIXTURE_FILE);
  });

  afterEach(async () => {
    fake().reset();
    // Best-effort, same discipline as briefs-gated.test.ts's afterEach: a case
    // that fails between opening the modal and dismissing it would otherwise
    // leave it over the workbench for every later case.
    try {
      const dialog = new ModalDialog();
      await dialog.getMessage();
      await dialog.pushButton("Cancel");
    } catch {
      // no modal open — the common case.
    }
    await new EditorView().closeAllEditors();
  });

  it("renders its sections for the open file", async () => {
    const view = await openContextView();
    // h2 headings render uppercase via styles.css's text-transform, which
    // Chromium's rendered-text algorithm (what getText() reads) reflects — so
    // "History" is asserted here as "HISTORY". Polled because the panel's
    // first paint can race this read: the webview has to load its script,
    // round-trip a "ready" message to the extension host, and receive the
    // collected snapshot back before any section renders at all.
    await VSBrowser.instance.driver.wait(
      async () => (await textInPanel(view)).includes("HISTORY"),
      20_000,
      "the context panel never rendered its History section",
    );
    const text = await textInPanel(view);
    expect(text).to.include("PROBLEMS");
    expect(text).to.include("HISTORY");
    expect(text).to.include("RELATED");
    expect(text).to.include("ASK ABOUT THIS");
  });

  // Proves the Gateway round trip for the blame signal specifically: the panel
  // does not just render section headings, it renders what agents.whyPeek
  // actually answered for the cursor line.
  it("shows the blame the Gateway returned for the cursor line", async () => {
    const view = await openContextView();
    const author = fake().whyPeekAuthor();
    await VSBrowser.instance.driver.wait(
      async () => (await textInPanel(view)).includes(author),
      20_000,
      "the panel never rendered the canned blame author",
    );
  });

  // THE strongest assertion in this file: it proves the offer list rendered,
  // the button is wired to a real command, that command is on the allowlist
  // the extension host will execute, and the whole thing is routed through
  // the pre-flight gate rather than firing straight at the Gateway.
  it("routes an offer through the pre-flight gate", async () => {
    const view = await openContextView();
    await VSBrowser.instance.driver.wait(
      async () => (await textInPanel(view)).includes("ASK ABOUT THIS"),
      20_000,
      "the panel never rendered its offers",
    );
    await view.switchToFrame();
    try {
      const button = await view.findWebElement({ css: "button.offer" });
      await button.click();
    } finally {
      await view.switchBack();
    }
    // Reuse the shared helper rather than re-implementing the poll —
    // ModalDialog's getters do a single findElement with no built-in wait.
    const dialog = await waitForModal();
    expect(await dialog.getMessage()).to.include("Send this to the Nimbus agent?");
    await dialog.pushButton("Cancel");
  });
});
