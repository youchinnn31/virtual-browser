"use strict";

import path from "path";

import express, { Express } from "express";
import puppeteer from "puppeteer";

import sqlite3 from "sqlite3";
import WebSocket, { WebSocketServer } from "ws";

import { WSRequest } from "./types/wsRequest";
import { registerTabletEvaluation } from "./evaluation/controller";
import { PageRenderer } from "./rendering/page-renderer";
import type { CandidateResult } from "./rendering/types";

const PORT: number = 3000; // 仮想ブラウザのPORT番号
const evaluationMode = process.env["LCP_EVALUATION"] === "1";
const db = new sqlite3.Database(process.env["LCP_DB_PATH"] ?? "./json.db");

/**
 * 仮想ブラウザの処理
 */
async function main(): Promise<void> {
  const app: Express = express();

  app.use(express.static(path.resolve("dist/client")));
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  // テーブルの作成
  db.serialize(() => {
    db.run(
      "CREATE TABLE IF NOT EXISTS url(id INTEGER PRIMARY KEY, url TEXT UNIQUE, image_lcp INTEGER NOT NULL, access_num INTEGER NOT NULL)",
    );
    db.run(
      "CREATE TABLE IF NOT EXISTS lcp(id INTEGER PRIMARY KEY AUTOINCREMENT, lcp INTEGER NOT NULL, xpath TEXT, url_id INTEGER, FOREIGN KEY (url_id) REFERENCES url(id))",
    );
  });

  let requestedUrl = "";

  // headlessブラウザの起動
  const browser = await puppeteer.launch({
    headless: "new",
    handleSIGINT: false,
    handleSIGTERM: false,
    ignoreHTTPSErrors: true,
    args: ["--lang=ja", "--no-proxy-server"],
  });

  // pageインスタンスの生成
  const page = await browser.newPage();
  await page.setCacheEnabled(!evaluationMode);
  await page.setBypassServiceWorker(true);
  await page.setBypassCSP(true);
  await page.setExtraHTTPHeaders({
    "Accept-Language": "ja-JP",
  });

  const renderer = await PageRenderer.create(page, db);

  let legacyOperations = 0;
  let shuttingDown = false;
  const tablet = registerTabletEvaluation(
    app,
    browser,
    () => legacyOperations === 0 && !shuttingDown,
  );

  // サーバの起動
  const server = app.listen(PORT, () => {
    console.log(`App listening on port ${PORT}`);
  });

  // WebSocketサーバのインスタンス
  const wss: WebSocketServer = new WebSocketServer({
    server,
    perMessageDeflate: {
      zlibDeflateOptions: {
        chunkSize: 1024,
        memLevel: 7,
        level: 3,
      },
      zlibInflateOptions: {
        chunkSize: 10 * 1024,
      },
      clientNoContextTakeover: true,
      serverNoContextTakeover: true,
      serverMaxWindowBits: 10,
      concurrencyLimit: 10,
      threshold: 1024,
    },
  });
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      await tablet.stop();
      for (const client of wss.clients) client.terminate();
      await renderer.close();
      await browser.close();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      });
      await new Promise<void>((resolve) => db.close(() => resolve()));
      process.exitCode = 0;
    } catch (error) {
      console.error(error);
      process.exitCode = 1;
    }
  };
  process.once("SIGINT", () => {
    void shutdown();
  });
  process.once("SIGTERM", () => {
    void shutdown();
  });

  // WebSocketサーバの処理
  wss.on("connection", (ws: WebSocket, request) => {
    if (shuttingDown) {
      ws.close(1001, "Server stopping");
      return;
    }
    const address = new URL(request.url ?? "/", "http://localhost");
    if (address.pathname === "/evaluation/ws") {
      tablet.connect(ws, address.searchParams.get("token"));
      return;
    }
    if (tablet.isBusy()) {
      ws.close(1013, "Tablet evaluation in progress");
      return;
    }
    console.log("Client connected.");

    // リクエストの処理
    ws.on("message", async (data: string) => {
      if (tablet.isBusy()) {
        ws.close(1013, "Tablet evaluation in progress");
        return;
      }
      legacyOperations++;
      try {
        const req: WSRequest = JSON.parse(data);
        switch (req.action) {
          case "image": {
            const candidates = await getImage(req);
            if (evaluationMode)
              ws.send(JSON.stringify({ action: "complete", candidates }));
            break;
          }
          case "lcp": {
            await processSentLcp(req);
            if (evaluationMode)
              ws.send(JSON.stringify({ action: "lcp-received" }));
            break;
          }
          case "scroll": {
            await scrollBrowser(req);
            break;
          }
          case "init": {
            await setConfig(req);
            if (evaluationMode) ws.send(JSON.stringify({ action: "ready" }));
            break;
          }
          default: {
            break;
          }
        }
      } catch (error) {
        console.error(error);
        ws.close(1011, "Request failed");
      } finally {
        legacyOperations--;
      }
    });

    /**
     * スクリーンショットを撮影してクライアントに送信
     * @param req リクエスト情報
     */
    const getImage = async (req: WSRequest): Promise<CandidateResult[]> => {
      if (
        req.cacheEnabled !== undefined &&
        typeof req.cacheEnabled !== "boolean"
      )
        throw new Error("HTTPキャッシュの設定が不正です。");
      await page.setCacheEnabled(req.cacheEnabled ?? !evaluationMode);
      requestedUrl = req.url;
      const result = await renderer.render(req.url, (frame) => {
        ws.send(JSON.stringify(frame));
      });
      return result.candidates;
    };

    /**
     * クライアントから送られてきたLCPをDBに保存
     * @param LCP
     */
    const processSentLcp = async (req: WSRequest): Promise<void> => {
      await renderer.saveInitial(requestedUrl, req.lcp);
    };

    /**
     * クライアントがスクロール時の処理
     * @param スクロール量
     */
    const scrollBrowser = async (req: WSRequest): Promise<void> => {
      // スクロール
      await page.evaluate((scrollAmount) => {
        window.scrollBy(0, scrollAmount);
      }, req.scrollAmount);

      ws.send(JSON.stringify(await renderer.captureViewport()));
    };

    /**
     * モバイル端末情報を設定する
     * @param req モバイル端末の情報
     */
    const setConfig = async (req: WSRequest): Promise<void> => {
      const height: number = req.height;
      const width: number = req.width;

      // ビューポートを設定
      await page.setViewport({
        height,
        width,
        isMobile: true,
      });

      // ユーザエージェントを設定
      if ((await browser.userAgent()) !== req.userAgent) {
        await page.setUserAgent(req.userAgent);
      }
    };
  });
}

// main関数を実行
main().catch((error) => {
  console.error(error);
  process.exit(1);
});
