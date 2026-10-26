import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";
import { build } from "esbuild";
import ExcelJS from "exceljs";

test("tablet results persist warmup separately and export partial runs without a median", async () => {
  await build({
    entryPoints: ["src/server/evaluation/store.ts"],
    outfile: "dist/test/store.cjs",
    bundle: true,
    platform: "node",
    packages: "external",
  });
  const { RunStore } = createRequire(import.meta.url)("../dist/test/store.cjs");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "tablet-store-"));
  const store = await RunStore.create(root, {
    urls: ["https://example.org/"],
    speeds: [1024],
    speedMode: "external-unverified",
    navigationWaitUntil: "load",
    device: {
      name: "test",
      userAgent: "Real Tablet",
      width: 800,
      height: 500,
      dpr: 2,
      orientation: "landscape",
    },
  });
  try {
    const condition = await store.condition("https://example.org/", 1024);
    for (let access = 0; access < 3; access++) {
      const id = `trial-${access}`;
      await store.beginTrial(id, condition.id, access);
      await store.sample(
        id,
        condition.id,
        access,
        {
          trial: access,
          access: access + 1,
          lcp: access ? 1200 : 8000,
          renderKind: "lcp",
          firstXpath: 'id("hero")',
          finalUrl: "https://example.org/",
          lcpImages: 1,
          candidates: [],
        },
        { candidates: 1 },
      );
    }
    await store.finishCondition(condition.id, "stopped");
    await store.log("external-speed", { speed: 1024, verified: false });
    const output = await store.export("stopped");
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(output);
    assert.equal(workbook.getWorksheet("中央値").getCell("C2").value, null);
    assert.equal(workbook.getWorksheet("中央値").getCell("I2").value, 8000);
    assert.equal(workbook.getWorksheet("測定値").rowCount, 3);
    assert.ok(workbook.getWorksheet("速度設定"));
    assert.ok(
      workbook
        .getWorksheet("測定条件")
        .getRows(1, 40)
        .some(
          (row) =>
            row.getCell(1).value === "撮影開始の待機条件" &&
            row.getCell(2).value === "load",
        ),
    );
    assert.ok(
      (await fs.stat(path.join(store.directory, "results.db"))).size > 0,
    );
    assert.ok(
      workbook
        .getWorksheet("測定条件")
        .getRows(1, 40)
        .some((row) => row.getCell(2).value === "Real Tablet"),
    );
  } finally {
    await store.close();
  }
});
