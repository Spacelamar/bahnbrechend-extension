import { build, context } from "esbuild";
import { cpSync, mkdirSync } from "fs";

const isProd = process.env.NODE_ENV === "production";
const isWatch = process.argv.includes("--watch");

const common = {
  bundle: true,
  format: "esm",
  target: "chrome120",
  sourcemap: !isProd,
  minify: isProd,
  loader: { ".json": "json" },
};

async function run() {
  // Ensure dist exists
  mkdirSync("dist", { recursive: true });

  // Background service worker — single bundle with all scan logic
  const bgConfig = {
    ...common,
    entryPoints: ["src/background/background.ts"],
    outfile: "dist/background.js",
  };

  // Content script — lightweight bridge (must be IIFE, not ESM)
  const csConfig = {
    ...common,
    entryPoints: ["src/content/content.ts"],
    outfile: "dist/content.js",
    format: "iife",
  };

  if (isWatch) {
    const bgCtx = await context(bgConfig);
    const csCtx = await context(csConfig);
    await bgCtx.watch();
    await csCtx.watch();
    console.log("Watching for changes...");
  } else {
    await build(bgConfig);
    await build(csConfig);
    console.log("Build complete.");
  }

  // Copy static files to dist
  cpSync("manifest.json", "dist/manifest.json");
  cpSync("rules.json", "dist/rules.json");
  cpSync("icons", "dist/icons", { recursive: true });

  console.log(isProd ? "Production build done." : "Dev build done.");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
