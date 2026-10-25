import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import ExcelJS from "exceljs";
import sqlite3 from "sqlite3";
import { median, writeReport } from "./report.mjs";

test("median excludes incomplete runs and Excel preserves numeric samples", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "lcp-report-"));
  const samples = [50, 10, 30, 20, 40].map((lcp, i) => ({
    lcp,
    trial: i + 1,
    access: i + 2,
  }));
  assert.equal(median(samples), 30);
  assert.equal(median(samples.slice(0, 4)), null);
  const output = path.join(directory, "report.xlsx");
  await writeReport(output, [
    { url: "http://test/", speed: 128, samples, status: "ok", warmup: 9999 },
    {
      url: "http://test/",
      speed: 128,
      samples: samples.slice(0, 4),
      status: "failed",
    },
  ]);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(output);
  assert.equal(workbook.getWorksheet("中央値").getCell("C2").value, 30);
  assert.equal(workbook.getWorksheet("中央値").getCell("C3").value, null);
  assert.equal(workbook.getWorksheet("中央値").getCell("I2").value, 9999);
});

test(
  "crawl collects once, measures five uncached visits, and exports median",
  { timeout: 90000 },
  async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "lcp-crawl-"));
    let visits = 0;
    let images = 0;
    const fixture = http.createServer((req, res) => {
      res.setHeader("Cache-Control", "public, max-age=3600");
      if (req.url === "/") {
        visits++;
        res.writeHead(302, { Location: `/page?visit=${visits}` });
        res.end();
      } else if (req.url.startsWith("/page?")) {
        setTimeout(() => {
          res.setHeader("Content-Type", "text/html");
          res.end(
            '<h1 style="font-size:24px">LCP test</h1><img src="/image.svg" width="160" height="100">',
          );
        }, 0);
      } else if (req.url === "/image.svg") {
        images++;
        res.setHeader("Content-Type", "image/svg+xml");
        setTimeout(
          () =>
            res.end(
              '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="100"><rect width="160" height="100" fill="blue"/></svg>',
            ),
          150,
        );
      } else {
        res.statusCode = 404;
        res.end();
      }
    });
    fixture.listen(0, "127.0.0.1");
    await once(fixture, "listening");
    const url = `http://127.0.0.1:${fixture.address().port}/`;
    const urls = path.join(directory, "urls.json");
    const output = path.join(directory, "result.xlsx");
    await fs.writeFile(urls, JSON.stringify([url]));
    const child = spawn(
      process.execPath,
      [
        "evaluation/repeat.mjs",
        "--urls",
        urls,
        "--speeds",
        "1024",
        "--output",
        output,
        "--timeout",
        "20000",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let logs = "";
    child.stdout.on("data", (data) => {
      logs += data;
    });
    child.stderr.on("data", (data) => {
      logs += data;
    });
    try {
      const [code] = await once(child, "exit");
      assert.equal(code, 0, logs);
      assert.equal(visits, 6, "HTTP document cache must be disabled");
      assert.equal(images, 6, "HTTP image cache must be disabled");
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.readFile(output);
      const summary = workbook.getWorksheet("中央値");
      const details = workbook.getWorksheet("測定値");
      assert.equal(details.rowCount, 6);
      for (let i = 2; i <= 6; i++) {
        assert.equal(
          details.getRow(i).getCell(7).value,
          `${url}page?visit=${i}`,
        );
      }
      const samples = [4, 5, 6, 7, 8].map(
        (column) => summary.getRow(2).getCell(column).value,
      );
      assert.ok(
        samples.every((sample) => typeof sample === "number" && sample > 0),
      );
      assert.equal(
        summary.getCell("C2").value,
        [...samples].sort((a, b) => a - b)[2],
      );
      assert.ok(summary.getCell("I2").value < 4000);
      assert.ok(summary.getCell("J2").value > 0);
      for (let i = 2; i <= 6; i++) {
        assert.equal(details.getRow(i).getCell(4).value, i);
        assert.ok(
          details.getRow(i).getCell(6).value > 0,
          "LCP partial images were rendered",
        );
      }
      await new Promise((resolve, reject) => {
        const db = new sqlite3.Database(path.join(`${output}.data`, "1.db"));
        db.get(
          "SELECT access_num, image_lcp, (SELECT COUNT(*) FROM url) AS urls, (SELECT COUNT(*) FROM lcp) AS candidates FROM url WHERE url = ?",
          [url],
          (error, row) => {
            db.close();
            if (error) return reject(error);
            try {
              assert.equal(row.access_num, 7);
              assert.equal(row.urls, 1);
              assert.equal(
                row.candidates,
                summary.getCell("J2").value,
                "Only the initial visit may save LCP candidates",
              );
              assert.equal(row.image_lcp, summary.getCell("I2").value);
              resolve();
            } catch (failure) {
              reject(failure);
            }
          },
        );
      });
      console.log(`Validated workbook: ${output}`);
    } finally {
      child.kill();
      fixture.closeAllConnections();
      await new Promise((resolve) => fixture.close(resolve));
    }
  },
);
