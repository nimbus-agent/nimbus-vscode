# Review and Feedback: Dev-workflow trio — Design

**Date of Review:** 2026-07-20  
**Spec Reviewed:** [2026-07-20-dev-workflow-trio-design.md](2026-07-20-dev-workflow-trio-design.md)

---

## 1. Critical Suggestions & Improvements

### A. "Generate Docstrings" Output UX: Diff View vs. Read-only Tab
* **Current Design:** Docstring generation returns the code rewritten with doc comments in a read-only tab (`Nimbus docstrings.md`) for the user to copy or manually diff.
* **Critique:** Copy-pasting modified code block by block from a read-only markdown tab is highly tedious and error-prone.
* **Recommendation:** 
  * Instead of a static read-only markdown view, open a side-by-side diff editor using VS Code's native `vscode.diff` command. 
  * Compare the original active document (left) with a temporary/untitled document containing the rewritten/annotated file (right). This lets the user see exactly what docstrings were added/modified and easily merge changes using standard editor controls.

### B. Review Changes: Staged vs. Unstaged vs. Untracked
* **Current Design:** "Review my changes" reads only unstaged working-tree changes via `repo.diff(false)`. Untracked files are excluded entirely.
* **Critique:** Developers often want to review their entire set of local changes (both staged and unstaged) before committing. Furthermore, excluding untracked files without notice can lead users to falsely assume a new file they just wrote has been reviewed.
* **Recommendation:**
  * Clearly notify the user in the findings header if there are staged changes or untracked files that were *not* included in the review.
  * Consider supporting a setting (e.g., `nimbus.scm.reviewScope`) or prompting when both staged and unstaged changes exist, to let the user review "all local changes", "staged only", or "unstaged only".

### C. Diff Truncation Strategy
* **Current Design:** If a single file's diff exceeds the 50,000-character budget, the fallback is to truncate the file to the budget with a `(truncated)` marker.
* **Critique:** A raw character-based truncation mid-line or mid-hunk will yield malformed diff syntax, leading the agent to generate lower-quality/hallucinated findings.
* **Recommendation:** The parsing logic in `diff.ts` should truncate at the last complete *hunk boundary* (`@@ ... @@` header) that fits the budget, rather than a raw character slice. This preserves diff validity and syntax.

---

## 2. Open Questions & Points for Clarification

### Q1. Test File Location and Directory Structures
* **Context:** The spec mentions test generation outputting to a named untitled buffer beside the source file (e.g., `src/foo.ts` -> `src/foo.test.ts`).
* **Question:** How do we handle codebases that enforce a strict separation of source and test directories (e.g., `src/` vs `test/` or `tests/`)? Should there be basic heuristics or settings (e.g., mapping `src/utils/helpers.ts` to `test/utils/helpers.test.ts`) to respect directory structure patterns?

### Q2. Handling Multi-Repository Context Shifts
* **Context:** In multi-repo workspaces, the user is prompted to select a repository.
* **Question:** Since `agentInvoke` is a slow one-shot RPC and lacks cancelability in MVP, what happens if the user switches active repositories or closes the selected repository's folder while the invocation is running? Does the write back to the SCM input box handle this gracefully without writing to the wrong/newly-focused repository?

### Q3. Style Examples Cleanliness in `repo.log`
* **Context:** Commit message generation feeds the last ~10 subject lines to the agent to learn the repo's style.
* **Question:** Do we filter out merge commits (e.g., `Merge branch...` or `Merge pull request...`) and automated bot commits (e.g., `chore(release): ...` or Greenkeeper/Dependabot updates)? Raw logs frequently contain these, which might pollute or overwrite the user's actual desired manual commit style.
