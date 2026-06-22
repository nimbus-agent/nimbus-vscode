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
      exclude: ["src/**/*.d.ts", "src/vscode-shim.ts"],
      thresholds: {
        lines: 80,
        branches: 75,
      },
    },
  },
  resolve: {
    alias: {
      vscode: new URL("./test/unit/vscode-stub.ts", import.meta.url).pathname,
    },
  },
});
