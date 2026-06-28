# Feedback on Agents View Implementation Plan

**Review Date:** 2026-06-28  
**Feedback Target:** [2026-06-28-agents-view.md](file:///C:/gitrep/nimbus-vscode/docs/superpowers/plans/2026-06-28-agents-view.md)

---

## 1. Test Assertion Discrepancy (`iconId` vs `iconPath` / `iconPath` Mocking) (Task 4)
* **Observation:** 
  * In Task 1 (`agentsToRows`), the projected rows have the field `iconId: "hubot"`.
  * In Task 4 (`test/unit/extension.test.ts`), the test asserts:
    ```ts
    expect(rows[0]).toMatchObject({ label: "Researcher", iconPath: expect.anything() });
    ```
* **The Issue:**
  * If the sidebar tree provider or tree wrapper maps `iconId` to `iconPath` (e.g. using `ThemeIcon` wrappers), this match is correct.
  * However, if the mock `treeProviders` in the Vitest fixture doesn't perform this conversion automatically, the row returned will still contain `iconId` (or the raw `SidebarItem` layout) rather than `iconPath`, causing Task 4's test to fail.
* **Suggested Fix:**
  * Confirm whether `treeProviders.get("nimbus.agentsView").getChildren()` passes through the `applyThemeIcons` / `ThemeIcon` mapping in tests. If not, update the assertion to match `iconId: "hubot"` or mock the icon mapping in the test runner.

## 2. Reentrancy and Race Conditions on Double Clicks (Task 5)
* **Observation:**
  * In `nimbus.openAgentChat`, the command updates the `activeAgent` synchronously, then awaits `ctl.newConversation()`.
* **The Issue:**
  * Because `newConversation()` is asynchronous (it communicates with the chat controller and potentially updates state), if a user clicks an agent and then immediately clicks another agent (or double-clicks), two concurrent `newConversation()` operations will be executed.
  * Depending on the implementation of `ctl.newConversation()`, this could lead to duplicate conversations or race conditions where the final active agent state doesn't align with the state on the server.
* **Suggested Fix:**
  * While acceptable for a simple v1, we can add a check or keep the action synchronous where possible, or document this behavior. Alternatively, check if the panel is already loading/initializing a conversation to prevent duplicate runs.

## 3. Chat Reveal Safety / Factory Instance Availability (Task 5)
* **Observation:**
  * Task 5 implements `chatPanelFactory.current()?.reveal();`.
* **Open Question / Detail:**
  * If the chat webview panel hasn't been created yet (i.e. this is the first time the user is opening chat), does `ensureChatController()` automatically trigger creation and registration of the webview?
  * If `chatPanelFactory.current()` returns `undefined` before the webview is shown, calling `?.reveal()` won't do anything, leaving the panel hidden. We should verify if a method like `chatPanelFactory.createOrReveal()` exists and should be used instead to guarantee visibility.
