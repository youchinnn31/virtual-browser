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

const db = new sqlite3.Database("./json.db");
const lcpFile = fs.readFileSync("./lcp.js", "utf8");

/**
 * 仮想ブラウザの処理
 */
async function main(): Promise<void> {
  const app: Express = express();

  app.use(express.static(path.resolve("dist/client")));
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  app.set("views", process.cwd() + "/views");

  app.get("/evaluation", (req, res) => {
    const url = req.query["url"];
    res.render("index.ejs", { url });
  });

  // テーブルの作成
  db.serialize(() => {
    db.run(
      "CREATE TABLE IF NOT EXISTS url(id INTEGER PRIMARY KEY, url TEXT UNIQUE, image_lcp INTEGER NOT NULL, access_num INTEGER NOT NULL)",
    );
    db.run(
      "CREATE TABLE IF NOT EXISTS lcp(id INTEGER PRIMARY KEY AUTOINCREMENT, lcp INTEGER NOT NULL, xpath TEXT, url_id INTEGER, FOREIGN KEY (url_id) REFERENCES url(id))",
    );
  });

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
  await page.setBypassCSP(true);
  await page.setExtraHTTPHeaders({
    "Accept-Language": "ja-JP",
  });

  await page.evaluateOnNewDocument(lcpFile);

  // LCP情報を取得したら配列に格納する
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

  // サーバのリッスン
  const server = app.listen(PORT, () => {
    console.log(`App listening on port ${PORT}`);
  });

  // WSサーバのインスタンス
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

  // WSサーバの処理
  wss.on("connection", (ws: WebSocket) => {
    console.log("Client connected.");

    // リクエストの処理
    ws.on("message", async (data: string) => {
      const req: WSRequest = JSON.parse(data);
      switch (req.action) {
        case "init": {
          await init(req);
          break;
        }
        case "lcp": {
          await processSentLcp(req);
          break;
        }
        case "scroll": {
          await scrollBrowser(req);
          break;
        }
        case "userAgent": {
          await setUserAgent(req);
          break;
        }
        default: {
          console.log("default");
          break;
        }
      }
    });

    const init = async (req: WSRequest): Promise<void> => {
      const requestURl: string = req.url;

      await page.goto(requestURl, {
        waitUntil: "networkidle2",
      });

      // const a = await page.evaluate(() => {
      //   return window.LargestContentfulPaint;
      // });
      // console.log(a);

      await urlRepository.save(page.url());

      await urlRepository.incrementAccessNumByUrl(page.url());

      const currentUrl: string = page.url();

      //  初回アクセスかどうかの確認
      const urlEntity: UrlEntity = await urlRepository.findByUrl(currentUrl);
      if (urlEntity && urlEntity.image_lcp > 0) {
        const lcps: Array<LcpEntity> = await lcpRepository.findAllByUrlId(
          urlEntity.id,
        );

        // 各LCPコンテンツに対して処理する
        for (const lcp of lcps!) {
          const lcpXpath: string = lcp.xpath; // LCPコンテンツのxpath
          const [lcpContent] = await page.$x(lcpXpath); // xpathから特定

          // コンテンツが特定出来た場合
          if (lcpContent) {
            console.log(lcpXpath);
            const lcpBoundingBox = await lcpContent.boundingBox();
            if (lcpBoundingBox) {
              let screenshot: Buffer = await lcpContent.screenshot({
                type: "webp",
              });
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
              ws.send(JSON.stringify(res));
            } else {
              console.log("見つからへんかった?");
            }
          } else {
            console.log("lengthが0未満");
          }
        }
        await page.evaluate(() => {
          window.scrollTo(0, 0);
        });
        let screenshot: Buffer = await page.screenshot({ type: "webp" });
        const img = sharp(screenshot);
        const metadata = await img.metadata();
        let resizedWidth = metadata.width ?? DEFAULT_WIDTH;
        while (screenshot.length > TARGET_SIZE) {
          resizedWidth = Math.trunc(resizedWidth / 2);
          screenshot = await sharp(screenshot)
            .resize(Math.trunc(resizedWidth), null)
            .toBuffer();
        }

        const res: WSResponse = {
          url: currentUrl,
          img: screenshot,
          x: 0,
          y: 0,
        };
        ws.send(JSON.stringify(res));
      } else {
        let screenshot = await page.screenshot({ type: "webp" });
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

        const res: WSResponse = {
          url: currentUrl,
          img: screenshot,
          x: 0,
          y: 0,
        };
        ws.send(JSON.stringify(res));
      }
    };

    /**
     * クライアントから送られてきたLCPを保存
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
     */
    const scrollBrowser = async (req: WSRequest): Promise<void> => {
      await page.evaluate((scrollAmount) => {
        window.scrollBy(0, scrollAmount);
      }, req.scrollAmount);
      let screenshot: Buffer = await page.screenshot({ type: "webp" });
      const img = sharp(screenshot);
      const metadata = await img.metadata();
      let resizedWidth = metadata.width ?? DEFAULT_WIDTH;
      while (screenshot.length > TARGET_SIZE) {
        resizedWidth = Math.trunc(resizedWidth / 2);
        screenshot = await sharp(screenshot)
          .resize(Math.trunc(resizedWidth), null)
          .toBuffer();
      }

      const res: WSResponse = {
        url: page.url(),
        img: screenshot,
        x: 0,
        y: 0,
      };
      ws.send(JSON.stringify(res));
    };

    /**
     * モバイル端末情報を設定する
     */
    const setUserAgent = async (req: WSRequest): Promise<void> => {
      const height: number = req.height;
      const width: number = req.width;
      await page.setViewport({
        height,
        width,
        isMobile: true,
      });
      if ((await browser.userAgent()) !== req.userAgent) {
        await page.setUserAgent(req.userAgent);
      }
    };
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
