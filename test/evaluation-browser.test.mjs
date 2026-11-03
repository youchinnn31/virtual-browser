import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import puppeteer from "puppeteer";
import sqlite3 from "sqlite3";
import { open } from "sqlite";
import sharp from "sharp";
import { transform } from "esbuild";

function canvasGeometry() {
  const canvas = document.querySelector("#browser");
  const rect = canvas.getBoundingClientRect();
  return {
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    devicePixelRatio: window.devicePixelRatio,
    width: canvas.width,
    height: canvas.height,
    clientWidth: canvas.clientWidth,
    left: rect.left,
    top: rect.top,
    cssWidth: rect.width,
    cssHeight: rect.height,
  };
}

test(
  "mobile evaluation preserves the normal page geometry, renders images, exports medians, and aborts when backgrounded",
  { timeout: 90000 },
  async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "evaluation-browser-"),
    );
    // The normal page retains origin/main's layout and connection-time sizing.
    const legacyHtml = await fs.readFile("src/client/index.html", "utf8");
    const legacyClient = await transform(
      await fs.readFile("src/client/index.ts", "utf8"),
      { loader: "ts" },
    );
    const visits = new Map();
    const hero = await sharp(
      Buffer.from(
        Array.from(
          { length: 300 * 200 * 3 },
          (_, index) => (index * 73 + Math.floor(index / 41) * 17) % 256,
        ),
      ),
      { raw: { width: 300, height: 200, channels: 3 } },
    )
      .png()
      .toBuffer();
    const fixture = http.createServer((req, res) => {
      res.setHeader("Cache-Control", "no-store");
      if (req.url === "/legacy-reference") {
        res.setHeader("Content-Type", "text/html");
        res.end(
          legacyHtml.replace('src="index.js"', 'src="/legacy-client.js"'),
        );
        return;
      }
      if (req.url === "/legacy-client.js") {
        res.setHeader("Content-Type", "application/javascript");
        res.end(legacyClient.code);
        return;
      }
      if (req.url === "/hero.png") {
        setTimeout(() => {
          res.setHeader("Content-Type", "image/png");
          res.end(hero);
        }, 200);
        return;
      }
      if (req.url === "/favicon.ico") {
        res.writeHead(204).end();
        return;
      }
      const count = (visits.get(req.url) ?? 0) + 1;
      visits.set(req.url, count);
      res.setHeader("Content-Type", "text/html");
      res.end(
        req.url === "/missing"
          ? `<html><body><h1 id="${count === 1 ? "original" : "changed"}">Changed DOM</h1></body></html>`
          : '<html><body><h1 id="heading">Mobile image test</h1><img id="hero" src="/hero.png" width="300" height="200"></body></html>',
      );
    });
    await new Promise((resolve) => fixture.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${fixture.address().port}`;
    const server = spawn(
      process.execPath,
      ["dist/evaluation/server/index.js"],
      {
        env: {
          ...process.env,
          EVALUATION_PORT: "0",
          EVALUATION_RESULTS_DIR: root,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let browser;
    let serverLog = "";
    server.stderr.on("data", (chunk) => {
      serverLog += chunk;
    });
    try {
      const port = await new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("Server startup timed out: " + serverLog)),
          15000,
        );
        server.once("exit", (code) => {
          clearTimeout(timer);
          reject(new Error(`Server exited (${code}): ${serverLog}`));
        });
        let buffer = "";
        server.stdout.on("data", (chunk) => {
          buffer += chunk;
          while (buffer.includes("\n")) {
            const newline = buffer.indexOf("\n");
            const line = buffer.slice(0, newline);
            buffer = buffer.slice(newline + 1);
            if (!line.includes('"evaluation:listening"')) continue;
            clearTimeout(timer);
            resolve(JSON.parse(line).port);
          }
        });
      });
      const args =
        process.env["EVALUATION_NO_SANDBOX"] === "1" ? ["--no-sandbox"] : [];
      browser = await puppeteer.launch({ headless: "new", args });
      const page = await browser.newPage();
      await page.setViewport({
        width: 390,
        height: 844,
        deviceScaleFactor: 2,
        isMobile: true,
        hasTouch: true,
      });
      await page.setUserAgent(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1",
      );
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      const cdp = await page.createCDPSession();
      await cdp.send("Network.enable");
      const sent = [];
      const events = [];
      cdp.on("Network.webSocketFrameSent", (event) => {
        const message = JSON.parse(event.response.payloadData);
        sent.push(message);
        events.push({ direction: "sent", ...message });
      });
      cdp.on("Network.webSocketFrameReceived", (event) => {
        events.push({
          direction: "received",
          ...JSON.parse(event.response.payloadData),
        });
      });
      // Make LCP images slower than viewport delivery, then observe
      // actual Canvas draws without depending on the client's private state.
      await page.evaluateOnNewDocument(() => {
        const frames = [];
        const images = new WeakMap();
        window.__evaluationDraws = [];
        const NativeSocket = WebSocket;
        window.WebSocket = class extends NativeSocket {
          constructor(...args) {
            super(...args);
            this.addEventListener("message", (event) => {
              const message = JSON.parse(event.data);
              if (message.action === "trial:image") frames.push(message);
            });
          }
        };
        const source = Object.getOwnPropertyDescriptor(
          HTMLImageElement.prototype,
          "src",
        );
        Object.defineProperty(HTMLImageElement.prototype, "src", {
          get: source.get,
          set(value) {
            const frame = value.startsWith("blob:") ? frames.shift() : null;
            if (frame) images.set(this, frame);
            if (frame?.kind === "lcp") {
              setTimeout(() => source.set.call(this, value), 750);
            } else source.set.call(this, value);
          },
        });
        const draw = CanvasRenderingContext2D.prototype.drawImage;
        CanvasRenderingContext2D.prototype.drawImage = function (...args) {
          const result = draw.apply(this, args);
          const frame = images.get(args[0]);
          if (frame)
            window.__evaluationDraws.push({
              trialId: frame.trialId,
              kind: frame.kind,
              imageIndex: frame.imageIndex,
            });
          return result;
        };
      });
      const reference = await browser.newPage();
      await reference.setUserAgent(
        await page.evaluate(() => navigator.userAgent),
      );
      await reference.evaluateOnNewDocument(() => {
        // Exercise the normal client's own open handler without a normal server.
        window.WebSocket = class extends EventTarget {
          constructor() {
            super();
            setTimeout(() => this.dispatchEvent(new Event("open")), 0);
          }
          send(data) {
            const message = JSON.parse(data);
            if (message.action === "init") window.__legacyDevice = message;
          }
        };
      });
      let legacyDevice;
      for (const deviceScaleFactor of [1, 3, 2]) {
        const viewport = {
          width: 390,
          height: 844,
          deviceScaleFactor,
          isMobile: true,
          hasTouch: true,
        };
        await reference.setViewport(viewport);
        await reference.goto(origin + "/legacy-reference");
        await reference.waitForFunction(() => window.__legacyDevice);
        await page.setViewport(viewport);
        await page.bringToFront();
        await page.goto(`http://127.0.0.1:${port}/`);
        await page.waitForFunction(
          () => !document.querySelector("#start").disabled,
        );
        const expected = await reference.evaluate(canvasGeometry);
        assert.deepEqual(await page.evaluate(canvasGeometry), expected);
        assert.equal(await page.$('meta[name="viewport"]'), null);
        await page.click("#show-browser");
        assert.deepEqual(await page.evaluate(canvasGeometry), expected);
        await page.click("#url-button");
        assert.deepEqual(await page.evaluate(canvasGeometry), expected);
        legacyDevice = await reference.evaluate(() => window.__legacyDevice);
      }
      // A viewport change after connecting must not recompute the stored size.
      const resized = {
        width: 390,
        height: 900,
        deviceScaleFactor: 2,
        isMobile: true,
        hasTouch: true,
      };
      await reference.setViewport(resized);
      await page.setViewport(resized);
      const expectedGeometry = await reference.evaluate(canvasGeometry);
      assert.deepEqual(await page.evaluate(canvasGeometry), expectedGeometry);
      await reference.close();
      await page.$eval(
        "#urls",
        (element, value) => {
          element.value = value;
        },
        origin + "/normal\n" + origin + "/missing",
      );
      await page.$eval("#profiles", (element) => {
        element.value = "Charles test condition";
      });
      await page.click("#start");
      await page.waitForSelector("#profile-panel:not([hidden])");
      assert.deepEqual(await page.evaluate(canvasGeometry), expectedGeometry);
      const start = sent.find((message) => message.action === "run:start");
      assert.deepEqual(start.device, {
        width: legacyDevice.width,
        height: legacyDevice.height,
        devicePixelRatio: 2,
        userAgent: legacyDevice.userAgent,
      });
      await page.evaluate(() => window.dispatchEvent(new Event("resize")));
      assert.ok(
        (
          await page.$eval("#status", (element) => element.textContent)
        ).includes("Charles"),
      );
      assert.equal(await page.$$eval("#trials tr", (rows) => rows.length), 0);
      await page.click("#confirm-profile");
      await page.waitForFunction(
        () =>
          document.querySelector("#status").textContent.includes("評価が終了"),
        { timeout: 45000 },
      );
      assert.deepEqual(errors, []);
      assert.deepEqual(await page.evaluate(canvasGeometry), expectedGeometry);
      assert.equal(await page.$$eval("#trials tr", (rows) => rows.length), 12);
      assert.deepEqual(
        await page.$$eval("#summaries tr", (rows) =>
          rows.map((row) => row.dataset.status),
        ),
        ["complete", "incomplete"],
      );
      const metrics = sent.filter(
        (message) => message.action === "trial:metric",
      );
      const complete = sent.filter(
        (message) => message.action === "trial:complete",
      );
      assert.equal(metrics.length, 7);
      assert.equal(complete.length, 7);
      for (const completed of complete) {
        const metric = metrics.find(
          (message) => message.trialId === completed.trialId,
        );
        assert.ok(completed.viewportMs >= metric.firstImageMs);
        assert.ok(sent.indexOf(metric) < sent.indexOf(completed));
      }
      const lcpCompleted = sent.filter(
        (message) => message.action === "trial:lcp-complete",
      );
      assert.equal(lcpCompleted.length, 5);
      const draws = await page.evaluate(() => window.__evaluationDraws);
      for (const lcp of lcpCompleted) {
        const viewport = events.find(
          (message) =>
            message.direction === "received" &&
            message.action === "trial:image" &&
            message.kind === "viewport" &&
            message.trialId === lcp.trialId,
        );
        const acknowledged = events.find(
          (message) =>
            message.direction === "sent" &&
            message.action === "trial:lcp-complete" &&
            message.trialId === lcp.trialId,
        );
        assert.ok(viewport);
        assert.ok(
          events.indexOf(viewport) < events.indexOf(acknowledged),
          "viewport delivery must not wait for LCP rendering",
        );
        const trialDraws = draws.filter((draw) => draw.trialId === lcp.trialId);
        assert.equal(trialDraws.length, lcp.renderedCount + 1);
        assert.ok(trialDraws.slice(1).every((draw) => draw.kind === "lcp"));
        assert.equal(
          trialDraws[0].kind,
          "viewport",
          "legacy rendering must draw the ready viewport without waiting for delayed LCP images",
        );
        const complete = sent.find(
          (message) =>
            message.action === "trial:complete" &&
            message.trialId === lcp.trialId,
        );
        assert.ok(complete.viewportMs < lcp.lcpImagesMs);
        const metric = metrics.find(
          (message) => message.trialId === lcp.trialId,
        );
        assert.equal(metric.firstImageIndex, trialDraws[0].imageIndex);
        assert.equal(metric.firstImageMs, complete.viewportMs);
      }
      const link = await page.$eval(
        '#downloads a[href$="summary.csv"]',
        (element) => element.href,
      );
      const runId = new URL(link).pathname.split("/")[2];
      const db = await open({
        filename: path.join(root, runId, "evaluation.sqlite"),
        driver: sqlite3.Database,
        mode: sqlite3.OPEN_READONLY,
      });
      try {
        const evaluations = await db.all(
          "SELECT * FROM evaluations ORDER BY rowid",
        );
        const values = await db.all(
          "SELECT * FROM trials WHERE evaluation_id = ? AND phase = 'revisit' ORDER BY first_image_ms",
          evaluations[0].id,
        );
        assert.equal(values.length, 5);
        assert.equal(evaluations[0].median_ms, values[2].first_image_ms);
        assert.equal(
          evaluations[0].viewport_median_ms,
          [...values].sort((a, b) => a.viewport_ms - b.viewport_ms)[2]
            .viewport_ms,
        );
        assert.ok(
          values.every(
            (value) =>
              value.lcp_image_count >= 2 &&
              value.image_count === value.lcp_image_count + 1 &&
              value.viewport_ms < value.lcp_images_ms &&
              value.first_image_ms === value.viewport_ms &&
              value.lcp_images_ms >= value.first_image_ms,
          ),
          "all saved LCP candidates must be rendered: " +
            JSON.stringify({
              candidates: await db.all(
                "SELECT * FROM candidates WHERE evaluation_id = ?",
                evaluations[0].id,
              ),
              imageCounts: values.map((value) => value.image_count),
            }),
        );
        assert.equal(evaluations[1].median_ms, null);
        const missing = await db.all(
          "SELECT * FROM trials WHERE evaluation_id = ? AND phase = 'revisit'",
          evaluations[1].id,
        );
        assert.ok(
          missing.every(
            (value) => value.status === "failed" && value.image_count === 0,
          ),
        );
        const run = await db.get("SELECT * FROM runs");
        assert.equal(JSON.parse(run.device_json).devicePixelRatio, 2);
        assert.equal(JSON.parse(run.device_json).width, legacyDevice.width);
        assert.equal(JSON.parse(run.device_json).height, legacyDevice.height);
        assert.equal(
          JSON.parse(run.metadata_json).throttling,
          "external-charles",
        );
      } finally {
        await db.close();
      }
      assert.equal((await fetch(link)).status, 200);
      await fs.mkdir("dist/evaluation-tests", { recursive: true });
      await page.screenshot({
        path: "dist/evaluation-tests/mobile.png",
        fullPage: true,
      });

      // A real tab focus change exercises the mobile page's visibility handler.
      await page.click("#start");
      await page.waitForSelector("#profile-panel:not([hidden])");
      const other = await browser.newPage();
      await other.bringToFront();
      await page.waitForFunction(() =>
        document.querySelector("#status").textContent.includes("中断しました"),
      );
      const abortedLink = await page.$eval(
        '#downloads a[href$="summary.csv"]',
        (element) => element.href,
      );
      assert.notEqual(abortedLink, link);
      assert.equal((await fetch(abortedLink)).status, 200);
      assert.deepEqual(errors, []);
    } finally {
      await browser?.close();
      if (server.exitCode === null && server.signalCode === null) {
        const exited = once(server, "exit");
        server.kill("SIGTERM");
        await exited;
      }
      await new Promise((resolve) => fixture.close(resolve));
      await fs.rm(root, { recursive: true, force: true });
    }
  },
);
