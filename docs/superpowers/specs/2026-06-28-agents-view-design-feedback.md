# Feedback on Agents View Design Specification

**Review Date:** 2026-06-28  
**Feedback Target:** [2026-06-28-agents-view-design.md](file:///C:/gitrep/nimbus-vscode/docs/superpowers/specs/2026-06-28-agents-view-design.md)

---

## 1. Sticky `activeAgent` Lifetime & Reset Flow
* **Observation:** Reverting the active agent back to the `nimbus.askAgent` default is listed as a non-goal for v1. However, once `activeAgent` is set to a specific agent's ID, it overrides `settings.askAgent()` indefinitely.
* **Open Questions / Suggestions:**
  * **Resetting on New Conversation:** If a user clicks the standard "New Conversation" button inside the chat panel UI, does it reset the active agent to the default (`undefined` / `settings.askAgent()`)? Or does the new conversation remain pinned to the last clicked agent? We suggest resetting to default when a generic new conversation is started via the chat panel header.
  * **Resetting on Switch:** Is there any way for the user to return to the default agent? We suggest that if they click the already-active agent a second time, or if we provide a clear/reset action, it clears the override.

## 2. Visual Indicator for the Active Agent
* **Observation:** The design suggests rendering configured agents as sidebar rows, but does not specify showing which agent is currently active/selected.
* **Suggestion:** We should provide clear visual feedback in the TreeView so the user knows which agent is active:
  * We can append ` (active)` to the description of the active agent, or use a specific codicon (e.g., `"check"` or a colored dot/badge) when rendering the active row.
  * To support this, `activeAgent` updates should trigger a refresh of the agents TreeView: `agentsView.refresh()`.

## 3. Customizable Icons per Agent
* **Observation:** The design hardcodes the icon for all agents to `"hubot"`.
* **Suggestion:** Adding a lightweight optional `icon` field to the setting schema would allow users to visually distinguish their agents:
  ```jsonc
  { 
    "id": "researcher", 
    "label": "Researcher", 
    "icon": "search" // Resolves to codicon id
  }
  ```
  If `icon` is provided and is a valid codicon name, we use it; otherwise, we fall back to `"hubot"`.

## 4. Built-in Agents Discovery
* **Observation:** The setting reads from local user configuration. If `nimbus.agents` is empty, it displays `"No agents configured"`.
* **Question:** Does the Gateway or Nimbus client have standard built-in/system agents? If so, should we pre-populate the view with those system agents (e.g., using a fallback default list if the user hasn't configured anything) so that the sidebar view isn't empty out-of-the-box?

## 5. Command Palette Visibility
* **Observation:** `nimbus.openAgentChat` is registered as a command.
* **Suggestion:** Since this command requires an `agent` payload to function and is meant to be clicked from the TreeView, we should ensure it does not pollute the VS Code Command Palette. We can configure this in `package.json` by adding a menu constraint:
  ```json
  "menus": {
    "commandPalette": [
      {
        "command": "nimbus.openAgentChat",
        "when": "false"
      }
    ]
  }
  ```

## 6. Verification of the Chat Reveal Mechanism
* **Observation:** The design mentions: *"...confirm during planning how an already-created chat panel is revealed; reuse that mechanism..."*
* **Confirmation:** We should explicitly verify that calling `ensureChatController()` and triggering `newConversation()` triggers the webview panel visibility. Typically, this requires calling `show()` or `reveal()` on the webview panel wrapper in the extension code.
