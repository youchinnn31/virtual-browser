// build.server.mjs
import * as esbuild from "esbuild";

await esbuild.build({
  entryPoints: ["src/server/index.ts"],
  bundle: true,
  minify: false,
  platform: "node",
  target: ["node20"],
  outdir: "dist/server",
  packages: "external",
});
