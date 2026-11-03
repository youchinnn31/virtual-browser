import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { test } from "node:test";
import { build } from "esbuild";

const output = path.resolve("dist/evaluation-tests/data.cjs");
await build({
  stdin: {
    contents:
      'export * from "./src/evaluation/protocol"; export * from "./src/evaluation/report"; export * from "./src/evaluation/store";',
    resolveDir: process.cwd(),
  },
  outfile: output,
  bundle: true,
  platform: "node",
  format: "cjs",
  packages: "external",
});
const { EvaluationStore, median, parseConfig, parseClientMessage } =
  createRequire(import.meta.url)(output);

test("configuration validates URLs, counts, deadlines, and numeric results", () => {
  const config = {
    urls: ["https://example.com/"],
    profiles: ["128kbps"],
    measurementCount: 5,
    trialTimeoutMs: 60000,
  };
  assert.deepEqual(parseConfig(config), config);
  for (const change of [
    { measurementCount: 0 },
    { urls: ["file:///tmp/a"] },
    { trialTimeoutMs: 0 },
    { profiles: [] },
  ]) {
    assert.throws(() => parseConfig({ ...config, ...change }));
  }
  assert.throws(() =>
    parseClientMessage({
      action: "trial:complete",
      trialId: "a",
      viewportMs: NaN,
      renderedCount: 1,
    }),
  );
  assert.equal(median([5, 1, 3]), 3);
  assert.equal(median([4, 1, 3, 2]), 2.5);
});

test("one run stores viewport measurements and excludes the warmup from complete and incomplete medians", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "evaluation-data-"));
  const config = {
    urls: ["https://example.com/"],
    profiles: ["128kbps", 'slow,"network"'],
    measurementCount: 5,
    trialTimeoutMs: 60000,
  };
  const store = await EvaluationStore.create(root, config, {
    width: 375,
    height: 500,
    devicePixelRatio: 2,
    userAgent: "test",
  });
  try {
    const first = await store.createEvaluation(
      config.urls[0],
      config.profiles[0],
      5,
    );
    const second = await store.createEvaluation(
      config.urls[0],
      config.profiles[1],
      5,
    );
    for (const evaluation of [first, second]) {
      for (let index = 0; index <= 5; index++) {
        const phase = index === 0 ? "warmup" : "measurement";
        const trialId = await store.beginTrial(
          evaluation.evaluationId,
          phase,
          index,
        );
        const failed = evaluation === second && index === 3;
        await store.finishTrial({
          trialId,
          evaluationId: evaluation.evaluationId,
          phase,
          measurementIndex: index,
          finalUrl: config.urls[0],
          status: failed ? "failed" : "success",
          viewportMs: failed ? null : index === 0 ? 99999 : index * 100,
          imageCount: 1,
          error: failed ? "trial_timeout" : null,
        });
      }
    }
    const complete = await store.summarize(first);
    assert.equal(complete.viewportMedianMs, 300);
    assert.equal(complete.successfulCount, 5);
    const incomplete = await store.summarize(second);
    assert.equal(incomplete.viewportMedianMs, null);
    assert.equal(incomplete.successfulCount, 4);
    assert.equal(incomplete.status, "incomplete");
    await store.finish("completed", null);
    const raw = await fs.readFile(
      path.join(store.directory, "measurements.csv"),
      "utf8",
    );
    const summary = await fs.readFile(
      path.join(store.directory, "summary.csv"),
      "utf8",
    );
    assert.equal(raw.trim().split("\r\n").length, 13);
    assert.match(raw, /trial_timeout/);
    assert.match(summary, /5,5,300,complete/);
    assert.match(summary, /5,4,,incomplete/);
    assert.match(summary, /"slow,""network"""/);
    assert.match(raw, /viewport/);
    assert.match(raw, /warmup,0/);
    assert.doesNotMatch(raw, /lcp/);
    assert.equal((await fs.readdir(root)).length, 1);
  } finally {
    await store.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});
