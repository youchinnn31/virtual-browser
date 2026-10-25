"use strict";

import path from "path";
import fs from "fs";

import express, { Express } from "express";
import puppeteer from "puppeteer";
import sharp from "sharp";

import sqlite3 from "sqlite3";
import WebSocket, { WebSocketServer } from "ws";

import { LcpEntity } from "./types/lcpEntity";
import { UrlEntity } from "./types/urlEntity";
import { WSRequest } from "./types/wsRequest";
import { WSResponse } from "./types/wsResponse";
import { UrlRepository } from "./repository/url.repository";
import { LcpRepository } from "./repository/lcp.repository";
import { LcpInfo } from "./types/lcpInfo";

const PORT: number = 3000; // 仮想ブラウザのPORT番号
const DEFAULT_WIDTH: number = 1000;
const TARGET_SIZE: number = (128 / 8) * 1000 * 4;

const evaluationMode = process.env["LCP_EVALUATION"] === "1";
const db = new sqlite3.Database(process.env["LCP_DB_PATH"] ?? "./json.db");
const lcpFile = fs.readFileSync("./lcp.js", "utf8");

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

  // DB操作用のレポジトリ
  const urlRepository: UrlRepository = new UrlRepository(db);
  const lcpRepository: LcpRepository = new LcpRepository(db);

  // headlessブラウザの起動
  const browser = await puppeteer.launch({
    headless: "new",
    ignoreHTTPSErrors: true,
    args: ["--lang=ja"],
  });

  // pageインスタンスの生成
  const page = await browser.newPage();
  if (evaluationMode) {
    await page.setCacheEnabled(false);
    await page.setBypassServiceWorker(true);
  }
  await page.setBypassCSP(true);
  await page.setExtraHTTPHeaders({
    "Accept-Language": "ja-JP",
  });

  // LCPコンテンツ取得用JavaScriptを注入
  await page.evaluateOnNewDocument(lcpFile);

  // LCP情報を取得したらDBに格納する
  page.on("console", async (msg) => {
    if (msg.type() === "trace") {
      const lcpInfo: LcpInfo = JSON.parse(msg.text());
      await urlRepository.save(lcpInfo.url);
      const urlEntity: UrlEntity = await urlRepository.findByUrl(lcpInfo.url);
      if (urlEntity.access_num === 1) {
        await lcpRepository.save(lcpInfo.lcp, lcpInfo.xpath, urlEntity.id);
      }
    }
  });

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

  // WebSocketサーバの処理
  wss.on("connection", (ws: WebSocket) => {
    console.log("Client connected.");

    // リクエストの処理
    ws.on("message", async (data: string) => {
      const req: WSRequest = JSON.parse(data);
      switch (req.action) {
        case "image": {
          await getImage(req);
          if (evaluationMode) ws.send(JSON.stringify({ action: "complete" }));
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
    });

    /**
     * スクリーンショットを撮影してクライアントに送信
     * @param req リクエスト情報
     */
    const getImage = async (req: WSRequest): Promise<void> => {
      const requestURl: string = req.url;

      // Webサイトにアクセス
      await page.goto(requestURl, {
        waitUntil: "networkidle2",
      });

      // DBにWebサイトの情報を保存
      await urlRepository.save(page.url());
      await urlRepository.incrementAccessNumByUrl(page.url());

      const currentUrl: string = page.url();
      const urlEntity: UrlEntity = await urlRepository.findByUrl(currentUrl);

      // 2回目以降のアクセスかつ初回アクセスが4秒以上の時
      if (urlEntity && urlEntity.image_lcp > 4000) {
        // LCPコンテンツ情報を取得
        const lcps: Array<LcpEntity> = await lcpRepository.findAllByUrlId(
          urlEntity.id,
        );

        for (const lcp of lcps!) {
          // XPathからLCPコンテンツを特定
          const lcpXpath: string = lcp.xpath;
          const [lcpContent] = await page.$x(lcpXpath);

          // コンテンツが特定できた場合
          if (lcpContent) {
            // 座標を取得用のBoundingBox
            const lcpBoundingBox = await lcpContent.boundingBox();

            // 座標の特定が可能な場合
            if (lcpBoundingBox) {
              // 画像を取得
              let screenshot: Buffer = await lcpContent.screenshot({
                type: "webp",
              });

              // 画像を加工
              const img = sharp(screenshot);
              const metadata = await img.metadata();
              let resizedWidth = metadata.width ?? DEFAULT_WIDTH;
              while (screenshot.length > TARGET_SIZE) {
                resizedWidth = Math.trunc(resizedWidth / 2);
                screenshot = await sharp(screenshot)
                  .resize(Math.trunc(resizedWidth), null)
                  .toBuffer();
              }

              // レスポンスデータ
              const res: WSResponse = {
                url: currentUrl,
                img: screenshot,
                x: lcpBoundingBox.x,
                y: lcpBoundingBox.y,
              };

              // クライアントにLCP画像と座標を送信
              ws.send(JSON.stringify(res));
            }
          }
        }
      }
      await page.evaluate(() => {
        window.scrollTo(0, 0);
      });

      // スクリーンショットを撮影
      let screenshot = await page.screenshot({ type: "webp" });

      // 画像を加工
      const img = sharp(screenshot);
      const metadata = await img.metadata();
      let resizedWidth = metadata.width ?? DEFAULT_WIDTH;
      while (screenshot.length > TARGET_SIZE) {
        resizedWidth = Math.trunc(resizedWidth / 2);
        screenshot = await sharp(screenshot)
          .resize(Math.trunc(resizedWidth), null)
          .webp()
          .toBuffer();
      }

      // レスポンスデータ
      const res: WSResponse = {
        url: currentUrl,
        img: screenshot,
        x: 0,
        y: 0,
      };

      // クライアントにビューポート画像を送信
      ws.send(JSON.stringify(res));
    };

    /**
     * クライアントから送られてきたLCPをDBに保存
     * @param LCP
     */
    const processSentLcp = async (req: WSRequest): Promise<void> => {
      const accesedUrl: string = page.url();
      const imageLcp: number = req.lcp;
      const urlEntity: UrlEntity = await urlRepository.findByUrl(accesedUrl);
      if (urlEntity.image_lcp < 0) {
        await urlRepository.updateImageLcpByUrl(accesedUrl, imageLcp);
      }
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

      // スクリーンショットを撮影
      let screenshot: Buffer = await page.screenshot({ type: "webp" });

      // 画像を加工
      const img = sharp(screenshot);
      const metadata = await img.metadata();
      let resizedWidth = metadata.width ?? DEFAULT_WIDTH;
      while (screenshot.length > TARGET_SIZE) {
        resizedWidth = Math.trunc(resizedWidth / 2);
        screenshot = await sharp(screenshot)
          .resize(Math.trunc(resizedWidth), null)
          .toBuffer();
      }

      // レスポンスデータ
      const res: WSResponse = {
        url: page.url(),
        img: screenshot,
        x: 0,
        y: 0,
      };

      // クライアントにビューポート画像を送信
      ws.send(JSON.stringify(res));
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
