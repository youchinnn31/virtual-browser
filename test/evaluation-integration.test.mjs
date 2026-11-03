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

async function startServer(root, cwd = process.cwd()) {
  const env = { ...process.env, EVALUATION_PORT: "0" };
  if (root === undefined) delete env.EVALUATION_RESULTS_DIR;
  else env.EVALUATION_RESULTS_DIR = root;
  const child = spawn(
    process.execPath,
    [path.resolve("dist/evaluation/server/index.js")],
    {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let logs = "";
  child.stderr.on("data", (chunk) => {
    logs += chunk;
  });
  const address = await new Promise((resolve, reject) => {
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
        resolve(JSON.parse(line));
      }
    });
  });
  return {
    port: address.port,
    resultsDirectory: address.resultsDirectory,
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
  let timeout;
  const finished = new Promise((resolve, reject) => {
    timeout = setTimeout(() => {
      ws.terminate();
      reject(new Error("Test client timed out"));
    }, 90000);
    ws.on("error", reject);
    ws.on("message", (raw) => {
      void (async () => {
        const message = JSON.parse(raw.toString());
        messages.push(message);
        if (message.action === "error") throw new Error(message.error);
        options.onMessage?.(message, messages);
        if (message.action === "profile:required") {
          if (options.profileDelayMs) await delay(options.profileDelayMs);
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
          assert.equal(message.kind, "viewport");
          assert.equal(message.imageIndex, 1);
          if (options.failWarmup && trial.phase === "warmup") {
            ws.send(
              JSON.stringify({
                action: "trial:error",
                trialId: trial.trialId,
                error: "image_decode_failed",
              }),
            );
          }
        }
        if (message.action === "trial:images-end") {
          const trial = trials.get(message.trialId);
          assert.equal(message.imageCount, 1);
          assert.equal(trial.images.length, 1);
          if (
            (options.failWarmup && trial.phase === "warmup") ||
            (options.withholdMeasurementCompletion &&
              trial.phase === "measurement")
          )
            return;
          if (
            options.delayCompletion &&
            trial.phase === "measurement" &&
            trial.measurementIndex === 1
          ) {
            const readyCount = messages.filter(
              (item) => item.action === "trial:ready",
            ).length;
            await delay(100);
            assert.equal(
              messages.filter((item) => item.action === "trial:ready").length,
              readyCount,
              "the next access must wait for the viewport draw acknowledgement",
            );
          }
          ws.send(
            JSON.stringify({
              action: "trial:complete",
              trialId: trial.trialId,
              renderedCount:
                options.invalidCount && trial.phase === "measurement" ? 2 : 1,
              viewportMs:
                trial.phase === "warmup" ? 99999 : trial.measurementIndex * 100,
            }),
          );
        }
        if (message.action === "run:finished")
          resolve({ messages, trials, finished: message });
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
          userAgent: "Mobile viewport evaluation integration test",
        },
      }),
    );
    return await finished;
  } finally {
    clearTimeout(timeout);
    ws.close();
  }
}

test(
  "viewport evaluation waits for networkidle2, excludes warmup, and preserves trial boundaries and results",
  { timeout: 120000 },
  async (t) => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "viewport-integration-"),
    );
    const accesses = [];
    const visits = new Map();
    let holdEnabled = false;
    let held = [];
    let holdReady;
    function releaseHeld() {
      holdEnabled = false;
      for (const res of held)
        if (!res.destroyed && !res.writableEnded) res.end("ready");
      held = [];
    }
    const fixture = http.createServer((req, res) => {
      res.setHeader("Cache-Control", "no-store");
      if (req.url === "/favicon.ico") {
        res.writeHead(204).end();
        return;
      }
      if (req.url.startsWith("/held?")) {
        if (holdEnabled) {
          held.push(res);
          if (held.length === 3) holdReady?.();
        } else res.end("ready");
        return;
      }
      const visit = (visits.get(req.url) ?? 0) + 1;
      visits.set(req.url, visit);
      accesses.push({ url: req.url, cookie: req.headers.cookie ?? "" });
      res.setHeader("Set-Cookie", "evaluation_seen=1; Path=/");
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      if (req.url === "/network-idle") {
        res.end(
          '<html><body><h1>Viewport</h1><script>Promise.all([0,1,2].map(i => fetch("/held?i="+i).then(res => res.text()))).then(() => document.querySelector("h1").textContent="Ready")</script></body></html>',
        );
      } else {
        res.end(
          `<html><body><h1 id="${visit === 1 ? "original" : "changed"}">Viewport ${visit}</h1><script>console.trace("unrelated trace")</script></body></html>`,
        );
      }
    });
    await new Promise((resolve) => fixture.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${fixture.address().port}`;
    let server;
    try {
      server = await startServer(root, root);
      assert.equal(server.resultsDirectory, root);
      await t.test(
        "default output stays in the project's viewport folder from another working directory",
        async () => {
          const defaults = await startServer(undefined, root);
          try {
            assert.equal(
              defaults.resultsDirectory,
              path.resolve("evaluation/results/viewport"),
            );
          } finally {
            await defaults.close();
          }
        },
      );
      await t.test(
        "one warmup plus n=5 measurements sends one viewport per access and isolates each evaluation",
        async () => {
          const result = await runClient(
            server.port,
            {
              urls: [origin + "/a", origin + "/b"],
              profiles: ["128kbps", "1024kbps"],
              measurementCount: 5,
              trialTimeoutMs: 20000,
            },
            { injectStaleMessage: true, delayCompletion: true },
          );
          assert.equal(result.finished.status, "completed");
          assert.equal(result.trials.size, 24);
          for (const trial of result.trials.values()) {
            assert.equal(trial.images.length, 1);
            assert.equal(trial.images[0].kind, "viewport");
            assert.equal(trial.images[0].x, 0);
            assert.equal(trial.images[0].y, 0);
          }
          const warmups = [...result.trials.values()].filter(
            (trial) => trial.phase === "warmup",
          );
          assert.equal(warmups.length, 4);
          assert.ok(warmups.every((trial) => trial.measurementIndex === 0));
          const summaries = result.messages.filter(
            (message) => message.action === "evaluation:complete",
          );
          assert.equal(summaries.length, 4);
          assert.ok(
            summaries.every(
              (message) =>
                message.summary.viewportMedianMs === 300 &&
                message.summary.successfulCount === 5 &&
                message.summary.method === "viewport",
            ),
          );
          const created = result.messages.find(
            (message) => message.action === "run:created",
          );
          assert.equal(
            created.resultsDirectory,
            path.join(root, result.finished.runId),
          );
          const csv = await fetch(
            `http://127.0.0.1:${server.port}/results/${result.finished.runId}/summary.csv`,
          );
          assert.equal(csv.status, 200);
          assert.equal((await csv.text()).trim().split("\r\n").length, 5);
          await fs.access(
            path.join(created.resultsDirectory, "measurements.csv"),
          );
          const recorded = accesses.filter((access) =>
            ["/a", "/b"].includes(access.url),
          );
          assert.equal(recorded.length, 24);
          for (let i = 0; i < recorded.length; i += 6) {
            assert.equal(recorded[i].cookie, "");
            assert.ok(
              recorded
                .slice(i + 1, i + 6)
                .every((access) => access.cookie.includes("evaluation_seen=1")),
            );
          }
        },
      );
      await t.test(
        "no viewport image is sent while three requests prevent networkidle2",
        async () => {
          holdEnabled = true;
          const pending = new Promise((resolve) => {
            holdReady = resolve;
          });
          const messages = [];
          const running = runClient(
            server.port,
            {
              urls: [origin + "/network-idle"],
              profiles: ["test"],
              measurementCount: 1,
              trialTimeoutMs: 20000,
            },
            { onMessage: (message) => messages.push(message) },
          );
          void running.catch(() => undefined);
          try {
            await pending;
            await delay(650);
            assert.equal(
              messages.filter((message) => message.action === "trial:image")
                .length,
              0,
            );
          } finally {
            releaseHeld();
          }
          const result = await running;
          assert.equal(
            result.trials.size,
            2,
            JSON.stringify(
              result.messages.filter(
                (message) => message.action === "trial:saved",
              ),
            ),
          );
          assert.equal(result.finished.status, "completed");
        },
      );
      await t.test(
        "missing final acknowledgement times out and skips the remaining measurements",
        async () => {
          const result = await runClient(
            server.port,
            {
              urls: [origin + "/timeout"],
              profiles: ["test"],
              measurementCount: 2,
              trialTimeoutMs: 2500,
            },
            { withholdMeasurementCompletion: true },
          );
          const rows = result.messages
            .filter((message) => message.action === "trial:saved")
            .map((message) => message.result);
          assert.equal(rows[0].phase, "warmup");
          assert.equal(rows[0].status, "success");
          assert.equal(rows[1].error, "trial_timeout");
          assert.equal(rows[1].viewportMs, null);
          assert.equal(rows[2].status, "skipped");
          assert.equal(
            result.messages.find(
              (message) => message.action === "evaluation:complete",
            ).summary.viewportMedianMs,
            null,
          );
        },
      );
      await t.test(
        "a failed warmup is recorded and excludes all subsequent measurements",
        async () => {
          const result = await runClient(
            server.port,
            {
              urls: [origin + "/decode-error"],
              profiles: ["test"],
              measurementCount: 2,
              trialTimeoutMs: 20000,
            },
            { failWarmup: true },
          );
          const rows = result.messages
            .filter((message) => message.action === "trial:saved")
            .map((message) => message.result);
          assert.equal(rows[0].error, "image_decode_failed");
          assert.ok(
            rows
              .slice(1)
              .every(
                (row) =>
                  row.status === "skipped" && row.error === "warmup_failed",
              ),
          );
        },
      );
      await t.test(
        "invalid completion counts fail the trial without producing an official median",
        async () => {
          const result = await runClient(
            server.port,
            {
              urls: [origin + "/invalid"],
              profiles: ["test"],
              measurementCount: 1,
              trialTimeoutMs: 20000,
            },
            { invalidCount: true },
          );
          assert.equal(
            result.messages.filter(
              (message) => message.action === "trial:saved",
            )[1].result.error,
            "invalid_render_completion",
          );
        },
      );
      await t.test(
        "manual Charles confirmation has no timeout and an aborted run exports CSV",
        async () => {
          const result = await runClient(
            server.port,
            {
              urls: [origin + "/abort"],
              profiles: ["test"],
              measurementCount: 1,
              trialTimeoutMs: 50,
            },
            { abortAtProfile: true, profileDelayMs: 150 },
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
      releaseHeld();
      await server?.close();
      await new Promise((resolve) => fixture.close(resolve));
      await fs.rm(root, { recursive: true, force: true });
    }
  },
);
