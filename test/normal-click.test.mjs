import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { build } from "esbuild";
import puppeteer from "puppeteer";
import sharp from "sharp";
import sqlite3 from "sqlite3";
import { open } from "sqlite";
import WebSocket from "ws";

test(
  "the normal LCP browser forwards scaled Canvas clicks, serializes actions, and updates after navigation",
  { timeout: 45000 },
  async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "normal-click-"));
    const serverFile = path.resolve("dist/normal-tests/server.cjs");
    const clientDirectory = path.join(root, "dist/client");
    await fs.mkdir(clientDirectory, { recursive: true });
    await build({
      entryPoints: ["src/server/index.ts"],
      outfile: serverFile,
      bundle: true,
      platform: "node",
      format: "cjs",
      packages: "external",
      plugins: [
        {
          name: "isolated-test-server",
          setup(builder) {
            builder.onLoad(
              { filter: /src\/server\/index\.ts$/ },
              async (args) => {
                let contents = await fs.readFile(args.path, "utf8");
                // Only the listening address and launch sandbox differ from production.
                contents = contents
                  .replace(
                    "const PORT: number = 3000;",
                    "const PORT: number = 0;",
                  )
                  .replace(
                    "console.log(`App listening on port ${PORT}`);",
                    "console.log(`App listening on port ${server.address().port}`);",
                  );
                if (process.env.EVALUATION_NO_SANDBOX === "1")
                  contents = contents.replace(
                    'args: ["--lang=ja"]',
                    'args: ["--lang=ja", "--no-sandbox"]',
                  );
                return { contents, loader: "ts" };
              },
            );
          },
        },
      ],
    });
    await build({
      entryPoints: ["src/client/index.ts"],
      outfile: path.join(clientDirectory, "index.js"),
      bundle: true,
      platform: "browser",
    });
    await fs.copyFile(
      "src/client/index.html",
      path.join(clientDirectory, "index.html"),
    );
    await fs.copyFile("lcp.js", path.join(root, "lcp.js"));

    let clicked = 0;
    const fixture = http.createServer((req, res) => {
      if (req.url === "/favicon.ico") {
        res.writeHead(204).end();
        return;
      }
      if (req.url === "/clicked") {
        clicked++;
        res.end("ok");
        return;
      }
      res.setHeader("Content-Type", "text/html");
      res.setHeader("Cache-Control", "no-store");
      res.end(
        req.url === "/next"
          ? '<html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body style="margin:0;background:rgb(0,0,200)"><h1>Next page</h1></body></html>'
          : '<html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body style="margin:0;background:white"><h1 id="title" style="position:absolute;left:40px;top:0;font-size:20px">LCP click target</h1><button style="position:absolute;left:40px;top:80px;width:160px;height:60px" onclick="document.body.style.background=\'rgb(0,160,0)\';fetch(\'/clicked\')">Change color</button><a href="/next" style="position:absolute;left:240px;top:80px;width:160px;height:60px">Next page</a></body></html>',
      );
    });
    await new Promise((resolve) => fixture.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${fixture.address().port}`;
    const child = spawn(process.execPath, [serverFile], {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let browser;
    let db;
    let raw;
    let log = "";
    child.stderr.on("data", (chunk) => {
      log += chunk;
    });
    try {
      const port = await new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("Normal server startup timed out: " + log)),
          15000,
        );
        child.once("exit", (code) => {
          clearTimeout(timer);
          reject(new Error(`Normal server exited (${code}): ${log}`));
        });
        let output = "";
        child.stdout.on("data", (chunk) => {
          output += chunk;
          const match = output.match(/App listening on port (\d+)/);
          if (match) {
            clearTimeout(timer);
            resolve(Number(match[1]));
          }
        });
      });

      // Send image + click back-to-back: the initial screenshot must precede the click update.
      raw = new WebSocket(`ws://127.0.0.1:${port}`);
      const frames = [];
      raw.on("message", (data) => frames.push(JSON.parse(data.toString())));
      await once(raw, "open");
      raw.send("{");
      raw.send(
        JSON.stringify({
          action: "init",
          width: 500,
          height: 400,
          userAgent: "Normal click test",
        }),
      );
      raw.send(JSON.stringify({ action: "image", url: origin + "/queue" }));
      raw.send(JSON.stringify({ action: "click", x: 100, y: 100 }));
      const deadline = Date.now() + 10000;
      while (frames.length < 2 && Date.now() < deadline) await delay(20);
      assert.equal(frames.length, 2, log);
      for (const [index, expected] of [
        [0, [255, 255, 255]],
        [1, [0, 160, 0]],
      ]) {
        const pixel = await sharp(Buffer.from(frames[index].img.data))
          .extract({ left: 10, top: 200, width: 1, height: 1 })
          .removeAlpha()
          .raw()
          .toBuffer();
        expected.forEach((value, channel) =>
          assert.ok(Math.abs(pixel[channel] - value) < 20),
        );
      }
      assert.equal(clicked, 1);
      raw.close();
      raw = null;

      browser = await puppeteer.launch({
        headless: "new",
        args: process.env.EVALUATION_NO_SANDBOX === "1" ? ["--no-sandbox"] : [],
      });
      const page = await browser.newPage();
      await page.setViewport({
        width: 1000,
        height: 900,
        deviceScaleFactor: 2,
        hasTouch: true,
      });
      await page.evaluateOnNewDocument(() => {
        window.__sent = [];
        window.__frames = [];
        window.__draws = 0;
        const NativeSocket = WebSocket;
        window.WebSocket = class extends NativeSocket {
          constructor(...args) {
            super(...args);
            this.addEventListener("message", (event) =>
              window.__frames.push(JSON.parse(event.data)),
            );
          }
          send(data) {
            window.__sent.push(JSON.parse(data));
            super.send(data);
          }
        };
        const draw = CanvasRenderingContext2D.prototype.drawImage;
        CanvasRenderingContext2D.prototype.drawImage = function (...args) {
          const result = draw.apply(this, args);
          window.__draws++;
          return result;
        };
      });
      await page.goto(`http://127.0.0.1:${port}/`);
      await page.waitForFunction(() =>
        window.__sent.some((message) => message.action === "init"),
      );
      const url = origin + "/interactive";
      await page.$eval(
        "#url-input",
        (element, value) => {
          element.value = value;
        },
        url,
      );
      await page.click("#url-button");
      await page.waitForFunction(() => window.__draws >= 1);
      db = await open({
        filename: path.join(root, "json.db"),
        driver: sqlite3.Database,
      });
      const metricDeadline = Date.now() + 5000;
      let saved;
      do {
        saved = await db.get("SELECT * FROM url WHERE url = ?", url);
        if (saved?.image_lcp >= 0) break;
        await delay(20);
      } while (Date.now() < metricDeadline);
      assert.ok(saved?.image_lcp >= 0);
      const candidates = await db.get(
        "SELECT COUNT(*) AS count FROM lcp WHERE url_id = ?",
        saved.id,
      );
      assert.ok(
        candidates.count > 0,
        "the click test must exercise actual LCP candidate rendering",
      );
      await db.run("UPDATE url SET image_lcp = 5000 WHERE url = ?", url);
      const previous = await page.evaluate(() => ({
        frames: window.__frames.length,
        draws: window.__draws,
      }));
      await page.click("#url-button");
      await page.waitForFunction(
        (before, count) => window.__draws >= before.draws + count + 1,
        {},
        previous,
        candidates.count,
      );
      const lcpFrames = await page.evaluate(
        (before) => window.__frames.slice(before.frames),
        previous,
      );
      assert.ok(lcpFrames.some((frame) => frame.x > 0 || frame.y > 0));

      async function clickCanvas(x, y, touch = false) {
        const point = await page.$eval(
          "#browser",
          (canvas, point) => {
            const rect = canvas.getBoundingClientRect();
            return {
              x: rect.left + (point.x * rect.width) / canvas.width,
              y: rect.top + (point.y * rect.height) / canvas.height,
            };
          },
          { x, y },
        );
        if (touch) await page.touchscreen.tap(point.x, point.y);
        else await page.mouse.click(point.x, point.y);
      }
      const beforeClick = await page.evaluate(() => window.__draws);
      await clickCanvas(100, 100, true);
      await page.waitForFunction(
        // The legacy touch handler also sends a zero-distance scroll update.
        (before) => window.__draws >= before + 2,
        {},
        beforeClick,
      );
      const click = await page.evaluate(() =>
        window.__sent.filter((message) => message.action === "click").at(-1),
      );
      assert.ok(Math.abs(click.x - 100) < 1 && Math.abs(click.y - 100) < 1);
      assert.equal(clicked, 2);
      const green = await page.$eval("#browser", (canvas) => [
        ...canvas.getContext("2d").getImageData(10, 200, 1, 1).data,
      ]);
      assert.ok(green[1] > 130 && green[0] < 20 && green[2] < 20);
      const beforeNavigation = await page.evaluate(() => window.__draws);
      await clickCanvas(280, 100);
      await page.waitForFunction(
        (before) =>
          window.__draws > before &&
          document.querySelector("#url-input").value.endsWith("/next"),
        {},
        beforeNavigation,
      );
      const blue = await page.$eval("#browser", (canvas) => [
        ...canvas.getContext("2d").getImageData(10, 200, 1, 1).data,
      ]);
      assert.ok(blue[2] > 170 && blue[0] < 20 && blue[1] < 20);
    } finally {
      raw?.terminate();
      await db?.close();
      await browser?.close();
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit");
        child.kill("SIGINT");
        await exited;
      }
      await new Promise((resolve) => fixture.close(resolve));
      await fs.rm(root, { recursive: true, force: true });
    }
  },
);
