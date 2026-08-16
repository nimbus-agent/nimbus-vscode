import { expect } from "chai";
import {
  BottomBarPanel,
  EditorView,
  InputBox,
  ModalDialog,
  type Notification,
  TextEditor,
  VSBrowser,
  Workbench,
} from "vscode-extension-tester";

import type { RecordedRequest } from "../fake-gateway.js";
import { NIGHTLY_STEP_LABELS, NIGHTLY_TRIAGE } from "../fixtures/workflows.js";
import { fake } from "../helpers/gateway.js";

// Checks 2 and 3 of the workflow surface, driven in a real VS Code.
//
// Check 2 — the pre-flight for kind "workflow" is the one gated surface whose
// preview is a MANIFEST rather than the literal outbound bytes, because the
// extension sends only a workflow name and the Gateway expands the saved steps.
// Every string asserted below is copied from buildRunManifest / preflight.ts,
// not paraphrased.
//
// Check 3 — cancellation lands at the NEXT step boundary. The fake Gateway
// models that: it accepts the cancel, lets the in-flight step emit its
// finishing chunk, and only then settles the run as "cancelled".

// src/workflows/run.ts, buildRunManifest — the honesty guarantee. If this
// sentence ever stops being shown, the preview is claiming to be something it
// is not, and this spec must fail.
const OMISSION =
  "The Gateway expands each step into its own model prompt from the saved workflow; the extension sends only the workflow name and the options above, and never sees the expanded text.";

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

// Same polling rationale as briefs-gated.test.ts: a freshly-rendered
// notification's buttons are not reliably readable the instant
// getNotifications() resolves, so poll the whole read and fail loudly if the
// named action never shows up. Returns the notification so the caller can act
// on it while it is still fresh — these elements go stale quickly.
async function waitForNotification(message: string, action: string): Promise<Notification> {
  let match: Notification | undefined;
  await VSBrowser.instance.driver.wait(
    async () => {
      try {
        for (const n of await new Workbench().getNotifications()) {
          if (!(await n.getMessage()).includes(message)) continue;
          const titles = await Promise.all((await n.getActions()).map((a) => a.getTitle()));
          if (!titles.includes(action)) continue;
          match = n;
          return true;
        }
      } catch {
        return false;
      }
      return false;
    },
    20000,
    `no notification containing "${message}" with a "${action}" action appeared`,
  );
  if (match === undefined) throw new Error(`no notification matching "${message}"`);
  return match;
}

async function waitForNotificationMessage(message: string): Promise<void> {
  await VSBrowser.instance.driver.wait(
    async () => {
      try {
        const messages = await Promise.all(
          (await new Workbench().getNotifications()).map((n) => n.getMessage()),
        );
        return messages.some((m) => m.includes(message));
      } catch {
        return false;
      }
    },
    20000,
    `no notification containing "${message}" appeared`,
  );
}

// The read-only tab (the full-text preview, or the run report) is opened by the
// extension host after the click resolves, so reading it immediately races the
// open. Polling the editor's own text also means a case can never assert
// against the PREVIOUS tab's content.
//
// Normalised to LF. TextEditor.getText() copies through the clipboard, so on
// Windows it comes back with the document's CRLF line endings — a multi-line
// assertion written with \n would fail on the line endings rather than on the
// content, which is not what any case here is about.
async function waitForEditorText(contains: string): Promise<string> {
  let text = "";
  await VSBrowser.instance.driver.wait(
    async () => {
      try {
        text = (await new TextEditor().getText()).replace(/\r\n/g, "\n");
      } catch {
        return false;
      }
      return text.includes(contains);
    },
    20000,
    `no editor containing "${contains}" appeared`,
  );
  return text;
}

/** Every method the fake has seen, for a failure message that says what happened. */
function methodsSeen(): string {
  return JSON.stringify(
    fake()
      .requests()
      .map((r) => r.method),
  );
}

async function notificationMessages(): Promise<string[]> {
  try {
    return await Promise.all((await new Workbench().getNotifications()).map((n) => n.getMessage()));
  } catch {
    return ["<could not read notifications>"];
  }
}

