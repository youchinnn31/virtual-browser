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
import sqlite3 from "sqlite3";

test(
  "tablet worker keys collection by the final URL and collects only on its first access",
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
        res.writeHead(302, { Location: count === 6 ? "/other" : "/page" });
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
        } else if (access === 5) {
          assert.equal(result.collected.candidates, 0);
          assert.deepEqual(result.candidates, []);
          assert.equal(
            frames.length,
            1,
            "Do not reuse another final URL's candidates",
          );
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
      const db = new sqlite3.Database(
        path.join(directory, "collected.db"),
        sqlite3.OPEN_READONLY,
      );
      const rows = await new Promise((resolve, reject) =>
        db.all("SELECT url, image_lcp FROM url ORDER BY id", (error, rows) =>
          error ? reject(error) : resolve(rows),
        ),
      );
      await new Promise((resolve) => db.close(resolve));
      const origin = `http://127.0.0.1:${server.address().port}`;
      assert.deepEqual(rows, [
        { url: `${origin}/page`, image_lcp: 1200 },
        { url: `${origin}/other`, image_lcp: -1 },
      ]);
    } finally {
      await worker?.close();
      await browser.close();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  },
);

test(
  "DOMContentLoaded applies to initial collection and excludes candidates painted after capture",
  { timeout: 20000 },
  async () => {
    const { TabletWorker } = createRequire(import.meta.url)(
      "../dist/test/worker.cjs",
    );
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), "tablet-domcontentloaded-"),
    );
    let pendingImage;
    let releaseImage = false;
    const image =
      '<svg xmlns="http://www.w3.org/2000/svg" width="500" height="250"><rect width="500" height="250" fill="blue"/></svg>';
    const server = http.createServer((req, res) => {
      if (req.url === "/late.svg") {
        res.writeHead(200, {
          "Content-Type": "image/svg+xml",
          "Cache-Control": "public, max-age=3600",
        });
        if (releaseImage) res.end(image);
        else pendingImage = res;
      } else {
        res.writeHead(200, {
          "Content-Type": "text/html",
          "Cache-Control": "no-store",
        });
        res.end(`<h1 id="hero">Early heading</h1><img id="late" src="/late.svg" width="500" height="250">
          <script>addEventListener('load', () => window.fixtureLoaded = true);</script>`);
      }
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const browser = await puppeteer.launch({ headless: "new" });
    const progress = [];
    let worker;
    try {
      const url = `http://127.0.0.1:${server.address().port}/`;
      worker = await TabletWorker.open(
        browser,
        path.join(directory, "collected.db"),
        url,
        {
          name: "DOMContentLoaded",
          userAgent: await browser.userAgent(),
          width: 600,
          height: 400,
          dpr: 1,
          orientation: "landscape",
        },
        (event, details) => progress.push({ event, ...details }),
        "domcontentloaded",
      );
      const first = await worker.render(0, () => {});
      const page = (await browser.pages()).find((page) => page.url() === url);
      assert.equal(await page.evaluate(() => !!window.fixtureLoaded), false);
      assert.ok(
        pendingImage,
        "Initial capture should finish with the image still loading",
      );
      assert.ok(first.collected.candidates > 0);
      const collectedBeforeImage = progress.filter(
        ({ event }) => event === "candidate-collected",
      );
      assert.ok(
        collectedBeforeImage.every(({ xpath }) => xpath !== 'id("late")'),
      );
      await worker.saveInitial(1000);
      releaseImage = true;
      pendingImage.end(image);
      await page.waitForFunction(() => window.fixtureLoaded);
      // Two painted frames allow the late image to become an LCP candidate.
      await page.evaluate(
        () =>
          new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve)),
          ),
      );
      for (let access = 1; access <= 5; access++) {
        const result = await worker.render(access, () => {});
        assert.equal(result.collected.candidates, first.collected.candidates);
        assert.ok(
          result.candidates.every(({ xpath }) => xpath !== 'id("late")'),
        );
      }
      const navigations = progress.filter(
        ({ event }) => event === "navigate-start",
      );
      assert.equal(navigations.length, 6);
      assert.ok(
        navigations.every(({ waitUntil }) => waitUntil === "domcontentloaded"),
      );
      assert.deepEqual(
        progress.filter(({ event }) => event === "candidate-collected"),
        collectedBeforeImage,
      );
    } finally {
      if (pendingImage && !pendingImage.writableEnded) pendingImage.end(image);
      await worker?.close();
      await browser.close();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  },
);

test(
  "tablet worker defaults to HTTP cache and Service Workers with a 30-second navigation timeout",
  { timeout: 60000 },
  async () => {
    const { TabletWorker } = createRequire(import.meta.url)(
      "../dist/test/worker.cjs",
    );
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), "tablet-main-policy-"),
    );
    let assetRequests = 0;
    let controlledRequests = 0;
    const server = http.createServer((req, res) => {
      if (req.url === "/worker.js") {
        res.setHeader("Content-Type", "application/javascript");
        res.end(`
        self.addEventListener('install', event => event.waitUntil(self.skipWaiting()));
        self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
        self.addEventListener('fetch', event => {
          if (new URL(event.request.url).pathname === '/controlled')
            event.respondWith(Promise.resolve(new Response('from service worker')));
        });`);
      } else if (req.url === "/controlled") {
        controlledRequests++;
        res.setHeader("Cache-Control", "no-store");
        res.end("from network");
      } else if (req.url === "/asset.svg") {
        assetRequests++;
        res.writeHead(200, {
          "Content-Type": "image/svg+xml",
          "Cache-Control": "public, max-age=3600",
        });
        res.end(
          '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"><rect width="200" height="100" fill="blue"/></svg>',
        );
      } else {
        res.writeHead(200, {
          "Content-Type": "text/html",
          "Cache-Control": "no-store",
        });
        res.end(`<h1 id="hero">Main policy</h1><img src="/asset.svg" width="200" height="100">
        <script>
          fetch('/controlled').then(() => navigator.serviceWorker.register('/worker.js'));
        </script>`);
      }
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const browser = await puppeteer.launch({ headless: "new" });
    const progress = [];
    let worker;
    try {
      worker = await TabletWorker.open(
        browser,
        path.join(directory, "collected.db"),
        `http://127.0.0.1:${server.address().port}/`,
        {
          name: "main policy",
          userAgent: await browser.userAgent(),
          width: 600,
          height: 400,
          dpr: 1,
          orientation: "landscape",
        },
        (event, details) => progress.push({ event, ...details }),
      );
      await worker.render(0, () => {});
      await worker.saveInitial(1000);
      const page = (await browser.pages()).find((page) =>
        page.url().startsWith(`http://127.0.0.1:${server.address().port}/`),
      );
      await page.waitForFunction(
        () => navigator.serviceWorker.controller !== null,
      );
      await worker.render(1, () => {});
      assert.equal(assetRequests, 1, "HTTP assets should be reused by default");
      assert.equal(
        controlledRequests,
        1,
        "The Service Worker should handle later requests",
      );
      assert.ok(
        progress
          .filter(({ event }) => event === "navigate-start")
          .every(({ timeout }) => timeout === 30000),
      );
    } finally {
      await worker?.close();
      await browser.close();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  },
);
