import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import WebSocket from "ws";

async function startServer(root) {
  const child = spawn(process.execPath, ["dist/evaluation/server/index.js"], {
    env: { ...process.env, EVALUATION_PORT: "0", EVALUATION_RESULTS_DIR: root },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  child.stderr.on("data", (chunk) => {
    logs += chunk;
  });
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("Server startup timed out: " + logs));
    }, 15000);
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Server exited (${code}): ${logs}`));
    });
    let lines = "";
    child.stdout.on("data", (chunk) => {
      lines += chunk;
      for (const line of lines.split("\n")) {
        if (!line.includes('"evaluation:listening"')) continue;
        clearTimeout(timer);
        resolve(JSON.parse(line).port);
      }
    });
  });
  return {
    port,
    async close() {
      if (child.exitCode !== null) return;
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      await exited;
    },
  };
}

async function runClient(port, config, options = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const messages = [];
  const trials = new Map();
  const finished = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      ws.terminate();
      reject(new Error("Test client timed out"));
    }, 90000);
    ws.on("error", reject);
    ws.on("message", (raw) => {
      void (async () => {
        const message = JSON.parse(raw.toString());
        messages.push(message);
        if (message.action === "error") throw new Error(message.error);
        if (message.action === "profile:required") {
          ws.send(
            JSON.stringify(
              options.abortAtProfile
                ? { action: "run:abort", reason: "test_abort" }
                : {
                    action: "profile:confirmed",
                    runId: message.runId,
                    profileIndex: message.profileIndex,
                  },
            ),
          );
        }
        if (message.action === "trial:ready") {
          if (options.injectStaleMessage && trials.size > 0) {
            ws.send(
              JSON.stringify({
                action: "trial:error",
                trialId: [...trials.keys()].at(-1),
                error: "late_previous_trial_error",
              }),
            );
          }
          trials.set(message.trialId, { ...message, images: [] });
          ws.send(
            JSON.stringify({ action: "trial:start", trialId: message.trialId }),
          );
        }
        if (message.action === "trial:image") {
          const trial = trials.get(message.trialId);
          trial.images.push(message);
          if (trial.phase === "revisit" && message.kind === "viewport") {
            assert.equal(
              trial.lcpAcknowledged,
              true,
              "viewport must wait for the LCP drawing acknowledgement",
            );
            if (options.failViewport) {
              ws.send(
                JSON.stringify({
                  action: "trial:error",
                  trialId: message.trialId,
                  error: "test_viewport_failed",
                }),
              );
            }
          }
          if (trial.images.length === 1) {
            ws.send(
              JSON.stringify({
                action: "trial:metric",
                trialId: message.trialId,
                firstImageMs:
                  trial.phase === "initial" ? 1 : trial.visitIndex * 100,
                firstImageIndex: message.imageIndex,
              }),
            );
          }
        }
        if (
          message.action === "trial:images-end" &&
          !options.withholdCompletion
        ) {
          const trial = trials.get(message.trialId);
          assert.equal(trial.images.length, message.imageCount);
          if (message.kind === "lcp") {
            assert.ok(trial.images.every((image) => image.kind === "lcp"));
            if (options.withholdLcpCompletion) return;
          }
          if (message.kind === "lcp" && trial.visitIndex === 1) {
            const readyCount = messages.filter(
              (item) => item.action === "trial:ready",
            ).length;
            await delay(100);
            assert.equal(
              messages.filter((item) => item.action === "trial:ready").length,
              readyCount,
              "must wait for every image to be displayed, not just the first metric",
            );
            assert.ok(
              trial.images.every((image) => image.kind === "lcp"),
              "no viewport may be sent while LCP drawing is pending",
            );
          }
          if (message.kind === "lcp") {
            trial.lcpAcknowledged = true;
            ws.send(
              JSON.stringify({
                action: "trial:lcp-complete",
                trialId: message.trialId,
                renderedCount: message.imageCount,
                lcpImagesMs: trial.visitIndex * 100 + 10,
              }),
            );
            return;
          }
          if (options.failViewport && trial.phase === "revisit") return;
          ws.send(
            JSON.stringify({
              action: "trial:complete",
              trialId: message.trialId,
              renderedCount: message.imageCount,
              viewportMs:
                trial.phase === "initial" ? 2 : trial.visitIndex * 100 + 40,
            }),
          );
        }
        if (message.action === "run:finished") {
          clearTimeout(timeout);
          resolve({ messages, trials, finished: message });
        }
      })().catch((error) => {
        clearTimeout(timeout);
        ws.terminate();
        reject(error);
      });
    });
  });
  try {
    await once(ws, "open");
    ws.send(
      JSON.stringify({
        action: "run:start",
        config,
        device: {
          width: 375,
          height: 600,
          devicePixelRatio: 2,
          userAgent: "Mobile evaluation integration test",
        },
      }),
    );
    return await finished;
  } finally {
    ws.close();
  }
}

test(
  "standalone evaluation server preserves first/revisit boundaries, rendering completion, and partial results",
  { timeout: 120000 },
  async (t) => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "evaluation-integration-"),
    );
    const visits = new Map();
    const fixture = http.createServer((req, res) => {
      const url = req.url;
      res.setHeader("Cache-Control", "no-store");
      if (url === "/favicon.ico") {
        res.writeHead(204).end();
        return;
      }
      if (url === "/hero.svg") {
        setTimeout(() => {
          res.setHeader("Content-Type", "image/svg+xml");
          res.end(
            '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="200"><rect width="300" height="200" fill="navy"/><circle cx="150" cy="100" r="70" fill="orange"/></svg>',
          );
        }, 100);
        return;
      }
      const visit = (visits.get(url) ?? 0) + 1;
      visits.set(url, visit);
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      if (url === "/missing") {
        res.end(
          `<html><body><h1 id="${visit === 1 ? "initial-only" : "replacement"}">Visible content</h1></body></html>`,
        );
      } else {
        res.end(
          '<html><body><h1 id="heading">Title</h1><img id="hero" width="300" height="200" src="/hero.svg"></body></html>',
        );
      }
    });
    await new Promise((resolve) => fixture.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${fixture.address().port}`;
    let server;
    try {
      server = await startServer(root);
      assert.equal(
        (await fetch(`http://127.0.0.1:${server.port}/health`)).status,
        200,
      );
      await t.test(
        "n=5 runs six visits per evaluation and excludes the viewport value from the median",
        async () => {
          const result = await runClient(
            server.port,
            {
              urls: [origin + "/a", origin + "/b"],
              profiles: ["128kbps", "1024kbps"],
              revisitCount: 5,
              trialTimeoutMs: 20000,
            },
            { injectStaleMessage: true },
          );
          assert.equal(result.finished.status, "completed");
          assert.equal(result.trials.size, 24);
          for (const trial of result.trials.values()) {
            assert.ok(trial.images.length > 0);
            assert.equal(trial.images.at(-1).kind, "viewport");
            assert.equal(trial.images.at(-1).xpath, null);
            if (trial.phase === "initial") assert.equal(trial.images.length, 1);
            else {
              assert.ok(trial.images.length >= 2);
              assert.ok(
                trial.images
                  .slice(0, -1)
                  .every(
                    (image) => image.kind === "lcp" && image.xpath !== null,
                  ),
              );
            }
          }
          const summaries = result.messages.filter(
            (message) => message.action === "evaluation:complete",
          );
          assert.equal(summaries.length, 4);
          assert.ok(
            summaries.every(
              (message) =>
                message.summary.medianMs === 300 &&
                message.summary.successfulCount === 5 &&
                message.summary.viewportMedianMs === 340 &&
                message.summary.viewportSuccessfulCount === 5,
            ),
          );
          const summaryFile = await fetch(
            `http://127.0.0.1:${server.port}/results/${result.finished.runId}/summary.csv`,
          );
          assert.equal(summaryFile.status, 200);
          assert.equal(
            (await summaryFile.text()).trim().split("\r\n").length,
            5,
          );
        },
      );
      await t.test(
        "missing DOM never falls back to viewport rendering",
        async () => {
          const result = await runClient(server.port, {
            urls: [origin + "/missing"],
            profiles: ["test"],
            revisitCount: 2,
            trialTimeoutMs: 20000,
          });
          const revisits = result.messages.filter(
            (message) =>
              message.action === "trial:saved" &&
              message.result.phase === "revisit",
          );
          assert.equal(revisits.length, 2);
          assert.ok(
            revisits.every(
              (message) =>
                message.result.status === "failed" &&
                message.result.error === "no_matching_lcp_element" &&
                message.result.imageCount === 0,
            ),
          );
          assert.equal(
            result.messages.find(
              (message) => message.action === "evaluation:complete",
            ).summary.medianMs,
            null,
          );
        },
      );
      await t.test(
        "the deadline also covers remaining images after receiving a first-image metric",
        async () => {
          const result = await runClient(
            server.port,
            {
              urls: [origin + "/timeout"],
              profiles: ["test"],
              revisitCount: 1,
              trialTimeoutMs: 2500,
            },
            { withholdCompletion: true },
          );
          const initial = result.messages.find(
            (message) =>
              message.action === "trial:saved" &&
              message.result.phase === "initial",
          ).result;
          assert.equal(initial.status, "failed");
          assert.equal(initial.firstImageMs, 1);
          assert.equal(initial.allImagesMs, null);
          assert.equal(initial.error, "trial_timeout");
          assert.equal(
            result.messages.find(
              (message) =>
                message.action === "trial:saved" &&
                message.result.phase === "revisit",
            ).result.status,
            "skipped",
          );
        },
      );
      await t.test(
        "viewport failure retains the independently completed LCP measurement",
        async () => {
          const result = await runClient(
            server.port,
            {
              urls: [origin + "/viewport-failure"],
              profiles: ["test"],
              revisitCount: 1,
              trialTimeoutMs: 20000,
            },
            { failViewport: true },
          );
          const revisit = result.messages.find(
            (message) =>
              message.action === "trial:saved" &&
              message.result.phase === "revisit",
          ).result;
          assert.equal(revisit.status, "failed");
          assert.equal(revisit.firstImageMs, 100);
          assert.equal(revisit.lcpImagesMs, 110);
          assert.equal(revisit.viewportMs, null);
          const summary = result.messages.find(
            (message) => message.action === "evaluation:complete",
          ).summary;
          assert.equal(summary.medianMs, 100);
          assert.equal(summary.successfulCount, 1);
          assert.equal(summary.viewportMedianMs, null);
          assert.equal(summary.viewportSuccessfulCount, 0);
        },
      );
      await t.test(
        "a missing LCP completion acknowledgement never starts viewport rendering",
        async () => {
          const result = await runClient(
            server.port,
            {
              urls: [origin + "/lcp-timeout"],
              profiles: ["test"],
              revisitCount: 1,
              trialTimeoutMs: 2500,
            },
            { withholdLcpCompletion: true },
          );
          const trial = [...result.trials.values()].find(
            (item) => item.phase === "revisit",
          );
          assert.ok(trial.images.length > 0);
          assert.ok(trial.images.every((image) => image.kind === "lcp"));
          const revisit = result.messages.find(
            (message) =>
              message.action === "trial:saved" &&
              message.result.phase === "revisit",
          ).result;
          assert.equal(revisit.error, "trial_timeout");
          assert.equal(revisit.lcpImagesMs, null);
          assert.equal(revisit.viewportMs, null);
        },
      );
      await t.test(
        "manual Charles confirmation has no timeout, and an aborted run still exports results",
        async () => {
          const result = await runClient(
            server.port,
            {
              urls: [origin + "/abort"],
              profiles: ["test"],
              revisitCount: 1,
              trialTimeoutMs: 1000,
            },
            { abortAtProfile: true },
          );
          assert.equal(result.finished.status, "aborted");
          assert.equal(result.trials.size, 0);
          await fs.access(
            path.join(root, result.finished.runId, "evaluation.sqlite"),
          );
          await fs.access(
            path.join(root, result.finished.runId, "summary.csv"),
          );
        },
      );
    } finally {
      await server?.close();
      await new Promise((resolve) => fixture.close(resolve));
      await fs.rm(root, { recursive: true, force: true });
    }
  },
);
