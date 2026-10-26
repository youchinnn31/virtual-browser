// build.client.mjs
import * as esbuild from "esbuild";

await esbuild.build({
  entryPoints: ["src/client/index.ts", "src/client/tablet-evaluation.ts"],
  bundle: true,
  minify: true,
  outdir: "dist/client",
});
