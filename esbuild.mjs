import { copyFileSync } from "node:fs";
import { build, context } from "esbuild";

const isWatch = process.argv.includes("--watch");
// Production = anything that's not an explicit dev/watch invocation.
// ci.yml and publish.yml leave NODE_ENV unset → minified, no sourcemaps.
// Local `bun run build --watch` → unminified + sourcemaps for debugging.
const isDev = isWatch || process.env.NODE_ENV === "development";

// A webview bundle: a browser IIFE exposing `globalName`. Always minified,
// unlike the extension host bundle — it ships in the .vsix and is reloaded on
// every panel open.
const webviewBundle = (globalName, entryPoint, outfile) => ({
  bundle: true,
  platform: "browser",
  target: "es2022",
  format: "iife",
  globalName,
  sourcemap: isDev,
  minify: true,
  treeShaking: true,
  entryPoints: [entryPoint],
  outfile,
  logLevel: "info",
});

// Every bundle the extension ships, each defined ONCE for both build and watch.
// A new bundle is one entry here — plus its outfile in scripts/clean.mjs and,
// if it must ship, in the `missing` list of scripts/check-vsix-contents.mjs.
const bundles = [
  {
    bundle: true,
    platform: "node",
    target: "node18",
    format: "cjs",
    sourcemap: isDev,
    minify: !isDev,
    external: ["vscode"],
    logLevel: "info",
    entryPoints: ["src/extension.ts"],
    outfile: "dist/extension.js",
  },
  webviewBundle("NimbusWebview", "src/chat/webview/main.ts", "media/webview.js"),
  webviewBundle("NimbusContextView", "src/context/webview/main.ts", "media/context.js"),
];

if (isWatch) {
  // Every context is created before any of them starts watching.
  const contexts = [];
  for (const options of bundles) contexts.push(await context(options));
  for (const ctx of contexts) await ctx.watch();
} else {
  for (const options of bundles) await build(options);
}

copyFileSync("src/chat/webview/styles.css", "media/webview.css");
copyFileSync("src/context/webview/styles.css", "media/context.css");

process.stdout.write(`esbuild: bundles produced (minify=${!isDev}, sourcemaps=${isDev})\n`);
