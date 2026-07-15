# Feedback on Ranked Search Implementation Plan

**Review Date:** 2026-07-15  
**Feedback Target:** [2026-07-15-ranked-search.md](file:///C:/gitrep/nimbus-vscode/docs/superpowers/plans/2026-07-15-ranked-search.md)

---

## 1. Disposed QuickPick Property Mutation Bug (Task 2, Step 10)
* **Observation:**
  * `runQuery` is an asynchronous function that awaits `client.searchRanked(...)`.
  * If the user closes the Quick Pick (pressing `Esc`) or selects an item while a query is in-flight, `qp.dispose()` is executed in the `onDidHide` listener.
  * When the `searchRanked` promise resolves, the code attempts to set `qp.items = ...` and `qp.busy = false`.
* **The Issue:**
  * Setting properties or state on a disposed VS Code `QuickPick` object throws a runtime error.
* **Suggested Fix:**
  * Introduce a local `disposed` flag inside `runSearch` initialized to `false`.
  * Set `disposed = true` inside the `qp.onDidHide` listener.
  * Add a check at the beginning of the `runQuery` resolution path (both in `try` and `catch` blocks) to exit early if `disposed` is true:
    ```ts
    if (disposed || mine !== seq) return;
    ```

## 2. Missing `matchOnDescription` Setting (Task 2, Step 10)
* **Observation:**
  * In the design spec, matching on both description and detail is desired.
  * In Task 2 Step 10, the code initializes the Quick Pick but only sets `qp.matchOnDetail = true;`. It leaves out `qp.matchOnDescription`.
* **Suggested Fix:**
  * Explicitly set `qp.matchOnDescription = true;` during initialization to match the spec.

## 3. Typings for `timer` and Node vs. Browser `setTimeout`
* **Observation:**
  * The code declares: `let timer: ReturnType<typeof setTimeout> | undefined;`.
* **The Issue:**
  * In VS Code extension development, `setTimeout` can resolve to either the Node.js timeout signature (`NodeJS.Timeout`) or the DOM timeout signature (`number`), depending on the compiler's `lib` configuration and how `@types/node` is resolved. This can occasionally cause compiler mismatch errors with `clearTimeout`.
* **Suggested Fix:**
  * Ensure this is tested in the compilation check. If type issues arise, declaring it as `any` or explicitly casting `clearTimeout(timer as any)` can safeguard compile parity without changing runtime behavior.
