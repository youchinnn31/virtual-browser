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

test(
  "automatic speed verification rejects an unthrottled connection and restores Charles",
  { timeout: 60000 },
  async () => {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), "tablet-charles-"),
    );
    let state = { enabled: false, speed: 200 };
    let visits = 0;
    const control = http.createServer((req, res) => {
      const url = new URL(req.url);
      if (url.pathname === "/select")
        state = { enabled: true, speed: Number(url.searchParams.get("speed")) };
      if (url.pathname === "/disable") state.enabled = false;
      res.end(`enabled=${state.enabled};selected=${state.speed};`);
    });
    control.listen(0, "127.0.0.1");
    await once(control, "listening");
    const target = http.createServer((_req, res) => {
      visits++;
      res.end("Target must not be measured");
    });
    target.listen(0, "127.0.0.1");
    await once(target, "listening");
    const configPath = path.join(directory, "charles.json");
    await fs.writeFile(
      configPath,
      JSON.stringify({
        proxyHost: "127.0.0.1",
        proxyPort: control.address().port,
        status: { method: "GET", path: "/status" },
        enabledPattern: "enabled=true;",
        disabledPattern: "enabled=false;",
        disable: { method: "POST", path: "/disable" },
        presets: Object.fromEntries(
          [128, 200, 300, 1024].map((speed) => [
            speed,
            {
              select: { method: "POST", path: `/select?speed=${speed}` },
              selectedPattern: `selected=${speed};`,
            },
          ]),
        ),
      }),
    );
    const child = spawn(process.execPath, ["dist/server/index.js"], {
      detached: true,
      env: {
        ...process.env,
        CHARLES_CONFIG: configPath,
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
        const timer = setTimeout(() => reject(new Error(logs)), 30000);
        child.stdout.on("data", (data) => {
          logs += data;
          if (logs.includes("App listening")) {
            clearTimeout(timer);
            resolve();
          }
        });
        child.once("exit", () => {
          clearTimeout(timer);
          reject(new Error(logs));
        });
      });
      browser = await puppeteer.launch({ headless: "new" });
      const page = await browser.newPage();
      await page.setViewport({ width: 1000, height: 850 });
      const errors = [];
      page.on("pageerror", (error) => errors.push(String(error)));
      await page.goto("http://127.0.0.1:3000/evaluation");
      await page.waitForFunction(
        () => !document.getElementById("start").disabled,
      );
      await page.evaluate((url) => {
        document.getElementById("urls").value = url;
      }, `http://127.0.0.1:${target.address().port}/`);
      await page.click("#start");
      await page.waitForFunction(
        () =>
          document
            .getElementById("status")
            .textContent.includes("評価終了：failed"),
        { timeout: 30000 },
      );
      assert.equal(visits, 0);
      assert.deepEqual(state, { enabled: false, speed: 200 });
      assert.deepEqual(errors, []);
      const id = (
        await page.$eval("#download", (element) => element.getAttribute("href"))
      )
        .split("/")
        .at(-1);
      const book = new ExcelJS.Workbook();
      await book.xlsx.readFile(path.join(directory, id, "results.xlsx"));
      assert.equal(book.getWorksheet("中央値").rowCount, 1);
      const actions = [];
      book.getWorksheet("速度制御").eachRow((row, index) => {
        if (index > 1) actions.push(row.getCell(2).value);
      });
      assert.ok(actions.includes("bandwidth-verification"));
      assert.ok(actions.includes("charles-restored"));
    } finally {
      await browser?.close();
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit");
        process.kill(-child.pid, "SIGTERM");
        const timer = setTimeout(() => {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {
            /* Test process already exited. */
          }
        }, 2000);
        await exited;
        clearTimeout(timer);
      }
      for (const server of [control, target]) {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
      }
    }
  },
);
