import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import os from "node:os";
import { once } from "node:events";
import { createRequire } from "node:module";
import test from "node:test";
import { build } from "esbuild";
import express from "express";
import puppeteer from "puppeteer";
import { WebSocketServer } from "ws";

test(
  "tablet progress logs prove navigation, image transfer and real client rendering",
  { timeout: 60000 },
  async () => {
    await build({
      entryPoints: ["src/server/evaluation/controller.ts"],
      outfile: "dist/test/tablet-logging.cjs",
      bundle: true,
      platform: "node",
      packages: "external",
    });
    const { registerTabletEvaluation } = createRequire(import.meta.url)(
      "../dist/test/tablet-logging.cjs",
    );
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), "tablet-logging-"),
    );
    const browser = await puppeteer.launch({ headless: "new" });
    const app = express();
    app.use(express.static(path.resolve("dist/client")));
    let visits = 0;
    app.get("/fixture", (_req, res) => {
      visits++;
      res.send(`<h1 id="hero">Logging fixture</h1>
        <script>
          for (let i = 0; i < 3; i++) fetch('/pending?i=' + i);
        </script>`);
    });
    // Three unfinished requests prevent networkidle2 even after load fires.
    app.get("/pending", () => {});
    const previousRoot = process.env.TABLET_RESULTS_DIR;
    process.env.TABLET_RESULTS_DIR = directory;
    const evaluation = registerTabletEvaluation(app, browser, () => true);
    if (previousRoot === undefined) delete process.env.TABLET_RESULTS_DIR;
    else process.env.TABLET_RESULTS_DIR = previousRoot;
    const server = http.createServer(app);
    const wss = new WebSocketServer({ server });
    wss.on("connection", (socket, request) =>
      evaluation.connect(
        socket,
        new URL(request.url, "http://localhost").searchParams.get("token"),
      ),
    );
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      const origin = `http://127.0.0.1:${server.address().port}`;
      const page = await browser.newPage();
      await page.setViewport({ width: 900, height: 800 });
      const errors = [];
      page.on("pageerror", (error) => errors.push(String(error)));
      await page.goto(`${origin}/evaluation`);
      await page.waitForFunction(
        () => !document.getElementById("start").disabled,
      );
      await page.evaluate((url) => {
        document.getElementById("urls").value = url;
      }, `${origin}/fixture`);
      await page.select("#navigation-wait-until", "load");
      await page.click("#start");
      await page.waitForSelector("#speed-panel:not([hidden])");
      await page.click("#speed-confirm");
      await page.waitForFunction(
        () =>
          document
            .getElementById("status")
            .textContent.includes("評価終了：complete"),
        { timeout: 30000 },
      );
      await evaluation.stop();
      const runId = (
        await page.$eval("#download", (element) => element.getAttribute("href"))
      )
        .split("/")
        .at(-1);
      const config = JSON.parse(
        await fs.readFile(path.join(directory, runId, "config.json"), "utf8"),
      );
      assert.equal(config.navigationWaitUntil, "load");
      const files = await fs.readdir(path.join(directory, "logs"));
      const raw = await fs.readFile(
        path.join(directory, "logs", files[0]),
        "utf8",
      );
      const records = raw
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      for (const event of [
        "client-connected",
        "evaluation:speed-required",
        "navigate-start",
        "navigate-complete",
        "image-queued",
        "client-rendered",
        "evaluation:trial-saved",
        "excel-written",
      ])
        assert.ok(
          records.some((record) => record.event === event),
          `Missing ${event}`,
        );
      assert.equal(visits, 6);
      assert.ok(
        records
          .filter((record) => record.event === "navigate-start")
          .every((record) => record.waitUntil === "load"),
      );
      assert.equal(
        records.filter((record) => record.event === "client-rendered").length,
        6,
      );
      assert.ok(
        records.some(
          (record) =>
            record.event === "image-queued" &&
            record.kind === "lcp" &&
            record.bytes > 0,
        ),
      );
      assert.ok(
        records.some(
          (record) =>
            record.event === "client-rendered" && record.renderKind === "lcp",
        ),
      );
      assert.ok(
        records.some(
          (record) =>
            record.event === "navigate-complete" && record.status === 200,
        ),
      );
      assert.ok(
        records.every((record) => !("img" in record) && !("token" in record)),
      );
      assert.deepEqual(errors, []);
    } finally {
      await evaluation.stop();
      await browser.close();
      for (const client of wss.clients) client.terminate();
      await new Promise((resolve) => wss.close(resolve));
      await new Promise((resolve) => server.close(resolve));
    }
  },
);
