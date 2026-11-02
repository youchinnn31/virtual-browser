import fs from "node:fs/promises";
import path from "node:path";
import express from "express";
import puppeteer, { type BrowserContext, type Page } from "puppeteer";
import sharp from "sharp";
import WebSocket, { WebSocketServer } from "ws";
import {
  parseCandidate,
  parseClientMessage,
  type Candidate,
  type ClientMessage,
  type DeviceInfo,
  type EvaluationConfig,
  type Phase,
  type ServerMessage,
  type TrialResult,
} from "./protocol";
import { EvaluationStore, type EvaluationRecord } from "./store";

// Keep the normal server's WebP size budget and networkidle2 navigation policy.
const TARGET_SIZE = (128 / 8) * 1000 * 4;
const ROOT = path.resolve(__dirname, "..");
const RESULTS = path.resolve(
  process.env["EVALUATION_RESULTS_DIR"] ?? "evaluation/results",
);

interface Waiter {
  matches: (message: ClientMessage) => boolean;
  resolve: (message: ClientMessage) => void;
  reject: (error: Error) => void;
}

interface ActiveTrial {
  id: string;
  abort: AbortController;
  sentCount: number;
  imagesEnded: boolean;
  started: boolean;
  metric: Extract<ClientMessage, { action: "trial:metric" }> | null;
}

interface Session {
  ws: WebSocket;
  config: EvaluationConfig;
  device: DeviceInfo;
  abort: AbortController;
  waiters: Set<Waiter>;
  store: EvaluationStore | null;
  trial: ActiveTrial | null;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function signalError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("evaluation_aborted");
}

function check(signal: AbortSignal): void {
  if (signal.aborted) throw signalError(signal);
}

function send(ws: WebSocket, message: ServerMessage): void {
  if (ws.readyState !== WebSocket.OPEN) throw new Error("client_disconnected");
  ws.send(JSON.stringify(message));
}

function notify(ws: WebSocket, message: ServerMessage): void {
  if (ws.readyState === WebSocket.OPEN) send(ws, message);
}

