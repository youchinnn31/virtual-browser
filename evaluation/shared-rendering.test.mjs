import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import test from "node:test";
import { build } from "esbuild";
import puppeteer from "puppeteer";
import sharp from "sharp";
import WebSocket from "ws";

test(
  "normal server and tablet worker produce identical collected, resized, and skipped frames",
  { timeout: 60000 },
  async () => {
    await build({
      entryPoints: ["src/server/evaluation/worker.ts"],
      outfile: "dist/test/shared-worker.cjs",
      bundle: true,
      platform: "node",
      packages: "external",
    });
    const { TabletWorker } = createRequire(import.meta.url)(
      "../dist/test/shared-worker.cjs",
    );
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), "shared-render-"),
    );
    const visits = new Map();
    let sessions = 0;
    const fixture = http.createServer((req, res) => {
      if (req.url !== "/") {
        res.writeHead(204).end();
        return;
      }
      const id = req.headers.cookie ?? `session=${++sessions}`;
      res.setHeader("Set-Cookie", id);
      visits.set(id, (visits.get(id) ?? 0) + 1);
      res.setHeader("Content-Type", "text/html");
      res.end(`<!doctype html><style>body{margin:0}h1{margin:0;height:70px}</style>
        <h1 id="hero" style="${visits.get(id) === 3 ? "display:none" : ""}">Shared renderer</h1>
        <canvas width="640" height="480"></canvas>
        <script>
          const ctx = document.querySelector('canvas').getContext('2d');
          const image = ctx.createImageData(640, 480);
          let seed = 123456789;
          for (let i = 0; i < image.data.length; i++) {
            seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
            image.data[i] = i % 4 === 3 ? 255 : seed & 255;
          }
          ctx.putImageData(image, 0, 0);
        </script>`);
    });
    fixture.listen(0, "127.0.0.1");
    await once(fixture, "listening");
    const child = spawn(process.execPath, ["dist/server/index.js"], {
      detached: true,
      env: {
        ...process.env,
        LCP_EVALUATION: "1",
        LCP_DB_PATH: path.join(directory, "normal.db"),
        TABLET_RESULTS_DIR: path.join(directory, "results"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let logs = "";
    child.stderr.on("data", (data) => (logs += data));
    let browser;
    let worker;
    let socket;
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(logs)), 15000);
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
      browser = await puppeteer.launch({
        headless: "new",
        args: ["--lang=ja", "--no-proxy-server"],
      });
      socket = new WebSocket("ws://127.0.0.1:3000/");
      await once(socket, "open");
      function request(message, action) {
        return new Promise((resolve, reject) => {
          const frames = [];
          const timer = setTimeout(() => {
            socket.off("message", receive);
            reject(new Error(`Timed out waiting for ${action}: ${logs}`));
          }, 15000);
          function receive(raw) {
            const value = JSON.parse(raw.toString());
            if (value.img) frames.push(value);
            if (value.action === action) {
              clearTimeout(timer);
              socket.off("message", receive);
              resolve({ frames, ...value });
            }
          }
          socket.on("message", receive);
          socket.send(JSON.stringify(message));
        });
      }
      const device = {
        name: "parity fixture",
        userAgent: await browser.userAgent(),
        width: 800,
        height: 600,
        dpr: 1,
        orientation: "landscape",
      };
      await request({ action: "init", ...device }, "ready");
      const url = `http://127.0.0.1:${fixture.address().port}/`;
      worker = await TabletWorker.open(
        browser,
        path.join(directory, "tablet.db"),
        url,
        device,
      );
      let collected;
      for (let access = 0; access < 3; access++) {
        const normal = await request({ action: "image", url }, "complete");
        const frames = [];
        const evaluated = await worker.render(access, (frame) =>
          frames.push(frame),
        );
        assert.deepEqual(
          normal.frames.map((frame) => ({
            ...frame,
            img: Buffer.from(frame.img.data),
          })),
          frames,
          `Frame bytes and geometry must match on access ${access + 1}`,
        );
        assert.deepEqual(
          normal.candidates.map(({ xpath, status }) => ({ xpath, status })),
          evaluated.candidates.map(({ xpath, status }) => ({ xpath, status })),
        );
        assert.ok(frames.every((frame) => frame.img.length <= 64000));
        const viewport = frames.at(-1);
        assert.equal(viewport.kind, "viewport");
        assert.ok((await sharp(viewport.img).metadata()).width < device.width);
        if (access === 0) {
          collected = evaluated.collected.candidates;
          assert.ok(collected > 0);
          assert.equal(frames.length, 1);
          await request({ action: "lcp", lcp: 1234 }, "lcp-received");
          await worker.saveInitial(1234);
        } else {
          assert.equal(evaluated.collected.candidates, collected);
          assert.ok(
            evaluated.candidates.every(
              (candidate) =>
                candidate.status ===
                (access === 2 ? "no-bounding-box" : "sent"),
            ),
          );
        }
      }
      assert.deepEqual([...visits.values()], [3, 3]);
    } finally {
      socket?.terminate();
      await worker?.close();
      await browser?.close();
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit");
        process.kill(-child.pid, "SIGTERM");
        const timer = setTimeout(() => {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {
            /* Already exited. */
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
