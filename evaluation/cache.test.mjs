import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { spawn } from "node:child_process";
import test from "node:test";
import puppeteer from "puppeteer";
import ExcelJS from "exceljs";

// Consume the CLI protocol while keeping the normal page's real UI and drawing.
function observeNormal() {
  window.cacheTest = { ready: false, completed: 0, acknowledged: 0 };
  const OriginalWebSocket = window.WebSocket;
  window.WebSocket = class extends OriginalWebSocket {
    constructor(...args) {
      super(...args);
      this.addEventListener("message", (event) => {
        const message = JSON.parse(event.data);
        if (!message.action) return;
        event.stopImmediatePropagation();
        if (message.action === "ready") window.cacheTest.ready = true;
        if (message.action === "complete") window.cacheTest.completed++;
        if (message.action === "lcp-received") window.cacheTest.acknowledged++;
      });
    }
  };
}

function cacheCondition(book) {
  let value;
  book.getWorksheet("測定条件").eachRow((row) => {
    if (row.getCell(1).value === "代理サーバーHTTPキャッシュ")
      value = row.getCell(2).value;
  });
  return value;
}

test(
  "cache choices control real asset reuse in normal UI and isolated tablet runs",
  { timeout: 120000 },
  async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cache-choice-"));
    const hits = new Map();
    const fixture = http.createServer((req, res) => {
      const url = new URL(req.url, "http://localhost");
      if (url.pathname === "/asset.svg") {
        const kind = url.searchParams.get("kind");
        hits.set(kind, (hits.get(kind) ?? 0) + 1);
        res.writeHead(200, {
          "Cache-Control": "public, max-age=3600",
          "Content-Type": "image/svg+xml",
        });
        res.end(
          '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"><rect width="200" height="100" fill="blue"/></svg>',
        );
      } else {
        res.writeHead(200, {
          "Cache-Control": "no-store",
          "Content-Type": "text/html",
        });
        res.end(
          `<h1 id="hero">Cache fixture</h1><img src="/asset.svg?kind=${url.pathname.slice(1)}" width="200" height="100">`,
        );
      }
    });
    fixture.listen(0, "127.0.0.1");
    await once(fixture, "listening");
    const origin = `http://127.0.0.1:${fixture.address().port}`;
    const server = spawn(process.execPath, ["dist/server/index.js"], {
      detached: true,
      env: {
        ...process.env,
        LCP_EVALUATION: "1",
        LCP_DB_PATH: path.join(directory, "normal.db"),
        TABLET_RESULTS_DIR: directory,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let logs = "";
    server.stderr.on("data", (data) => (logs += data));
    let browser;
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(logs)), 15000);
        server.stdout.on("data", (data) => {
          logs += data;
          if (logs.includes("App listening")) {
            clearTimeout(timer);
            resolve();
          }
        });
        server.once("exit", () => {
          clearTimeout(timer);
          reject(new Error(logs));
        });
      });
      browser = await puppeteer.launch({ headless: "new" });
      const page = await browser.newPage();
      await page.setViewport({ width: 900, height: 800 });
      const errors = [];
      page.on("pageerror", (error) => errors.push(String(error)));
      await page.evaluateOnNewDocument(observeNormal);
      await page.goto("http://127.0.0.1:3000/");
      await page.waitForFunction(() => window.cacheTest.ready);
      assert.equal(await page.$eval("#cache-enabled", (el) => el.value), "on");
      await page.$eval(
        "#url-input",
        (el, url) => (el.value = url),
        `${origin}/normal`,
      );
      for (const [index, mode] of ["on", "on", "off", "off"].entries()) {
        await page.select("#cache-enabled", mode);
        await page.click("#url-button");
        await page.waitForFunction(
          (count) =>
            window.cacheTest.completed === count &&
            window.cacheTest.acknowledged === count,
          { timeout: 15000 },
          index + 1,
        );
        assert.equal(hits.get("normal"), index < 2 ? 1 : index);
      }
      await page.close();

      const tablet = await browser.newPage();
      tablet.on("pageerror", (error) => errors.push(String(error)));
      await tablet.setViewport({ width: 900, height: 800 });
      await tablet.goto("http://127.0.0.1:3000/evaluation");
      await tablet.waitForFunction(
        () => !document.getElementById("start").disabled,
      );
      assert.equal(
        await tablet.$eval("#cache-enabled", (el) => el.value),
        "off",
      );
      await tablet.select("#navigation-wait-until", "load");
      await tablet.$eval(
        "#urls",
        (el, url) => (el.value = url),
        `${origin}/tablet`,
      );
      await tablet.$eval(
        '#speeds input[value="128"]',
        (el) => (el.checked = true),
      );
      for (const mode of ["on", "off"]) {
        const before = hits.get("tablet") ?? 0;
        await tablet.select("#cache-enabled", mode);
        await tablet.click("#start");
        await tablet.waitForSelector("#speed-panel:not([hidden])");
        assert.equal(
          await tablet.$eval("#cache-enabled", (el) => el.disabled),
          true,
        );
        for (let speed = 0; speed < 2; speed++) {
          await tablet.waitForSelector("#speed-panel:not([hidden])");
          await tablet.click("#speed-confirm");
        }
        await tablet.waitForFunction(
          () =>
            document
              .getElementById("status")
              .textContent.includes("評価終了：complete"),
          { timeout: 30000 },
        );
        assert.equal(hits.get("tablet") - before, mode === "on" ? 2 : 12);
        assert.equal(
          await tablet.$eval("#cache-enabled", (el) => el.disabled),
          false,
        );
        const id = (
          await tablet.$eval("#download", (el) => el.getAttribute("href"))
        )
          .split("/")
          .at(-1);
        const config = JSON.parse(
          await fs.readFile(path.join(directory, id, "config.json"), "utf8"),
        );
        assert.equal(config.cacheEnabled, mode === "on");
        const book = new ExcelJS.Workbook();
        await book.xlsx.readFile(path.join(directory, id, "results.xlsx"));
        assert.equal(cacheCondition(book), mode === "on" ? "有効" : "無効");
        assert.equal(book.getWorksheet("測定値").rowCount, 11);
        assert.ok(
          book.getWorksheet("中央値").getCell("J2").value > 0,
          "LCP candidates survive either cache policy",
        );
        assert.equal(
          typeof book.getWorksheet("中央値").getCell("C2").value,
          "number",
        );
      }
      assert.deepEqual(errors, []);
    } finally {
      await browser?.close();
      if (server.exitCode === null && server.signalCode === null) {
        const exited = once(server, "exit");
        process.kill(-server.pid, "SIGTERM");
        const timer = setTimeout(() => {
          try {
            process.kill(-server.pid, "SIGKILL");
          } catch {
            /* Already exited. */
          }
        }, 3000);
        await exited;
        clearTimeout(timer);
      }
      fixture.closeAllConnections();
      await new Promise((resolve) => fixture.close(resolve));
    }
  },
);

