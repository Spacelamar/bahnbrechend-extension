// Build release ZIPs with forward-slash paths (Firefox AMO validator rejects
// backslashes produced by PowerShell's Compress-Archive). Run after build.mjs.

import JSZip from "jszip";
import { readFileSync, writeFileSync, readdirSync, statSync } from "fs";
import { join, relative } from "path";

function walk(root) {
  const out = [];
  function visit(p) {
    for (const name of readdirSync(p)) {
      const full = join(p, name);
      const st = statSync(full);
      if (st.isDirectory()) visit(full);
      else out.push(full);
    }
  }
  visit(root);
  return out;
}

async function makeZip(rootDir, outFile, overrides = {}) {
  const zip = new JSZip();
  for (const abs of walk(rootDir)) {
    const rel = relative(rootDir, abs).split("\\").join("/");
    // Skip Chrome-generated runtime metadata (appears after loading as unpacked)
    if (rel.startsWith("_metadata/")) continue;
    // Skip files being overridden; they'll be added below
    if (overrides[rel]) continue;
    zip.file(rel, readFileSync(abs));
  }
  for (const [rel, src] of Object.entries(overrides)) {
    zip.file(rel, readFileSync(src));
  }
  const buf = await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 9 },
  });
  writeFileSync(outFile, buf);
  const entries = Object.keys(zip.files).length;
  console.log(`  wrote ${outFile} (${entries} entries, ${(buf.length / 1024).toFixed(1)} KB)`);
}

async function main() {
  console.log("Chrome ZIP:");
  await makeZip("dist", "bahnbrechend-extension.zip");

  console.log("Firefox ZIP (manifest.json swapped for Firefox variant):");
  await makeZip("dist", "bahnbrechend-firefox.zip", {
    "manifest.json": "manifest.firefox.json",
  });

  console.log("Source ZIP (for Firefox review):");
  const srcZip = new JSZip();
  const srcDirs = ["src", "icons", "data"];
  const srcFiles = [
    "build.mjs",
    "pack.mjs",
    "manifest.json",
    "manifest.firefox.json",
    "package.json",
    "package-lock.json",
    "rules.json",
    "tsconfig.json",
  ];
  for (const d of srcDirs) {
    for (const abs of walk(d)) {
      const rel = relative(".", abs).split("\\").join("/");
      srcZip.file(rel, readFileSync(abs));
    }
  }
  for (const f of srcFiles) {
    srcZip.file(f, readFileSync(f));
  }
  const srcBuf = await srcZip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 9 },
  });
  writeFileSync("source-code.zip", srcBuf);
  console.log(`  wrote source-code.zip (${Object.keys(srcZip.files).length} entries, ${(srcBuf.length / 1024).toFixed(1)} KB)`);

  console.log("\nDone.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
