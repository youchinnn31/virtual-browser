import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.dirname(fileURLToPath(import.meta.url));
const output = path.join(root, "dist/evaluation");
await build({
  entryPoints: [path.join(root, "src/evaluation/index.ts")],
  bundle: true,
  platform: "node",
  target: ["node20"],
  packages: "external",
  outfile: path.join(output, "server/index.js"),
});
await fs.copyFile(path.join(root, "lcp.js"), path.join(output, "lcp.js"));
let sourceCommit = null;
let sourceDirty = null;
try {
  sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  sourceDirty =
    execFileSync("git", ["status", "--porcelain"], {
      cwd: root,
      encoding: "utf8",
    }).trim() !== "";
} catch {
  // A source archive may not contain Git metadata.
}
await fs.writeFile(
  path.join(output, "build-info.json"),
  JSON.stringify(
    { sourceCommit, sourceDirty, builtAt: new Date().toISOString() },
    null,
    2,
  ),
);
