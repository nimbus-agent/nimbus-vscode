import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/unit/**/*.test.ts"],
    // Default environment is node; webview tests opt into jsdom via a
    // `// @vitest-environment jsdom` docblock (environmentMatchGlobs was
    // removed in vitest 4).
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["src/**/*.ts"],
      // vscode-shim + the vscode/node-IO glue factories are thin plumbing
      // exercised only via smoke tests; the extension injects fakes for them.
      exclude: [
        "src/**/*.d.ts",
        "src/vscode-shim.ts",
        "src/chat/real-chat-panel.ts",
        "src/connection/ping-socket.ts",
      ],
      // No hard thresholds here: coverage quality is enforced by SonarCloud's
      // "Sonar way" gate (80% on NEW code) via sonar.yml. `test:coverage` only
      // generates the lcov report that the Sonar scan consumes.
    },
  },
  resolve: {
    alias: {
      vscode: new URL("./test/unit/vscode-stub.ts", import.meta.url).pathname,
    },
  },
});