function waitFor(
  session: Session,
  matches: Waiter["matches"],
  signal: AbortSignal,
): Promise<ClientMessage> {
  let waiter: Waiter;
  let onAbort: () => void;
  const promise = new Promise<ClientMessage>((resolve, reject) => {
    const cleanup = (): void => {
      session.waiters.delete(waiter);
      signal.removeEventListener("abort", onAbort);
    };
    waiter = {
      matches,
      resolve: (message) => {
        cleanup();
        resolve(message);
      },
      reject: (error) => {
        cleanup();
        reject(error);
      },
    };
    onAbort = () => waiter.reject(signalError(signal));
    session.waiters.add(waiter);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  // Rendering may fail before its acknowledgement is awaited.
  void promise.catch(() => undefined);
  return promise;
}

function receive(session: Session, message: ClientMessage): void {
  if (message.action === "run:abort") {
    session.abort.abort(new Error(message.reason));
    return;
  }
  if ("trialId" in message) {
    const trial = session.trial;
    if (!trial || message.trialId !== trial.id) return;
    if (message.action === "trial:error") {
      trial.abort.abort(new Error(message.error));
      return;
    }
    if (message.action === "trial:metric") {
      if (
        !trial.started ||
        trial.metric ||
        message.firstImageIndex > trial.sentCount
      ) {
        trial.abort.abort(new Error("invalid_first_image_result"));
      } else {
        trial.metric = message;
      }
      return;
    }
    if (message.action === "trial:complete") {
      if (
        !trial.metric ||
        !trial.imagesEnded ||
        message.renderedCount !== trial.sentCount ||
        message.allImagesMs < trial.metric.firstImageMs
      ) {
        trial.abort.abort(new Error("invalid_render_completion"));
        return;
      }
    }
  }
  for (const waiter of [...session.waiters]) {
    if (waiter.matches(message)) waiter.resolve(message);
  }
}

async function compress(screenshot: Buffer): Promise<Buffer> {
  let width = (await sharp(screenshot).metadata()).width ?? 1000;
  while (screenshot.length > TARGET_SIZE) {
    if (width <= 1) throw new Error("image_cannot_fit_size_budget");
    width = Math.max(1, Math.trunc(width / 2));
    screenshot = await sharp(screenshot).resize(width, null).webp().toBuffer();
  }
  return screenshot;
}

async function renderImages(
  session: Session,
  page: Page,
  evaluation: EvaluationRecord,
  phase: Phase,
  trial: ActiveTrial,
): Promise<string> {
  const store = session.store!;
  const collected: Candidate[] = [];
  const collect = (msg: import("puppeteer").ConsoleMessage): void => {
    if (msg.type() !== "trace") return;
    try {
      const candidate = parseCandidate(JSON.parse(msg.text()));
      if (candidate) collected.push(candidate);
    } catch {
      // The target site may emit unrelated console.trace messages.
    }
  };
  if (phase === "initial") page.on("console", collect);
  try {
    // Do not override Puppeteer's default navigation timeout.
    await page.goto(evaluation.url, { waitUntil: "networkidle2" });
    if (phase === "initial") {
      // Drain entries already queued at the boundary, without another wait period.
      await page.evaluate(() => {
        const observer = (
          window as Window & { __evaluationLcpObserver?: PerformanceObserver }
        ).__evaluationLcpObserver;
        if (observer) {
          for (const entry of observer.takeRecords()) {
            const candidate = entry as PerformanceEntry & { element?: Element };
            const getXPath = (
              window as Window & {
                getElementXPath?: (element: Element) => string;
              }
            ).getElementXPath;
            if (candidate.element && getXPath) {
              console.trace(
                JSON.stringify({
                  url: location.href,
                  lcp: entry.startTime,
                  xpath: getXPath(candidate.element),
                }),
              );
            }
          }
          observer.disconnect();
        }
      });
    }
  } finally {
    page.off("console", collect);
  }
  check(trial.abort.signal);
  const finalUrl = page.url();
  if (phase === "initial") {
    // Ignore candidates from a redirect document that is no longer displayed.
    await store.saveCandidates(
      evaluation.evaluationId,
      collected.filter((candidate) => candidate.url === finalUrl),
    );
  }
  const sendImage = async (
    screenshot: Buffer,
    x: number,
    y: number,
    xpath: string | null,
  ): Promise<void> => {
    const image = await compress(screenshot);
    check(trial.abort.signal);
    trial.sentCount++;
    send(session.ws, {
      action: "trial:image",
      trialId: trial.id,
      imageIndex: trial.sentCount,
      url: finalUrl,
      img: image.toJSON(),
      x,
      y,
      xpath,
    });
  };
  if (phase === "initial") {
    await page.evaluate(() => window.scrollTo(0, 0));
    await sendImage(await page.screenshot({ type: "webp" }), 0, 0, null);
  } else {
    const candidates = await store.getCandidates(evaluation.evaluationId);
    if (candidates.length === 0) throw new Error("no_lcp_candidates");
    for (const candidate of candidates) {
      check(trial.abort.signal);
      const [element] = await page.$x(candidate.xpath);
      if (!element) continue;
      try {
        const box = await element.boundingBox();
        if (!box) continue;
        await sendImage(
          await element.screenshot({ type: "webp" }),
          box.x,
          box.y,
          candidate.xpath,
        );
      } finally {
        await element.dispose();
      }
    }
    if (trial.sentCount === 0) throw new Error("no_matching_lcp_element");
  }
  check(trial.abort.signal);
  trial.imagesEnded = true;
  send(session.ws, {
    action: "trial:images-end",
    trialId: trial.id,
    imageCount: trial.sentCount,
  });
  return finalUrl;
}

async function runTrial(
  session: Session,
  page: Page,
  evaluation: EvaluationRecord,
  phase: Phase,
  visitIndex: number,
): Promise<TrialResult> {
  const store = session.store!;
  const trialId = await store.beginTrial(
    evaluation.evaluationId,
    phase,
    visitIndex,
  );
  const trial: ActiveTrial = {
    id: trialId,
    abort: new AbortController(),
    sentCount: 0,
    imagesEnded: false,
    started: false,
    metric: null,
  };
  session.trial = trial;
  const onAbort = (): void =>
    trial.abort.abort(signalError(session.abort.signal));
  session.abort.signal.addEventListener("abort", onAbort, { once: true });
  if (session.abort.signal.aborted) onAbort();
  const closePage = (): void => {
    void page.close().catch(() => undefined);
  };
  trial.abort.signal.addEventListener("abort", closePage, { once: true });
  const timer = setTimeout(
    () => trial.abort.abort(new Error("trial_timeout")),
    session.config.trialTimeoutMs,
  );
  const result: TrialResult = {
    trialId,
    evaluationId: evaluation.evaluationId,
    phase,
    visitIndex,
    finalUrl: "",
    status: "failed",
    firstImageMs: null,
    allImagesMs: null,
    firstImageIndex: null,
    imageCount: 0,
    error: null,
  };
  try {
    const start = waitFor(
      session,
      (message) =>
        message.action === "trial:start" && message.trialId === trialId,
      trial.abort.signal,
    );
    send(session.ws, {
      action: "trial:ready",
      trialId,
      evaluationId: evaluation.evaluationId,
      url: evaluation.url,
      profile: evaluation.profile,
      phase,
      visitIndex,
      timeoutMs: session.config.trialTimeoutMs,
    });
    await start;
    trial.started = true;
    const complete = waitFor(
      session,
      (message) =>
        message.action === "trial:complete" && message.trialId === trialId,
      trial.abort.signal,
    );
    result.finalUrl = await renderImages(
      session,
      page,
      evaluation,
      phase,
      trial,
    );
    const acknowledgement = await complete;
    check(trial.abort.signal);
    if (acknowledgement.action !== "trial:complete" || !trial.metric)
      throw new Error("missing_render_result");
    result.status = "success";
    result.allImagesMs = acknowledgement.allImagesMs;
  } catch (error) {
    result.error = trial.abort.signal.aborted
      ? errorText(signalError(trial.abort.signal))
      : errorText(error);
    if (
      !trial.abort.signal.aborted &&
      !["no_lcp_candidates", "no_matching_lcp_element"].includes(result.error)
    ) {
      trial.abort.abort(error);
    }
  } finally {
    clearTimeout(timer);
    session.abort.signal.removeEventListener("abort", onAbort);
    trial.abort.signal.removeEventListener("abort", closePage);
    if (trial.metric) {
      result.firstImageMs = trial.metric.firstImageMs;
      result.firstImageIndex = trial.metric.firstImageIndex;
    }
    result.imageCount = trial.sentCount;
    if (result.finalUrl === "" && !page.isClosed())
      result.finalUrl = page.url();
    session.trial = null;
    // Release any pending acknowledgement on failure.
    if (!trial.abort.signal.aborted)
      trial.abort.abort(new Error("trial_finished"));
  }
  await store.finishTrial(result);
  notify(session.ws, { action: "trial:saved", result });
  return result;
}

async function skipTrials(
  session: Session,
  evaluation: EvaluationRecord,
  startIndex: number,
  reason: string,
): Promise<void> {
  for (let index = startIndex; index <= evaluation.revisitCount; index++) {
    const trialId = await session.store!.beginTrial(
      evaluation.evaluationId,
      "revisit",
      index,
    );
    const result: TrialResult = {
      trialId,
      evaluationId: evaluation.evaluationId,
      phase: "revisit",
      visitIndex: index,
      finalUrl: "",
      status: "skipped",
      firstImageMs: null,
      allImagesMs: null,
      firstImageIndex: null,
      imageCount: 0,
      error: reason,
    };
    await session.store!.finishTrial(result);
    notify(session.ws, { action: "trial:saved", result });
  }
}

async function runEvaluation(
  session: Session,
  context: BrowserContext,
  evaluation: EvaluationRecord,
  lcpScript: string,
): Promise<void> {
  const page = await context.newPage();
  await page.setBypassCSP(true);
  await page.setExtraHTTPHeaders({ "Accept-Language": "ja-JP" });
  await page.setUserAgent(session.device.userAgent);
  await page.setViewport({
    width: session.device.width,
    height: session.device.height,
    deviceScaleFactor: 1,
    isMobile: true,
  });
  // Reuse lcp.js and expose its observer only to freeze the initial snapshot.
  await page.evaluateOnNewDocument(
    lcpScript + "\nwindow.__evaluationLcpObserver = observer;",
  );
  try {
    const initial = await runTrial(session, page, evaluation, "initial", 0);
    if (initial.status !== "success") {
      await skipTrials(session, evaluation, 1, "initial_access_failed");
      return;
    }
    for (let index = 1; index <= evaluation.revisitCount; index++) {
      check(session.abort.signal);
      const result = await runTrial(
        session,
        page,
        evaluation,
        "revisit",
        index,
      );
      if (result.status !== "success" && page.isClosed()) {
        // Replacing the browser would change the within-evaluation cache state.
        await skipTrials(
          session,
          evaluation,
          index + 1,
          "evaluation_browser_closed",
        );
        break;
      }
    }
  } finally {
    await page.close().catch(() => undefined);
  }
}

async function main(): Promise<void> {
  const port = Number(process.env["EVALUATION_PORT"] ?? 3001);
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new Error("Invalid EVALUATION_PORT");
  const args = ["--lang=ja"];
  if (process.env["EVALUATION_NO_SANDBOX"] === "1") args.push("--no-sandbox");
  const browser = await puppeteer.launch({
    headless: "new",
    ignoreHTTPSErrors: true,
    args,
  });
  const lcpScript = await fs.readFile(path.join(ROOT, "lcp.js"), "utf8");
  const buildInfo: unknown = JSON.parse(
    await fs.readFile(path.join(ROOT, "build-info.json"), "utf8"),
  );
  const app = express();
  app.use(express.static(path.join(ROOT, "client")));
  app.get("/health", (_req, res) => {
    res.json({ status: "ready" });
  });
  let session: Session | null = null;
  let running: Promise<void> | null = null;

  app.get("/results/:runId/:file", (req, res) => {
    const { runId, file } = req.params;
    if (
      !/^[a-f0-9-]{36}$/.test(runId) ||
      !["evaluation.sqlite", "measurements.csv", "summary.csv"].includes(file)
    ) {
      res.sendStatus(404);
      return;
    }
    if (session?.store?.runId === runId) {
      res.status(409).send("評価終了後にダウンロードできます。");
      return;
    }
    res.download(path.join(RESULTS, runId, file), file, (error) => {
      if (error && !res.headersSent) res.sendStatus(404);
    });
  });

  const server = app.listen(port, "0.0.0.0");
  const wss = new WebSocketServer({
    server,
    perMessageDeflate: {
      zlibDeflateOptions: { chunkSize: 1024, memLevel: 7, level: 3 },
      zlibInflateOptions: { chunkSize: 10 * 1024 },
      clientNoContextTakeover: true,
      serverNoContextTakeover: true,
      serverMaxWindowBits: 10,
      concurrencyLimit: 10,
      threshold: 1024,
    },
  });

  const run = async (current: Session): Promise<void> => {
    let status: "completed" | "aborted" | "failed" = "completed";
    let failure: string | null = null;
    try {
      const store = await EvaluationStore.create(
        RESULTS,
        current.config,
        current.device,
        {
          build: buildInfo,
          browserVersion: await browser.version(),
          nodeVersion: process.version,
          serverDeviceScaleFactor: 1,
          imageSizeBudgetBytes: TARGET_SIZE,
          throttling: "external-charles",
          navigationWaitUntil: "networkidle2",
        },
      );
      current.store = store;
      check(current.abort.signal);
      send(current.ws, {
        action: "run:created",
        runId: store.runId,
        evaluationCount:
          current.config.urls.length * current.config.profiles.length,
      });
      for (const [profileIndex, profile] of current.config.profiles.entries()) {
        const confirmed = waitFor(
          current,
          (message) =>
            message.action === "profile:confirmed" &&
            message.runId === store.runId &&
            message.profileIndex === profileIndex,
          current.abort.signal,
        );
        send(current.ws, {
          action: "profile:required",
          runId: store.runId,
          profileIndex,
          profile,
        });
        await confirmed;
        for (const url of current.config.urls) {
          check(current.abort.signal);
          const evaluation = await store.createEvaluation(
            url,
            profile,
            current.config.revisitCount,
          );
          const context = await browser.createIncognitoBrowserContext();
          try {
            await runEvaluation(current, context, evaluation, lcpScript);
          } finally {
            await context.close().catch(() => undefined);
            const summary = await store.summarize(evaluation);
            await store.exportReports();
            notify(current.ws, { action: "evaluation:complete", summary });
          }
        }
      }
      check(current.abort.signal);
    } catch (error) {
      status = current.abort.signal.aborted ? "aborted" : "failed";
      failure = errorText(error);
    } finally {
      if (current.store) {
        try {
          await current.store.finish(status, failure);
        } catch (error) {
          status = "failed";
          failure = errorText(error);
        }
        try {
          await current.store.close();
        } catch (error) {
          status = "failed";
          failure = errorText(error);
        }
      }
      // Clear the active run before advertising downloadable results.
      if (session === current) session = null;
      if (current.store)
        notify(current.ws, {
          action: "run:finished",
          runId: current.store.runId,
          status,
          error: failure,
        });
      else
        notify(current.ws, {
          action: "error",
          error: failure ?? "run_creation_failed",
        });
    }
  };

  wss.on("connection", (ws, request) => {
    if (request.url !== "/ws") {
      ws.close(1008, "Use /ws");
      return;
    }
    notify(ws, { action: "connection:ready" });
    ws.on("error", () => {
      if (session?.ws === ws)
        session.abort.abort(new Error("client_connection_error"));
    });
    ws.on("close", () => {
      if (session?.ws === ws)
        session.abort.abort(new Error("client_disconnected"));
    });
    ws.on("message", (data) => {
      try {
        const message = parseClientMessage(JSON.parse(data.toString()));
        if (message.action === "run:start") {
          if (session) {
            send(ws, { action: "error", error: "別の評価が実行中です。" });
            return;
          }
          const current: Session = {
            ws,
            config: message.config,
            device: message.device,
            abort: new AbortController(),
            waiters: new Set(),
            store: null,
            trial: null,
          };
          session = current;
          running = run(current).catch((error: unknown) => {
            console.error(error);
            if (session === current) session = null;
            notify(ws, { action: "error", error: errorText(error) });
          });
        } else if (session?.ws === ws) {
          receive(session, message);
        }
      } catch (error) {
        notify(ws, { action: "error", error: errorText(error) });
      }
    });
  });
  server.on("listening", () => {
    const address = server.address();
    console.log(
      JSON.stringify({
        event: "evaluation:listening",
        port: typeof address === "object" && address ? address.port : port,
      }),
    );
  });
  server.on("error", (error) => {
    console.error(error);
    void browser.close().finally(() => {
      process.exitCode = 1;
    });
  });
  let closing = false;
  const shutdown = async (): Promise<void> => {
    if (closing) return;
    closing = true;
    session?.abort.abort(new Error("server_shutdown"));
    await running;
    for (const client of wss.clients) client.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await browser.close();
  };
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      void shutdown().catch((error: unknown) => {
        console.error(error);
        process.exitCode = 1;
      });
    });
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
