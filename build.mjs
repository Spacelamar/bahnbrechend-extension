import { build, context } from "esbuild";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "fs";

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

  // Copy static files to dist (Chrome variant — service_worker).
  // The on-disk manifest.json is the production Web-Store version
  // (no localhost). For the local-dev unpacked load we inject the
  // localhost match the same way we do for dist-firefox/, so the
  // content script also fires on http://localhost:3000 in Chrome
  // when the user is running `next dev`.
  const chromeManifest = JSON.parse(readFileSync("manifest.json", "utf8"));
  chromeManifest.host_permissions ||= [];
  if (!chromeManifest.host_permissions.includes("*://localhost/*")) {
    chromeManifest.host_permissions.push("*://localhost/*");
  }
  if (chromeManifest.content_scripts?.[0]?.matches) {
    if (!chromeManifest.content_scripts[0].matches.includes("*://localhost/*")) {
      chromeManifest.content_scripts[0].matches.push("*://localhost/*");
    }
  }
  writeFileSync("dist/manifest.json", JSON.stringify(chromeManifest, null, 2));
  cpSync("rules.json", "dist/rules.json");
  cpSync("icons", "dist/icons", { recursive: true });

  // Mirror everything to dist-firefox/ with the Firefox manifest swapped in
  // (Firefox MV3 needs `background.scripts` instead of `service_worker`).
  // Lets you load-temporary in about:debugging without manual fiddling.
  mkdirSync("dist-firefox", { recursive: true });
  cpSync("dist/background.js", "dist-firefox/background.js");
  cpSync("dist/content.js", "dist-firefox/content.js");
  if (!isProd) {
    cpSync("dist/background.js.map", "dist-firefox/background.js.map");
    cpSync("dist/content.js.map", "dist-firefox/content.js.map");
  }
  // For local dev (`dist-firefox/`) we ALSO swap the gecko.id to a
  // separate dev-only ID. The production extension on AMO uses
  // `extension@bahnbrechend.net`. If a copy of that ID is already in
  // the user's profile (AMO install, ghost entry from a prior temp
  // load, corrupted profile), loading the temp dev add-on with the
  // same ID triggers `addons.xpi WARN already installed, older
  // version will be disabled` — content_scripts then silently fail
  // to inject. Using a distinct dev ID avoids the collision.
  const ffManifest = JSON.parse(readFileSync("manifest.firefox.json", "utf8"));
  if (ffManifest.browser_specific_settings?.gecko) {
    ffManifest.browser_specific_settings.gecko.id = "bahnbrechend-dev@bahnbrechend.net";
  }
  // Inject localhost into dev-only manifest so the temp add-on can
  // talk to the local Next.js dev server. The production
  // manifest.firefox.json (uploaded to AMO) deliberately omits these
  // — AMO reviewers reject extensions whose manifest grants permissions
  // to localhost without a clear justification.
  ffManifest.host_permissions ||= [];
  if (!ffManifest.host_permissions.includes("*://localhost/*")) {
    ffManifest.host_permissions.push("*://localhost/*");
  }
  if (ffManifest.content_scripts?.[0]?.matches) {
    if (!ffManifest.content_scripts[0].matches.includes("*://localhost/*")) {
      ffManifest.content_scripts[0].matches.push("*://localhost/*");
    }
  }
  writeFileSync("dist-firefox/manifest.json", JSON.stringify(ffManifest, null, 2));
  cpSync("rules.json", "dist-firefox/rules.json");
  cpSync("icons", "dist-firefox/icons", { recursive: true });

  console.log(isProd ? "Production build done." : "Dev build done.");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
