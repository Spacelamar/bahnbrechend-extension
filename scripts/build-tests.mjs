import { build } from "esbuild";
import { mkdirSync, rmSync } from "node:fs";

rmSync("dist-tests", { recursive: true, force: true });
mkdirSync("dist-tests", { recursive: true });

await build({
  bundle: true,
  entryPoints: ["test/bahn-api.test.ts"],
  format: "esm",
  loader: { ".json": "json" },
  outfile: "dist-tests/bahn-api.test.js",
  platform: "node",
  sourcemap: true,
  target: "node22",
});
