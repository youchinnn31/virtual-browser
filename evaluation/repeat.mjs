import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import puppeteer from "puppeteer";
import sqlite3 from "sqlite3";
import { writeReport } from "./report.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const { values } = parseArgs({
  options: {
    urls: { type: "string", default: "evaluation/urls.json" },
    speeds: { type: "string", default: "128,200,300,1024" },
    output: {
      type: "string",
      default: `evaluation/results/lcp-${Date.now()}.xlsx`,
    },
    timeout: { type: "string", default: "120000" },
    cache: { type: "string", default: "off" },
  },
});

// Observe the existing client's measurement without changing the client source.
// Control messages are consumed here before its image handler sees them.
function observeClient() {
  window.__measurement = { ready: false };
  const OriginalWebSocket = window.WebSocket;
  window.WebSocket = class extends OriginalWebSocket {
    constructor(...args) {
      super(...args);
      this.addEventListener("message", (event) => {
        const data = JSON.parse(event.data);
        const state = window.__measurement;
        if (data.action) {
          event.stopImmediatePropagation();
          if (data.action === "ready") state.ready = true;
          if (data.action === "complete") {
            state.complete = true;
            state.candidates = data.candidates;
          }
          if (data.action === "lcp-received") state.acknowledged = true;
        } else if (data.img) {
          state.received++;
          state.finalUrl = data.url;
        }
      });
    }
    send(message) {
      const data = JSON.parse(message);
      if (data.action === "lcp") {
        window.__measurement.lcp = data.lcp;
        window.__measurement.renderKind = data.renderKind;
        window.__measurement.firstXpath = data.xpath;
      }
      return super.send(message);
    }
  };
  const originalDraw = CanvasRenderingContext2D.prototype.drawImage;
  CanvasRenderingContext2D.prototype.drawImage = function (...args) {
    const result = originalDraw.apply(this, args);
    window.__measurement.rendered++;
    return result;
  };
}

async function access(page, url, timeout) {
  await page.evaluate((targetUrl) => {
    window.__measurement = {
      ready: true,
      received: 0,
      rendered: 0,
      complete: false,
      acknowledged: false,
      lcp: null,
    };
    document.getElementById("url-input").value = targetUrl;
    document.getElementById("url-button").click();
  }, url);
  await page.waitForFunction(
    () => {
      const state = window.__measurement;
      return (
        state.complete &&
        state.acknowledged &&
        state.received > 0 &&
        state.rendered === state.received &&
        Number.isFinite(state.lcp)
      );
    },
    { timeout },
  );
  return page.evaluate(() => ({
    lcp: window.__measurement.lcp,
    finalUrl: window.__measurement.finalUrl,
    lcpImages: window.__measurement.received - 1,
    renderKind: window.__measurement.renderKind,
    firstXpath: window.__measurement.firstXpath,
    candidates: window.__measurement.candidates,
  }));
}

async function ensurePortFree() {
  const probe = net.createServer();
  probe.listen(3000, "127.0.0.1");
  await once(probe, "listening");
  await new Promise((resolve) => probe.close(resolve));
}

async function startProxy(database, timeout) {
  const child = spawn(process.execPath, ["dist/server/index.js"], {
    cwd: root,
    detached: true,
    env: {
      ...process.env,
      LCP_EVALUATION: "1",
      LCP_DB_PATH: database,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    await new Promise((resolve, reject) => {
      let logs = "";
      const timer = setTimeout(
        () => reject(new Error(`Proxy startup timed out: ${logs}`)),
        timeout,
      );
      const finish = (error) => {
        clearTimeout(timer);
        child.off("exit", onExit);
        child.off("error", finish);
        if (error) reject(error);
        else resolve();
      };
      const onExit = (code) =>
        finish(new Error(`Proxy exited (${code}): ${logs}`));
      child.once("error", finish);
      child.once("exit", onExit);
      child.stderr.on("data", (chunk) => {
        logs = (logs + chunk).slice(-8000);
      });
      child.stdout.on("data", (chunk) => {
        logs = (logs + chunk).slice(-8000);
        if (logs.includes("App listening on port 3000")) finish();
      });
    });
    return child;
  } catch (error) {
    await stopProxy(child);
    throw error;
  }
}

async function stopProxy(child) {
  if (!child?.pid) return;
  // Only terminate the process group created for this evaluation.
  const signal = (name) => {
    try {
      process.kill(-child.pid, name);
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  };
  if (child.exitCode !== null || child.signalCode !== null) {
    signal("SIGKILL");
    return;
  }
  const exited = once(child, "exit");
  signal("SIGTERM");
  // Puppeteer's SIGTERM handler may close Chrome but leave Express listening.
  const timer = setTimeout(() => signal("SIGKILL"), 3000);
  try {
    await exited;
  } finally {
    clearTimeout(timer);
    signal("SIGKILL");
  }
}

function readCollected(database, url) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(database, sqlite3.OPEN_READONLY);
    db.get(
      `SELECT image_lcp, (SELECT COUNT(*) FROM lcp WHERE url_id = url.id) AS candidates
       FROM url WHERE url = ?`,
      [url],
      (error, row) => {
        db.close();
        if (error) reject(error);
        else if (!row) reject(new Error(`No collected URL: ${url}`));
        else resolve(row);
      },
    );
  });
}