test(
  "CLI cache option reuses assets and records the selected condition",
  { timeout: 60000 },
  async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cache-cli-"));
    let images = 0;
    const fixture = http.createServer((req, res) => {
      if (req.url === "/asset.svg") {
        images++;
        res.writeHead(200, {
          "Cache-Control": "public, max-age=3600",
          "Content-Type": "image/svg+xml",
        });
        res.end(
          '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"><rect width="200" height="100" fill="blue"/></svg>',
        );
      } else {
        res.writeHead(200, {
          "Cache-Control": "no-store",
          "Content-Type": "text/html",
        });
        res.end(
          '<h1 id="hero">CLI cache fixture</h1><img src="/asset.svg" width="200" height="100">',
        );
      }
    });
    fixture.listen(0, "127.0.0.1");
    await once(fixture, "listening");
    const urls = path.join(directory, "urls.json");
    const output = path.join(directory, "cached.xlsx");
    await fs.writeFile(
      urls,
      JSON.stringify([`http://127.0.0.1:${fixture.address().port}/`]),
    );
    const child = spawn(
      process.execPath,
      [
        "evaluation/repeat.mjs",
        "--cache",
        "on",
        "--urls",
        urls,
        "--speeds",
        "1024",
        "--output",
        output,
        "--timeout",
        "15000",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let logs = "";
    child.stdout.on("data", (data) => (logs += data));
    child.stderr.on("data", (data) => (logs += data));
    try {
      const [code] = await once(child, "exit");
      assert.equal(code, 0, logs);
      assert.equal(images, 1, "Reuse the asset collected on the initial visit");
      const book = new ExcelJS.Workbook();
      await book.xlsx.readFile(output);
      assert.equal(cacheCondition(book), "有効");
      assert.equal(book.getWorksheet("測定値").rowCount, 6);
      assert.equal(
        typeof book.getWorksheet("中央値").getCell("C2").value,
        "number",
      );
    } finally {
      child.kill();
      fixture.closeAllConnections();
      await new Promise((resolve) => fixture.close(resolve));
    }
  },
);
