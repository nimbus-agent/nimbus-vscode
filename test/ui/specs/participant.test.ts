import { expect } from "chai";
import { EditorView, ModalDialog, TextEditor, VSBrowser, Workbench } from "vscode-extension-tester";

import { fake } from "../helpers/gateway.js";

// --- Investigation (Task 5) ------------------------------------------------
//
// This task set out to prove the @nimbus chat participant's ops briefs
// (/incident, /deploys, /owns, /blast) record without prompting. The brief's
// own plan assumed `Workbench().executeCommand("Nimbus: Blast radius")`
// exists — it does not. package.json's ~68 nimbus.* commands include no
// incident/deploys/owns/blast entry (grepped `"command": "nimbus\.` — no
// match). The ops slash commands are contributed only under
// `contributes.chatParticipants[].commands` (package.json:266-291) — reachable
// exclusively by typing "@nimbus /blast" into VS Code's built-in Chat view.
//
// So the real question was whether ExTester can drive that Chat view. It
// cannot, at least not through a page object:
//   - `node -e "console.log(Object.keys(require('vscode-extension-tester')))"`
//     lists every exported page object (Workbench, ActivityBar, SideBarView,
//     WebviewView, InputBox, ModalDialog, Notification, ScmView, DebugView,
//     SettingsEditor, ...) — none of them is chat-shaped, and nothing in the
//     list matches /chat/i.
//   - `find node_modules/@redhat-developer/page-objects/out/components` shows
//     the covered areas: activityBar, bottomBar, dialog, editor, menu,
//     sidebar(+debug/extensions/scm/tree), statusBar, workbench(+input). No
//     `chat` directory.
//   - `grep -ril chat node_modules/vscode-extension-tester` / the
//     page-objects package: no hits anywhere in either package (not even in
//     internal .d.ts files) — vscode-extension-tester 8.23.0 has no model of
//     the Chat view's input box or response stream at all.
// The task's rules require page objects only (no raw CSS/XPath), so driving
// the Chat view honestly is not available here. That rules out Outcome 1.
//
// This file instead takes Outcome 2: it proves the OTHER half of the ledger
// surface CLAUDE.md describes — the "before-the-fact" gate and its
// `Nimbus: Show Last Outbound Payload` window really do show what a gated
// send just recorded, using an editor brief (as briefs-gated.test.ts already
// drives) as the send. That is a genuine UI-level proof of the ledger-viewer
// wiring in src/extension.ts's `nimbus.showLastOutbound` handler.
//
// NOT covered by this file, and NOT covered anywhere else in the UI suite:
//   - That a bare `/blast` (no argument, editor open) redacts the selection's
//     absolute path down to a basename before it reaches the Gateway.
//   - That the participant's ops commands record with no modal in the way.
// Both remain proven only at the unit level (src/chat-participant tests) —
// see the task report for the full detail.
// ----------------------------------------------------------------------------

const FIXTURE_FILE = "test/ui/fixture-workspace/src/session.ts";

// Same polling rationale as briefs-gated.test.ts: ModalDialog's getters do a
// single findElement with no built-in wait, so this must poll via the page
// object's own API rather than assume the modal is already rendered the
// instant executeCommand() resolves — and it must fail loudly, not fall
// through, if the modal never appears.
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

describe("the ledger's Show Last Outbound Payload reflects a real send", () => {
  before(async () => {
    await VSBrowser.instance.waitForWorkbench();
    await VSBrowser.instance.openResources(FIXTURE_FILE);
  });

  afterEach(async () => {
    fake().reset();
    await new EditorView().closeAllEditors();
  });

  it("shows the just-recorded gated send, not a stale or empty state", async () => {
    await new Workbench().executeCommand("Nimbus: Who knew this code?");
    await (await waitForModal()).pushButton("Send");
    // Confirm the send actually reached the fake before trusting the viewer.
    const sent = fake()
      .requests()
      .find((r) => r.method === "agents.ghost");
    expect(sent?.params).to.deep.equal({ file: "src/session.ts" });

    await new Workbench().executeCommand("Nimbus: Show Last Outbound Payload");
    const text = await new TextEditor().getText();
    expect(text).to.contain("src/session.ts");
    expect(text).to.contain("agents.ghost");
  });
});
