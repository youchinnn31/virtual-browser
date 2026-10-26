import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { once } from "node:events";
import { createRequire } from "node:module";
import test from "node:test";
import { build } from "esbuild";
import puppeteer from "puppeteer";

test(
  "tablet worker isolates redirected URLs and collects only on its first access",
  { timeout: 60000 },
  async () => {
    await build({
      entryPoints: ["src/server/evaluation/worker.ts"],
      outfile: "dist/test/worker.cjs",
      bundle: true,
      platform: "node",
      packages: "external",
    });
    const { TabletWorker } = createRequire(import.meta.url)(
      "../dist/test/worker.cjs",
    );
    let count = 0;
    const agents = [];
    const server = http.createServer((req, res) => {
      agents.push(req.headers["user-agent"]);
      if (req.url === "/") {
        count++;
        res.writeHead(302, { Location: `/page?${count}` });
        res.end();
      } else {
        res.setHeader("Content-Type", "text/html");
        res.end(
          `<h1 id="title" style="${count === 3 ? "display:none" : ""}">Tablet fixture</h1>`,
        );
      }
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const browser = await puppeteer.launch({
      headless: "new",
      args: ["--no-proxy-server"],
    });
    let worker;
    try {
      const directory = await fs.mkdtemp(
        path.join(os.tmpdir(), "tablet-worker-"),
      );
      worker = await TabletWorker.open(
        browser,
        path.join(directory, "collected.db"),
        `http://127.0.0.1:${server.address().port}/`,
        {
          name: "fixture",
          userAgent: "Tablet-Test-Agent",
          width: 600,
          height: 400,
          dpr: 2,
          orientation: "landscape",
        },
      );
      let firstCount;
      for (let access = 0; access <= 5; access++) {
        const frames = [];
        const result = await worker.render(access, (frame) =>
          frames.push(frame),
        );
        assert.equal(frames.at(-1).kind, "viewport");
        assert.equal(frames.at(-1).width, 600);
        if (access === 0) {
          firstCount = result.collected.candidates;
          assert.ok(firstCount > 0);
          assert.equal(frames.length, 1);
          await worker.saveInitial(1200);
        } else {
          assert.equal(result.collected.candidates, firstCount);
          assert.equal(
            result.candidates[0].status,
            access === 2 ? "no-bounding-box" : "sent",
          );
        }
      }
      assert.equal(count, 6);
      assert.ok(agents.every((agent) => agent === "Tablet-Test-Agent"));
    } finally {
      await worker?.close();
      await browser.close();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  },
);