/** Polls until `check` holds; returns whether it did before the deadline. */
async function pollFor(check: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return true;
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

// driver.wait's message is typed `string`, so it cannot report state gathered
// at the moment of the timeout. This poll can: a wire-level absence is only
// diagnosable if the failure says what DID arrive.
async function waitUntil(
  check: () => Promise<boolean>,
  timeoutMs: number,
  describe: () => string,
): Promise<void> {
  if (!(await pollFor(check, timeoutMs))) throw new Error(describe());
}

async function pickWorkflow(command: string, name: string): Promise<void> {
  await new Workbench().executeCommand(command);
  const picker = await InputBox.create();
  await picker.selectQuickPick(name);
}

function field(params: unknown, key: string): unknown {
  if (typeof params !== "object" || params === null) return undefined;
  return (params as Record<string, unknown>)[key];
}

function recorded(method: string): RecordedRequest[] {
  return fake()
    .requests()
    .filter((r) => r.method === method);
}

describe("running a workflow", () => {
  before(async () => {
    await VSBrowser.instance.waitForWorkbench();
  });

  afterEach(async () => {
    fake().reset();
    // Best-effort cleanup: a case that fails between opening a modal and
    // dismissing it would leave it over the workbench for every later case,
    // including its own retries (.mocharc.ui.js sets retries: 2).
    try {
      const dialog = new ModalDialog();
      await dialog.getMessage();
      await dialog.pushButton("Cancel");
    } catch {
      // no modal open — the common case.
    }
    // Cleared AND closed. A notification centre left open holds keyboard focus,
    // and the next case's Workbench.executeCommand then finds the quick-input
    // widget present but not interactable — observed as an
    // ElementNotInteractableError at the very first line of the next case,
    // three retries running.
    try {
      const centre = await new Workbench().openNotificationsCenter();
      await centre.clearAllNotifications();
      await centre.close();
    } catch {
      // nothing to clear.
    }
    try {
      await new BottomBarPanel().toggle(false);
    } catch {
      // panel already closed.
    }
    await new EditorView().closeAllEditors();
  });

  // Check 2, part one. The modal's `detail` is summarizeEgress() — a headline
  // plus the omissions. It deliberately does NOT carry the manifest body: no
  // gated surface puts the outbound text in the modal (a modal cannot scroll),
  // which is what "Show full text" is for. So this asserts what the modal
  // really renders, and the case below asserts the manifest itself.
  it("pre-flights a dry run with the workflow named and the expansion disclosed", async () => {
    await pickWorkflow("Nimbus: Dry-Run Workflow", NIGHTLY_TRIAGE.name);
    const dialog = await waitForModal();
    expect(await dialog.getMessage()).to.contain("Send this to the Nimbus agent?");
    const detail = await dialog.getDetails();
    expect(detail).to.contain(`Dry-run workflow ${NIGHTLY_TRIAGE.name}`);
    expect(detail).to.contain(OMISSION);
    await dialog.pushButton("Cancel");
  });

  // Check 2, part two: the manifest itself — mode line and every step label, in
  // order. `Show full text` opens the read-only preview; the follow-up ask is
  // deliberately NOT modal (see gate.ts's askAfterFullText), so it is a
  // notification with Send / Cancel rather than a dialog.
  it("shows the mode line and every step in order behind Show full text", async () => {
    await pickWorkflow("Nimbus: Dry-Run Workflow", NIGHTLY_TRIAGE.name);
    await (await waitForModal()).pushButton("Show full text");
    const text = await waitForEditorText(`Workflow: ${NIGHTLY_TRIAGE.name}`);
    expect(text).to.contain("Mode: dry run (no steps execute)");
    expect(text).to.contain(`Description: ${NIGHTLY_TRIAGE.description}`);
    // Numbered, so this asserts ORDER and not merely presence.
    const steps = NIGHTLY_STEP_LABELS.map((label, i) => `  ${i + 1}. ${label}`).join("\n");
    expect(text).to.contain(`Steps:\n${steps}`);
    expect(text).to.contain(OMISSION);

    const ask = await waitForNotification(
      `Send Dry-run workflow ${NIGHTLY_TRIAGE.name} to the Nimbus agent?`,
      "Cancel",
    );
    await ask.takeAction("Cancel");

    // Nothing may have been sent. Proving an absence right after a click only
    // proves the click was dispatched, so make the absence ORDERED: provoke a
    // real, confirmed run as a sentinel and assert the fake recorded exactly
    // one workflow.run. A leaked send from the cancelled flow would have to
    // arrive first, making this two.
    //
    // The sentinel waits on the WIRE, not on the run report tab. What happens
    // after workflow.run is sent is the run surface's business and is asserted
    // (and currently fails) in the cancellation case below; this case is about
    // the pre-flight, and must not fail for a defect downstream of it.
    await pickWorkflow("Nimbus: Dry-Run Workflow", NIGHTLY_TRIAGE.name);
    await (await waitForModal()).pushButton("Send");
    await waitUntil(
      async () => recorded("workflow.run").length > 0,
      20000,
      () => `the confirmed dry run never reached the Gateway; the fake saw ${methodsSeen()}`,
    );
    const runs = recorded("workflow.run");
    expect(runs).to.have.lengthOf(1);
    expect(field(runs[0]?.params, "name")).to.equal(NIGHTLY_TRIAGE.name);
    expect(field(runs[0]?.params, "dryRun")).to.equal(true);
  });

  // Check 3. The whole point: every string this surface shows about a cancel
  // must say the in-flight step finished, not that the run stopped instantly.
  //
  // THIS CASE FAILS TODAY, and the failure is the surface's, not the spec's.
  // What it found, in a real window: after `workflow.run` goes out, the run
  // throws
  //     Nimbus: workflow nightly-triage failed — o.onCancellationRequested is
  //     not a function
  // because `src/extension.ts`'s runWithCancellableProgress hands `body`
  // straight to vscode.window.withProgress, whose task is invoked as
  // `task(progress, token)` — so the run surface's `token` is really the
  // Progress object. Every run (dry or real) dies there: no report tab, no
  // outcome message, and workflow.cancel never reaches the Gateway. The
  // `vscode` seam types the task as taking the token alone
  // (src/vscode-shim.ts's WindowLike), activate() casts `vscode.window as
  // unknown as WindowApi`, and the unit stubs call `task(token)` — which is
  // why nothing below the UI level could ever have caught it.
  //
  // Left asserting the correct behaviour on purpose. Once the seam passes the
  // real token, this case is what says so.
  it("says cancellation lands at the next step boundary — outcome, report and run log", async () => {
    await pickWorkflow("Nimbus: Run Workflow", NIGHTLY_TRIAGE.name);
    await (await waitForModal()).pushButton("Send");

    // withProgress({ cancellable: true }) renders Cancel as a notification
    // action; clicking it is the only way to reach the token's
    // onCancellationRequested, and so the only honest way to drive this path.
    const progress = await waitForNotification(`Running workflow ${NIGHTLY_TRIAGE.name}`, "Cancel");
    await progress.takeAction("Cancel");

    // The wire: a cancel must have gone out for the SAME run the extension
    // started. Nothing about the rendered strings proves that.
    //
    // The failure message carries the notifications as well as the wire,
    // because those are what tell "the click never landed" apart from "the
    // click landed and the extension threw" — and it is the second.
    const seen = await pollFor(async () => recorded("workflow.cancel").length > 0, 20000);
    if (!seen) {
      throw new Error(
        `no workflow.cancel reached the Gateway; the fake saw ${methodsSeen()}; ` +
          `notifications were ${JSON.stringify(await notificationMessages())}`,
      );
    }
    const streamId = field(recorded("workflow.run")[0]?.params, "streamId");
    expect(streamId).to.be.a("string").and.not.equal("");
    expect(field(recorded("workflow.cancel")[0]?.params, "streamId")).to.equal(streamId);

    // The run report — opened once the run settles, after the in-flight step
    // finished. formatRunReport, src/workflows/run.ts.
    const report = await waitForEditorText("# Workflow run —");
    expect(report).to.contain("- Status: cancelled");
    expect(report).to.contain(
      "Cancelled at the next step boundary. The step that was already running",
    );
    expect(report).to.contain("ran to completion — steps after it never started.");
    // The step the fake let finish is recorded, not discarded.
    expect(report).to.contain(`1. ${NIGHTLY_STEP_LABELS[0]} — done`);

    // The one-line outcome. describeRunOutcome, src/workflows/run.ts.
    await waitForNotificationMessage(
      `Workflow ${NIGHTLY_TRIAGE.name} cancelled after 1 step. The step already running finished first — cancellation takes effect at the next step boundary.`,
    );

    // The run log carries a fourth string nothing else does: what the surface
    // said at the MOMENT the cancel was accepted, while the step was still
    // running. src/workflows/commands.ts.
    const output = await new BottomBarPanel().openOutputView();
    await output.selectChannel("Nimbus Workflow Runs");
    expect(await output.getText()).to.contain(
      "— cancellation requested; the step already running will finish first —",
    );
  });
});
