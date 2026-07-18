# Feedback on Release Automation Design Specification

**Review Date:** 2026-07-18  
**Feedback Target:** [2026-07-18-release-automation-design.md](file:///C:/gitrep/nimbus-vscode/docs/superpowers/specs/2026-07-18-release-automation-design.md)

---

## 1. PR Title Validation / Semantic PR Linting
* **Observation:** The design states that commit-message linting/enforcement is out of scope. While full local `commitlint` tooling may be overkill, Release Please relies heavily on conventional commit formats. When squash-merging (the standard workflow), GitHub defaults to using the PR title as the commit message on `main`. If a PR title does not follow Conventional Commits, the release notes and version bumps will fail to trigger or will be categorized incorrectly.
* **Suggestion:** We highly recommend adding a lightweight PR title validator workflow (such as `amannn/action-semantic-pull-request`) to check PR titles on pull request events. This is low effort (requires a simple ~15 line YAML file) and prevents invalid titles from landing on `main` and breaking Release Please.

## 2. Lockfile Updates & Bun Ecosystem
* **Observation:** The project uses `bun.lock` as its lockfile (and uses `bunx` in package scripts). Standard Release Please (`release-type: node`) automatically updates `package.json` and standard Node lockfiles (`package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`).
* **Open Questions / Suggestions:**
  * Does Release Please natively bump and update `bun.lock`? 
  * If it does not, when the human merges the Release Please PR, `bun.lock` will be out of sync with `package.json`.
  * **Mitigation:** We should check if we need to add a post-bump hook or script, or if we should verify `bun.lock` behavior during rollout. If needed, Release Please supports a `manifest` configuration option or plugins/scripts to update arbitrary files. Alternatively, standardizing or verifying Bun support in the release action config is recommended.

## 3. Branch Protection & PAT Permissions
* **Observation:** The fine-grained PAT is configured with `Contents: Read and write` and `Pull requests: Read and write`. 
* **Confirmation:** If `main` is protected (e.g., requires status checks or PR reviews), verify whether tag creation is blocked by tag protection rules, or if the repository allows the PAT-associated actor to bypass push restrictions for tags. Typically, tags do not inherit branch protection rules unless explicitly configured under "Tag protection rules", but it is worth verifying to ensure the tag creation step does not fail in production.

## 4. Bootstrapping SHA Verification
* **Suggestion:** To make the sequencing step foolproof for the release manager, document the exact command to find the correct `bootstrap-sha` for the config file after manual release of v0.4.0:
  ```bash
  git rev-parse v0.4.0
  ```
  Ensure this SHA is the actual merge/tag commit on the `main` branch.
