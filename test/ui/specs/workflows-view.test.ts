import { expect } from "chai";
import {
  ActivityBar,
  type CustomTreeItem,
  CustomTreeSection,
  EditorView,
  ModalDialog,
  VSBrowser,
} from "vscode-extension-tester";

import { NIGHTLY_TRIAGE, RELEASE_CHECKLIST } from "../fixtures/workflows.js";
import { fake } from "../helpers/gateway.js";

// Check 1: the Workflows view's context menu actually RENDERS.
//
// test/unit/manifest-workflows.test.ts already pins package.json's
// `viewItem == nimbus.workflow` clause to WORKFLOW_CONTEXT_VALUE, but a menu
// that silently never renders would still pass that test — the two strings
// would match and no menu would exist. Only a real workbench can tell the
// difference, so every assertion here is against a menu VS Code actually drew.

const SECTION = "Workflows";

async function openWorkflowsSection(): Promise<CustomTreeSection> {
  const control = await new ActivityBar().getViewControl("Nimbus");
  if (control === undefined) throw new Error("no Nimbus control in the activity bar");
  const view = await control.openView();
  const section = await view.getContent().getSection<CustomTreeSection>(SECTION, CustomTreeSection);
  await section.expand();
  return section;
}

// The view's rows arrive over the socket (workflow.list), so they are not
// there the instant the section opens. Poll through the page object's own
// findItem — a row that never appears fails with driver.wait's TimeoutError
// rather than sliding through as `undefined`.
async function waitForRow(section: CustomTreeSection, label: string): Promise<CustomTreeItem> {
  let found: CustomTreeItem | undefined;
  await VSBrowser.instance.driver.wait(
    async () => {
      try {
        found = (await section.findItem(label)) as CustomTreeItem | undefined;
      } catch {
        return false;
      }
      return found !== undefined;
    },
    20000,
    `no "${label}" row appeared in the Workflows view`,
  );
  if (found === undefined) throw new Error(`no "${label}" row appeared in the Workflows view`);
  return found;
}

// Reports what the fake saw on timeout: "no modal appeared" is ambiguous
// between a command that never fired and one that fired and failed, and the
// wire is what tells those apart. driver.wait's message is typed `string`, so
// it cannot carry state read at the moment of the timeout — hence the poll.
async function waitForModal(timeoutMs = 10000): Promise<ModalDialog> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const candidate = new ModalDialog();
    try {
      await candidate.getMessage();
      return candidate;
    } catch {
      // not rendered yet.
    }
    if (Date.now() > deadline) {
      const methods = fake()
        .requests()
        .map((r) => r.method);
      throw new Error(`no pre-flight modal appeared; the fake saw ${JSON.stringify(methods)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

describe("the Workflows view", () => {
  before(async () => {
    await VSBrowser.instance.waitForWorkbench();
  });

  afterEach(async () => {
    fake().reset();
    // A case that fails between opening a menu or modal and dismissing it
    // would otherwise leave it over the workbench for every later case —
    // including, with .mocharc.ui.js's retries: 2, this case's own retries.
    try {
      const dialog = new ModalDialog();
      await dialog.getMessage();
      await dialog.pushButton("Cancel");
    } catch {
      // no modal open — the common case.
    }
    await new EditorView().closeAllEditors();
  });

  it("lists the saved workflows the Gateway returned", async () => {
    const section = await openWorkflowsSection();
    await waitForRow(section, NIGHTLY_TRIAGE.name);
    const labels = await Promise.all((await section.getVisibleItems()).map((i) => i.getLabel()));
    expect(labels).to.include(NIGHTLY_TRIAGE.name);
    expect(labels).to.include(RELEASE_CHECKLIST.name);
  });

  // Runs load on expand (createDataView's loadChildren), keyed by the row's
  // payload. The fixture gives release-checklist no history at all, so this
  // fails if the view ever fetched by anything other than that row's name.
  it("loads each workflow's own runs on expand", async () => {
    const section = await openWorkflowsSection();
    const nightly = await waitForRow(section, NIGHTLY_TRIAGE.name);
    expect(await nightly.isExpandable()).to.equal(true);
    const runs = await nightly.getChildren();
    expect(runs.length).to.equal(2);
    await nightly.collapse();

    const release = await waitForRow(section, RELEASE_CHECKLIST.name);
    const noRuns = await release.getChildren();
    expect(await Promise.all(noRuns.map((r) => r.getLabel()))).to.deep.equal(["Never run"]);
    await release.collapse();
  });

  // THE check: a rendered context menu, on a real row, in a real window.
  it("offers Dry-Run Workflow in a workflow row's context menu", async () => {
    const section = await openWorkflowsSection();
    const row = await waitForRow(section, NIGHTLY_TRIAGE.name);
    const menu = await row.openContextMenu();
    const labels = await Promise.all((await menu.getItems()).map((i) => i.getLabel()));
    await menu.close();
    // `includes` rather than equality: VS Code owns the exact rendering (a
    // category prefix, a trailing keybinding hint). The command's title is the
    // load-bearing part, and a menu that never rendered has no items at all.
    expect(
      labels.some((l) => l.includes("Dry-Run Workflow")),
      `context menu items were ${JSON.stringify(labels)}`,
    ).to.equal(true);
  });

  // nimbus.runWorkflow is contributed with "group": "inline", so it renders as
  // a hover action on the row rather than as a context-menu entry — a different
  // rendering path from the one above, and one this suite can only claim if
  // ExTester can actually see it.
  it("offers Run Workflow as an inline action on the row", async () => {
    const section = await openWorkflowsSection();
    const row = await waitForRow(section, NIGHTLY_TRIAGE.name);
    const labels = await Promise.all((await row.getActionButtons()).map((a) => a.getLabel()));
    expect(
      labels.some((l) => l.includes("Run Workflow")),
      `inline actions were ${JSON.stringify(labels)}`,
    ).to.equal(true);
  });

  // The menu entry existing is not the same as it being wired to the row. A
  // Dry-Run driven from the row must pre-flight THAT workflow with no picker
  // in between — the payload path (SidebarItem.payload → workflowTargetFrom).
  it("dry-runs the row it was opened on, with no picker in between", async () => {
    const section = await openWorkflowsSection();
    const row = await waitForRow(section, RELEASE_CHECKLIST.name);
    const menu = await row.openContextMenu();
    // Matched with `includes` and selected through the item itself, rather
    // than Menu.select()'s exact-label lookup: the assertion above already
    // establishes that the exact rendering is VS Code's business.
    const items = await menu.getItems();
    const labels = await Promise.all(items.map((i) => i.getLabel()));
    const index = labels.findIndex((l) => l.includes("Dry-Run Workflow"));
    expect(index, `context menu items were ${JSON.stringify(labels)}`).to.be.greaterThan(-1);
    const entry = items[index];
    if (entry === undefined) throw new Error("no Dry-Run Workflow item in the context menu");
    // Moved-to and clicked rather than ContextMenuItem.select()'s bare
    // element click: with the bare click the menu closed and the command was
    // never dispatched (the fake recorded nothing at all), three attempts
    // running. VS Code's menu items react to a real mouse sequence over the
    // item, which is what this performs — still on the page object's own
    // element, not a hand-written selector.
    await VSBrowser.instance.driver.actions().move({ origin: entry }).click().perform();
    const dialog = await waitForModal();
    expect(await dialog.getDetails()).to.contain(`Dry-run workflow ${RELEASE_CHECKLIST.name}`);
    await dialog.pushButton("Cancel");
  });
});
