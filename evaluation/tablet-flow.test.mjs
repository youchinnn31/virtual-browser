import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { once } from "node:events";
import { spawn } from "node:child_process";
import test from "node:test";
import puppeteer from "puppeteer";
import ExcelJS from "exceljs";
import WebSocket from "ws";

test(
  "real-page evaluation repeats on the client, exports two speeds, and saves stopped runs",
  { timeout: 120000 },
  async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "tablet-flow-"));
    let visits = 0;
    const agents = [];
    const fixture = http.createServer((req, res) => {
      if (req.url === "/") {
        visits++;
        agents.push(req.headers["user-agent"]);
      }
      res.setHeader("Content-Type", "text/html");
      res.end('<h1 id="hero">Real device fixture</h1>');
    });
    fixture.listen(0, "127.0.0.1");
    await once(fixture, "listening");
    const child = spawn(process.execPath, ["dist/server/index.js"], {
      detached: true,
      env: {
        ...process.env,
        CHARLES_CONFIG: "",
        TABLET_RESULTS_DIR: directory,
        LCP_DB_PATH: path.join(directory, "normal.db"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let logs = "";
    child.stderr.on("data", (data) => {
      logs += data;
    });
    let browser;
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(logs || "Server startup timed out")),
          30000,
        );
        child.once("exit", () => {
          clearTimeout(timer);
          reject(new Error(logs));
        });
        child.stdout.on("data", (data) => {
          logs += data;
          if (logs.includes("App listening on port 3000")) {
            clearTimeout(timer);
            resolve();
          }
        });
      });
      browser = await puppeteer.launch({ headless: "new" });
      const page = await browser.newPage();
      await page.setViewport({
        width: 1024,
        height: 900,
        deviceScaleFactor: 2,
        isMobile: true,
      });
      const ua =
        "Mozilla/5.0 (iPad; CPU OS 16_6 like Mac OS X) AppleWebKit/605.1.15 Version/16.6 Mobile/15E148 Safari/604.1";
      await page.setUserAgent(ua);
      const errors = [];
      page.on("pageerror", (error) => errors.push(String(error)));
      await page.goto("http://127.0.0.1:3000/evaluation");
      await page.waitForFunction(
        () => !document.getElementById("start").disabled,
      );
      const url = `http://127.0.0.1:${fixture.address().port}/`;
      await page.evaluate((target) => {
        document.getElementById("urls").value = target;
        document.getElementById("device-name").value = "Test iPad";
        for (const input of document.querySelectorAll("#speeds input"))
          input.checked = ["128", "1024"].includes(input.value);
      }, url);
      await page.click("#start");
      for (let speed = 0; speed < 2; speed++) {
        await page.waitForSelector("#speed-panel:not([hidden])");
        if (speed === 0) {
          const normal = new WebSocket("ws://127.0.0.1:3000/");
          const [code] = await once(normal, "close");
          assert.equal(code, 1013);
        }
        await page.click("#speed-confirm");
      }
      await page.waitForFunction(
        () =>
          document
            .getElementById("status")
            .textContent.includes("評価終了：complete"),
        { timeout: 60000 },
      );
      assert.equal(visits, 12);
      assert.ok(agents.every((agent) => agent === ua));
      const download = await page.$eval("#download", (element) =>
        element.getAttribute("href"),
      );
      const runId = download.split("/").at(-1);
      const config = JSON.parse(
        await fs.readFile(path.join(directory, runId, "config.json"), "utf8"),
      );
      assert.equal(config.device.dpr, 2);
      assert.equal(
        config.device.width,
        await page.$eval("canvas", (canvas) => canvas.clientWidth),
      );
      assert.equal(config.speedMode, "external-unverified");
      const book = new ExcelJS.Workbook();
      await book.xlsx.readFile(path.join(directory, runId, "results.xlsx"));
      assert.equal(book.getWorksheet("中央値").rowCount, 3);
      assert.equal(book.getWorksheet("測定値").rowCount, 11);
      for (const index of [2, 3]) {
        assert.equal(
          book.getWorksheet("中央値").getCell(`K${index}`).value,
          "ok",
        );
        assert.equal(
          typeof book.getWorksheet("中央値").getCell(`C${index}`).value,
          "number",
        );
      }
      const response = await fetch(`http://127.0.0.1:3000${download}`);
      assert.equal(response.status, 200);
      await page.evaluate(() => {
        for (const input of document.querySelectorAll("#speeds input"))
          input.checked = input.value === "1024";
      });
      await page.click("#start");
      await page.waitForSelector("#speed-panel:not([hidden])");
      await page.click("#speed-confirm");
      await page.waitForFunction(
        () =>
          document.getElementById("history").textContent.includes("アクセス2"),
        { timeout: 20000 },
      );
      await page.click("#stop");
      await page.waitForFunction(
        () =>
          document
            .getElementById("status")
            .textContent.includes("評価終了：stopped"),
        { timeout: 20000 },
      );
      const stoppedId = (
        await page.$eval("#download", (element) => element.getAttribute("href"))
      )
        .split("/")
        .at(-1);
      const stopped = new ExcelJS.Workbook();
      await stopped.xlsx.readFile(
        path.join(directory, stoppedId, "results.xlsx"),
      );
      assert.equal(stopped.getWorksheet("中央値").getCell("C2").value, null);
      assert.notEqual(stopped.getWorksheet("中央値").getCell("K2").value, "ok");
      await page.click("#start");
      await page.waitForSelector("#speed-panel:not([hidden])");
      await page.click("#speed-confirm");
      await page.waitForFunction(
        () =>
          document.getElementById("history").textContent.includes("アクセス1"),
        { timeout: 20000 },
      );
      await page.setViewport({
        width: 900,
        height: 850,
        deviceScaleFactor: 2,
        isMobile: true,
      });
      await page.waitForFunction(
        () =>
          document
            .getElementById("status")
            .textContent.includes("評価終了：stopped"),
        { timeout: 20000 },
      );
      await page.click("#start");
      await page.waitForSelector("#speed-panel:not([hidden])");
      const shutdownId = (
        await page.$eval("#download", (element) => element.getAttribute("href"))
      )
        .split("/")
        .at(-1);
      const exited = once(child, "exit");
      process.kill(-child.pid, "SIGTERM");
      const [exitCode] = await exited;
      assert.equal(exitCode, 0);
      const shutdown = new ExcelJS.Workbook();
      await shutdown.xlsx.readFile(
        path.join(directory, shutdownId, "results.xlsx"),
      );
      assert.equal(shutdown.getWorksheet("中央値").rowCount, 1);
      const logFiles = await fs.readdir(path.join(directory, "logs"));
      const records = (
        await fs.readFile(path.join(directory, "logs", logFiles[0]), "utf8")
      )
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
      ]) {
        assert.ok(
          records.some((record) => record.event === event),
          `Missing progress event: ${event}`,
        );
      }
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
        records.every((record) => !("img" in record) && !("token" in record)),
      );
      assert.match(logs, /\[tablet\].*navigate-start/);
      assert.match(logs, /\[tablet\].*client-rendered/);
      assert.deepEqual(errors, []);
    } finally {
      await browser?.close();
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit");
        process.kill(-child.pid, "SIGTERM");
        const timer = setTimeout(() => {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {
            /* The test process group may already have exited. */
          }
        }, 2000);
        await exited;
        clearTimeout(timer);
      }
      fixture.closeAllConnections();
      await new Promise((resolve) => fixture.close(resolve));
    }
  },
);
