# Design & Plan Review: Ambient Context Panel — PR 2

This document contains a structured review, suggestions, improvements, and open questions for the [2026-08-16-ambient-context-panel-pr2.md](2026-08-16-ambient-context-panel-pr2.md) implementation plan.

---

## 1. Open Questions & Performance Concerns

### A. In-Flight Collector Failures Leave UI in Permanent "Loading..." State
* **The Issue:** In Task 5's `runOne` inside `controller.ts`, if a collector's promise fails/rejects:
  ```ts
  try {
    const section = await pending;
    if (key !== undefined) remember(spec.id, key, section);
    if (mine !== generation) return;
    deps.post({ type: "section", generation: mine, section });
  } catch (e: unknown) {
    deps.log.warn(`context signal ${spec.id} failed: ${errMsg(e)}`);
  }
  ```
  If an exception is thrown, the catch block logs a warning, but **never posts to the webview**. This leaves the affected section showing "Loading…" indefinitely.
  While `blameSection` and `relatedSection` attempt to catch errors internally, any unexpected error thrown outside their internal `try-catch` blocks (or a failing collector for a future signal that doesn't handle all errors internally) will cause the UI to hang.
* **Suggestion:** Post a fallback error section in the `catch` block of `runOne` if the generation is still current:
  ```ts
  } catch (e: unknown) {
    deps.log.warn(`context signal ${spec.id} failed: ${errMsg(e)}`);
    if (mine === generation) {
      deps.post({
        type: "section",
        generation: mine,
        section: {
          id: spec.id,
          title: titleOf(spec.id),
          rows: [{ label: `Error: ${errMsg(e)}`, iconId: "error" }],
        },
      });
    }
  }
  ```

### B. Panel UI Lags Behind Connection Status Change to Disconnected
* **The Issue:** In Task 5's `onState` connection state listener:
  ```ts
  const sub = deps.connection.onState((state) => {
    if (state.kind !== "connected") {
      // The index may change while we are away, so nothing cached survives.
      caches.clear();
      return;
    }
    // The symmetric half...
  ```
  When the connection drops, the caches are cleared, but `collect()` is not run. The UI will continue displaying the old, stale signal results until the user moves the cursor or triggers another editor event.
* **Suggestion:** Call `collect` (with `lastSnapshot`) when transitioning to a disconnected state as well, so that Gateway-dependent sections immediately update to show "Needs the Nimbus Gateway.":
  ```ts
    if (state.kind !== "connected") {
      caches.clear();
      const snapshot = lastSnapshot;
      if (snapshot !== undefined && deps.isVisible()) {
        void collect(snapshot).catch((e: unknown) =>
          deps.log.warn(`context clear after disconnect failed: ${errMsg(e)}`),
        );
      }
      return;
    }
  ```

---

## 2. Integration & SCM Suggestions

### A. Dynamic Repository Registration
* **Review of Task 8 Step 3:** The git listener registers on `api?.repositories()` when the git promise resolves.
* **Consideration:** If repositories are opened or closed dynamically after activation (e.g. if the user adds a workspace folder), these won't have change listeners registered.
* **Suggestion:** While this workspace might have a static layout, we could note that a fully robust SCM integration might need to listen to `api.onDidOpenRepository` and `api.onDidCloseRepository` to dynamically add/remove SCM listeners, or we can handle that in PR 3.
