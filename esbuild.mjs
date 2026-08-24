import { copyFileSync } from "node:fs";
import { build, context } from "esbuild";

const isWatch = process.argv.includes("--watch");
// Production = anything that's not an explicit dev/watch invocation.
// ci.yml and publish.yml leave NODE_ENV unset → minified, no sourcemaps.
// Local `bun run build --watch` → unminified + sourcemaps for debugging.
const isDev = isWatch || process.env.NODE_ENV === "development";

const baseExt = {
  bundle: true,
  platform: "node",
  target: "node18",
  format: "cjs",
  sourcemap: isDev,
  minify: !isDev,
  external: ["vscode"],
  logLevel: "info",
};

if (isWatch) {
  const extCtx = await context({
    ...baseExt,
    entryPoints: ["src/extension.ts"],
    outfile: "dist/extension.js",
  });
  const webCtx = await context({
    bundle: true,
    platform: "browser",
    target: "es2022",
    format: "iife",
    globalName: "NimbusWebview",
    sourcemap: isDev,
    // Always minify the Webview bundle — it ships in the .vsix and reloads on
    // every panel open. ~16 KB marked + ~5 KB our code → ~8 KB minified.
    minify: true,
    treeShaking: true,
    entryPoints: ["src/chat/webview/main.ts"],
    outfile: "media/webview.js",
    logLevel: "info",
  });
  const ctxCtx = await context({
    bundle: true,
    platform: "browser",
    target: "es2022",
    format: "iife",
    globalName: "NimbusContextView",
    sourcemap: isDev,
    minify: true,
    treeShaking: true,
    entryPoints: ["src/context/webview/main.ts"],
    outfile: "media/context.js",
    logLevel: "info",
  });
  await extCtx.watch();
  await webCtx.watch();
  await ctxCtx.watch();
} else {
  await build({
    ...baseExt,
    entryPoints: ["src/extension.ts"],
    outfile: "dist/extension.js",
  });

  await build({
    bundle: true,
    platform: "browser",
    target: "es2022",
    format: "iife",
    globalName: "NimbusWebview",
    sourcemap: isDev,
    // Always minify the Webview bundle — it ships in the .vsix and reloads on
    // every panel open. ~16 KB marked + ~5 KB our code → ~8 KB minified.
    minify: true,
    treeShaking: true,
    entryPoints: ["src/chat/webview/main.ts"],
    outfile: "media/webview.js",
    logLevel: "info",
  });

  await build({
    bundle: true,
    platform: "browser",
    target: "es2022",
    format: "iife",
    globalName: "NimbusContextView",
    sourcemap: isDev,
    minify: true,
    treeShaking: true,
    entryPoints: ["src/context/webview/main.ts"],
    outfile: "media/context.js",
    logLevel: "info",
  });
}

copyFileSync("src/chat/webview/styles.css", "media/webview.css");
copyFileSync("src/context/webview/styles.css", "media/context.css");

process.stdout.write(`esbuild: bundles produced (minify=${!isDev}, sourcemaps=${isDev})\n`);
