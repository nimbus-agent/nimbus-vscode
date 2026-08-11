import { expect } from "chai";
import { EditorView, InputBox, VSBrowser, Workbench } from "vscode-extension-tester";

import { fake } from "../helpers/gateway.js";

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

describe("briefs that never send", () => {
  before(async () => {
    await VSBrowser.instance.waitForWorkbench();
    await VSBrowser.instance.openResources("test/ui/fixture-workspace/src/session.ts");
  });

  // Reset AFTER each case, not before: a failing test leaves the fake's state
  // intact for inspection, and a queued error can never leak into a later case.
  afterEach(() => {
    fake().reset();
  });

  after(async () => {
    await new EditorView().closeAllEditors();
  });

  it("prefills the janitor prompt with the active file's relative ref", async () => {
    await runCommand("Nimbus: Is this idle?");
    const input = await InputBox.create();
    expect(await input.getText()).to.equal("src/session.ts");
    await input.cancel();
    expect(fake().requests()).to.deep.equal([]);
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
    expect(fake().requests()).to.deep.equal([]);
  });

  it("accepts a blank idle-days value", async () => {
    await runCommand("Nimbus: Is this idle?");
    const ref = await InputBox.create();
    await ref.setText("svc/legacy");
    await ref.confirm();
    const days = await InputBox.create();
    expect(await days.getMessage()).to.not.contain("whole number");
    await days.cancel();
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
    expect(fake().requests()).to.deep.equal([]);
  });

  it("cancels preflight when the namespace is left empty", async () => {
    await runCommand("Nimbus: Safe to deploy?");
    const ref = await InputBox.create();
    await ref.setText("release-1.4");
    await ref.confirm();
    const ns = await InputBox.create();
    await ns.setText("");
    await ns.confirm();
    expect(fake().requests()).to.deep.equal([]);
  });
});