async function main() {
  if (!["on", "off"].includes(values.cache))
    throw new Error("--cache must be on or off.");
  const cacheEnabled = values.cache === "on";
  const urls = JSON.parse(await fs.readFile(path.resolve(values.urls), "utf8"));
  const speeds = values.speeds.split(",").map(Number);
  const timeout = Number(values.timeout);
  if (
    !Array.isArray(urls) ||
    !urls.length ||
    !urls.every((url) => /^https?:\/\//.test(url)) ||
    !speeds.length ||
    !speeds.every((speed) => Number.isFinite(speed) && speed > 0) ||
    !Number.isFinite(timeout) ||
    timeout <= 0
  ) {
    throw new Error("Specify HTTP(S) URLs and positive speeds/timeout.");
  }
  const output = path.resolve(values.output);
  if (path.extname(output) !== ".xlsx") throw new Error("Output must be .xlsx");
  await ensurePortFree();
  await fs.mkdir(path.dirname(output), { recursive: true });
  // Exclusive directory prevents overwriting a previous run or the normal DB.
  const dataDirectory = `${output}.data`;
  await fs.mkdir(dataDirectory);
  const rows = [];
  let browser;
  let activeProxy;
  let failed = false;
  const interrupt = async () => {
    await stopProxy(activeProxy);
    await browser?.close();
    process.exit(130);
  };
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  try {
    browser = await puppeteer.launch({ headless: "new" });
    for (const speed of speeds) {
      for (const url of urls) {
        const row = {
          url,
          speed,
          samples: [],
          status: "running",
          database: path.join(dataDirectory, `${rows.length + 1}.db`),
        };
        rows.push(row);
        let proxy;
        let page;
        try {
          proxy = await startProxy(row.database, timeout);
          activeProxy = proxy;
          page = await browser.newPage();
          page.setDefaultTimeout(timeout);
          await page.setViewport({
            width: 375,
            height: 667,
            deviceScaleFactor: 2,
            isMobile: true,
          });
          await page.setUserAgent(
            "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1",
          );
          await page.setCacheEnabled(false);
          await page.setBypassServiceWorker(true);
          await page.evaluateOnNewDocument(observeClient);
          const cdp = await page.createCDPSession();
          await cdp.send("Network.enable");
          await cdp.send("Network.emulateNetworkConditions", {
            offline: false,
            latency: 0,
            downloadThroughput: (speed * 1000) / 8,
            uploadThroughput: (speed * 1000) / 8,
          });
          await page.goto("http://localhost:3000/", { timeout });
          await page.waitForFunction(() => window.__measurement.ready);
          await page.select("#cache-enabled", values.cache);
          const warmup = await access(page, url, timeout);
          row.warmup = warmup.lcp;
          row.collected = await readCollected(row.database, url);
          for (let trial = 1; trial <= 5; trial++) {
            const sample = await access(page, url, timeout);
            row.samples.push({ trial, access: trial + 1, ...sample });
            console.log(
              `${speed} kbps ${url} access ${trial + 1}: ${sample.lcp.toFixed(1)} ms`,
            );
          }
          row.status = "ok";
        } catch (error) {
          failed = true;
          row.status = error.message;
          console.error(`${speed} kbps ${url}: ${error.message}`);
        } finally {
          await page?.close().catch((error) => console.error(error));
          await stopProxy(proxy);
          activeProxy = undefined;
          await writeReport(output, rows, {
            conditions: [
              ["代理サーバーHTTPキャッシュ", cacheEnabled ? "有効" : "無効"],
              [
                "HTTPキャッシュの保持範囲",
                cacheEnabled
                  ? "URL・通信速度ごとに空の状態で開始し、初回収集から続く5回の測定まで保持。サイトのHTTPキャッシュ指定に従う"
                  : "全6アクセスで利用しない。LCP候補のDBは保持",
              ],
            ],
          });
        }
      }
    }
  } finally {
    await browser?.close();
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
  }
  console.log(`Excel: ${output}`);
  if (failed) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
