# Review & Suggestions: 2026-08-10-built-in-briefs-design.md

Here is a review of the design specification for built-in briefs, along with suggestions and open questions.

## 1. Open Questions & Design Decisions

### A. Egress / Gate Behavior for Briefs
- **File content in prompts:** The design states:
  > Without that `note`, a modal reading "send `src/auth/session.ts`" says *we are uploading your file*, which is false. The gate's credibility depends on it not overstating what leaves.
  
  Does the Gateway or the extension perform any local file reading *under the hood* that gets appended to the payload before it leaves the developer's machine? If the Gateway reads the file locally, does that local context eventually get serialized and sent to a remote model? If so, we should clarify if file *contents* or just file *metadata/paths* leave the local environment.

### B. Hover (`whyPeek`) Performance & Debounce Tuning
- **Debounce threshold:** Since a hover is triggered on every mouse-rest, a slow or missing local git index check could cause UI lag if not carefully tuned.
- **Cancellation token handling:** When the user moves the mouse away, we must ensure the `CancellationToken` immediately cancels the ongoing Git/index check (or the IPC call to `whyPeek`) to avoid pile-ups.

### C. Sidebar View Grouping & Discoverability
- **Configured Agents empty state:** The design mentions:
  > When `nimbus.agents` is empty the second group renders a single *Configure agents in settings…* row rather than vanishing, so the setting stays discoverable.
  
  Should we also include a direct action button or link next to the "Built-in briefs" or "Configured agents" section header in the tree view (e.g., a inline gear icon) to jump straight to the settings?

---

## 2. Improvements & Suggestions

### A. Namespace Auto-Detection for Preflight
- The design introduces `nimbus.briefs.defaultNamespace` because `agentsPreflight` requires `namespace`.
- **Suggestion:** Can we auto-detect or suggest the namespace based on:
  1. The active git branch name (often prefixed with team/namespace like `feature/billing-setup` -> `billing`).
  2. The package/module directory structure or `package.json` names.
  - If auto-detection fails, we can fall back to the prompt prefilled with `nimbus.briefs.defaultNamespace`.

### B. Error Handling vs. Actionable Retries
- When an `AgentBriefError` occurs, the design states:
  > Surface the Gateway's `detail` verbatim. Never flatten it into "something went wrong".
- **Suggestion:** Add specific guidance on **actionability**. For example, if a brief fails due to a missing git ref or uncommitted files, the error display in the read-only tab should offer a "Retry" button or quick links to fix the common pre-requisites.

### C. Hover Command Link Behavior
- The hover Blame UI includes `[Why? →]`. Clicking this runs the full `why` brief.
- **Suggestion:** Ensure the command link passes the correct parameters (`{ref, line}`) so the user does not get prompted again for the location context they just clicked from.
