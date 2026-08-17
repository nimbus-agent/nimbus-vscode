import { ModalDialog, VSBrowser } from "vscode-extension-tester";

// ModalDialog's getters do a single findElement with no built-in wait, so
// asking for one the instant executeCommand() resolves is a race: the gate's
// showWarningMessage call still has to cross the extension host and render.
// Poll via the page object's own API (getMessage) rather than a raw selector,
// so this cannot pass on a dialog that never appears — it only absorbs the
// render delay of one that does.
//
// Shared by every spec that drives the pre-flight gate — briefs-gated,
// briefs-no-send and context-panel — so the polling behaviour cannot drift
// between copies.
export async function waitForModal(): Promise<ModalDialog> {
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
