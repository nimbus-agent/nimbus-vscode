import { expect } from "chai";
import { EditorView, InputBox, ModalDialog, VSBrowser, Workbench } from "vscode-extension-tester";

import { fake } from "../helpers/gateway.js";
import { waitForModal } from "../helpers/modal.js";

// validateInput runs on VS Code's own debounce after the input changes, so the
// message element can still hold the OLD text (here, the prompt itself) for a
// beat after setText() resolves. Poll rather than read once, or this becomes a
// flaky "expected the prompt, got the prompt" failure that has nothing to do
// with the brief's validation logic.
async function waitForMessage(input: InputBox, contains: string): Promise<string> {
  let last = "";
  try {
    await VSBrowser.instance.driver.wait(async () => {
      last = await input.getMessage();
      return last.includes(contains);
    }, 5000);
  } catch {
    // Timed out — fall through so the caller's assertion reports what the
    // message actually settled on, instead of a bare Selenium timeout.
  }
  return last;
}

async function runCommand(name: string): Promise<void> {
  await new Workbench().executeCommand(name);
}

const FIXTURE_FILE = "test/ui/fixture-workspace/src/session.ts";

// A "sends nothing" assertion taken immediately after a cancel races the
// process boundary: a leaked send originates in the extension host and has
// to cross the socket to the fake in THIS process, so reading the fake right
// after a click resolves only proves the click was dispatched, not that the
// extension host finished reacting to it. Provoke a second, real send
// (confirmed through the gate) as a sentinel instead, and assert the fake
// recorded ONLY that one — ordering on a single connection means a leaked
// send from the cancelled flow would have to arrive first, making the
// recorded list longer than one entry and failing the caller's deep-equal.
//
// The sentinel itself derives its ref from the active editor, and this
// file's afterEach — unlike briefs-gated.test.ts's — never closes editors
// between cases (closeAllEditors only runs once, in the final `after`). A
// PRIOR sentinel's own read-only result tab is therefore still the most
// recently focused editor by the time a LATER case runs, which is not the
// fixture file — so re-focus it explicitly first, or the sentinel silently
// has no valid ref and no modal ever appears.
async function sendSentinel(): Promise<void> {
  await VSBrowser.instance.openResources(FIXTURE_FILE);
  await runCommand("Nimbus: Who knew this code?");
  await (await waitForModal()).pushButton("Send");
}

// The status bar's connector-health and egress-ledger polls (pollStatusBar in
// src/extension.ts) run on their own timer regardless of anything a spec
// does, and can land inside the window between a case's own action and its
// sendSentinel() call. Both reach no model and are already outside the
// pre-flight egress gate — same class as searchRanked/agents.whyPeek — so
// seeing them here is expected background traffic, not a leak. Filtering
// them out keeps the "sends nothing but the sentinel" guarantee honest: any
// genuine gate-relevant (model-bound) call still shows up and fails the
// assertion below loudly.
const UNGATED_BACKGROUND_METHODS = new Set(["connector.listStatus", "egress.head"]);

function gateRelevantMethods(): string[] {
  return fake()
    .requests()
    .map((r) => r.method)
    .filter((m) => !UNGATED_BACKGROUND_METHODS.has(m));
}

describe("briefs that never send", () => {
  before(async () => {
    await VSBrowser.instance.waitForWorkbench();
    await VSBrowser.instance.openResources(FIXTURE_FILE);
  });

  // Reset AFTER each case, not before: a failing test leaves the fake's state
  // intact for inspection, and a queued error can never leak into a later case.
  //
  // Same rationale as briefs-gated.test.ts's afterEach: a case that fails
  // between opening an InputBox/ModalDialog and dismissing it leaves that
  // prompt open, which the next case would otherwise inherit. Both dismissals
  // are best-effort and deliberately skip InputBox.create()'s built-in wait
  // (default 5s) — `new InputBox()` does a plain findElement with no wait,
  // same as ModalDialog's getMessage() below, so a clean run (nothing open)
  // doesn't pay a timeout on every case.
  afterEach(async () => {
    fake().reset();
    try {
      await new InputBox().cancel();
    } catch {
      // no input box open — the common case.
    }
    try {
      const dialog = new ModalDialog();
      await dialog.getMessage();
      await dialog.pushButton("Cancel");
    } catch {
      // no modal open — the common case.
    }
  });

  after(async () => {
    await new EditorView().closeAllEditors();
  });

  it("prefills the janitor prompt with the active file's relative ref", async () => {
    // Re-focus the fixture file before doing anything else: on a retried
    // attempt, a PRIOR attempt's own sendSentinel() left a read-only result
    // tab focused (afterEach doesn't close editors), which is not the
    // fixture file — without this, the retry sees no active file editor and
    // the prefill assertion below fails for a reason that has nothing to do
    // with what this case is testing.
    await VSBrowser.instance.openResources(FIXTURE_FILE);
    await runCommand("Nimbus: Is this idle?");
    const input = await InputBox.create();
    expect(await input.getText()).to.equal("src/session.ts");
    await input.cancel();
    await sendSentinel();
    expect(gateRelevantMethods()).to.deep.equal(["agents.ghost"]);
  });

  it("rejects a negative idle-days value with an inline message", async () => {
    await runCommand("Nimbus: Is this idle?");
    const ref = await InputBox.create();
    await ref.setText("svc/legacy");
    await ref.confirm();
    const days = await InputBox.create();
    await days.setText("-5");
    const message = await waitForMessage(days, "whole number of days");
    expect(message).to.contain("whole number of days");
    await days.cancel();
    await sendSentinel();
    expect(gateRelevantMethods()).to.deep.equal(["agents.ghost"]);
  });

  it("accepts a blank idle-days value", async () => {
    await runCommand("Nimbus: Is this idle?");
    const ref = await InputBox.create();
    await ref.setText("svc/legacy");
    await ref.confirm();
    const days = await InputBox.create();
    expect(await days.getMessage()).to.not.contain("whole number");
    // Confirm the blank value rather than escaping it — escaping proves
    // nothing about whether blank was ACCEPTED, only that Escape cancels
    // (already covered below). Reaching the pre-flight modal is the proof
    // that a blank idle-days value passed validation.
    await days.confirm();
    await (await waitForModal()).pushButton("Cancel");
  });

  // The behaviour the unit tests pin, proven here against a real input box:
  // Escape is not the same answer as an empty string.
  it("sends nothing when the idle-days prompt is escaped", async () => {
    await runCommand("Nimbus: Is this idle?");
    const ref = await InputBox.create();
    await ref.setText("svc/legacy");
    await ref.confirm();
    const days = await InputBox.create();
    await days.cancel();
    await sendSentinel();
    expect(gateRelevantMethods()).to.deep.equal(["agents.ghost"]);
  });

  it("cancels preflight when the namespace is left empty", async () => {
    await runCommand("Nimbus: Safe to deploy?");
    const ref = await InputBox.create();
    await ref.setText("release-1.4");
    await ref.confirm();
    const ns = await InputBox.create();
    await ns.setText("");
    await ns.confirm();
    await sendSentinel();
    expect(gateRelevantMethods()).to.deep.equal(["agents.ghost"]);
  });
});
