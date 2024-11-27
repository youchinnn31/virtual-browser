"use strict";

import express, { Express } from "express";
import path from "path";
import playwright, {
  Browser,
  BrowserContext,
  Locator,
  Page,
  Response,
} from "playwright";
import sqlite3 from "sqlite3";
import WebSocket, { WebSocketServer } from "ws";
// import sharp from "sharp";

import { LcpEntity } from "./types/lcpEntity";
import { UrlEntity } from "./types/urlEntity";
// import { LcpMetric } from "./types/lcpMetric";
import { WSRequest } from "./types/wsRequest";
import { WSResponse } from "./types/wsResponse";
import { UrlRepository } from "./repository/url.repository";
import { LcpRepository } from "./repository/lcp.repository";
// import { Queue } from "./queue";
// import { QueueForm } from "./types/queueForm";

const PORT: number = 3000; // 仮想ブラウザのPORT番号
const QUALITY: number = 50; // SSのクオリティ
// const TARGET_SIZE: number = (128 / 8) * 1000 * 4;
// const DEFAULT_HEIGHT: number = 2000;
// const DEFAULT_WIDTH: number = 1000;

const responses: Array<Response> = [];
const db = new sqlite3.Database("./json.db");
// const SubStack: Array<QueueForm> = [];

/**
 * 仮想ブラウザの処理
 */
async function main(): Promise<void> {
  const app: Express = express();

  app.use(express.json());
  app.use(express.static(path.resolve("dist/client")));

  app.use(express.urlencoded({ extended: true }));
  app.set("views", process.cwd() + "/views");
  app.get("/evaluation", (req, res) => {
    const url = req.query["url"];
    res.render("index.ejs", { url });
  });

  // テーブルの作成
  db.serialize(() => {
    db.run(
      "CREATE TABLE IF NOT EXISTS url(id INTEGER PRIMARY KEY AUTOINCREMENT, url TEXT UNIQUE, image_lcp INTEGER NOT NULL)",
    );
    db.run(
      "CREATE TABLE IF NOT EXISTS lcp(id INTEGER PRIMARY KEY AUTOINCREMENT, lcp INTEGER NOT NULL, selector TEXT, url_id INTEGER, FOREIGN KEY (url_id) REFERENCES url(id))",
    );
  });

  const urlRepository: UrlRepository = new UrlRepository(db);
  const lcpRepository: LcpRepository = new LcpRepository(db);
  // const queue: Queue = new Queue(urlRepository, lcpRepository);

  // headlessブラウザの起動
  const browser: Browser = await playwright.chromium.launch({
    headless: true,
  });

  // headlessブラウザをモバイル用にする
  const context: BrowserContext = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Linux; Android 15; Pixel 8 Pro Build/AP41.240925.009; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/131.0.6778.22 Mobile Safari/537.36",
    isMobile: true,
  });

  // pageインスタンスの生成
  const page: Page = await context.newPage();

  // LCP測定用のJSを注入
  await page.addInitScript({ path: "./lcp.js" });

  // LCP情報を取得したら配列に格納する
  page.on("console", async (msg) => {
    if (msg.type() === "trace") {
      console.log(msg.text());
      // const urlEntity: UrlEntity = await urlRepository.findByUrl(page.url());
      // await lcpRepository.save(JSON.parse(msg.text()), urlEntity.id);

      // await queue.enqueue({
      //   lcpMetric: JSON.parse(msg.text()),
      //   url: page.url(),
      // });

      // SubStack.push({
      //   lcpMetric: JSON.parse(msg.text()),
      //   url: page.url(),
      // });
    }
  });

  // レスポンス情報を配列に格納
  page.on("response", async (res) => {
    responses.push(res);
  });

  // サーバのリッスン
  const server = app.listen(PORT, () => {
    console.log(`App listening on port ${PORT}`);
  });

  // WSサーバのインスタンス
  const wss: WebSocketServer = new WebSocketServer({ server });

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
        default: {
          console.log("default");
          break;
        }
      }
    });

    const init = async (req: WSRequest): Promise<void> => {
      const requestURl: string = req.url;
      const width: number = req.width;
      const height: number = req.height;
      const userAgent: string = req.userAgent;

      await page.setExtraHTTPHeaders({
        "User-Agent": userAgent,
      });
      await page.setViewportSize({ height, width });
      await page.goto(requestURl, {
        waitUntil: "load",
        timeout: 0,
      });
      const currentUrl: string = page.url();

      //  初回アクセスかどうかの確認
      const urlEntity: UrlEntity = await urlRepository.findByUrl(currentUrl);
      if (urlEntity && urlEntity.image_lcp > 4000) {
        // if (urlEntity) {
        const lcps: Array<LcpEntity> = await lcpRepository.findAllByUrlId(
          urlEntity.id,
        );

        // 各LCPコンテンツに対して処理する
        // let count = 0;
        for (const lcp of lcps!) {
          const lcpUrl: string = lcp.selector; // LCPコンテンツのURL

          // LCPコンテンツを特定
          const lcpLocator: Locator[] = await page.locator(lcpUrl).all();
          // コンテンツが特定出来た場合
          if (lcpLocator.length > 0) {
            // TODO: なんかエラーはくことがある?rakutenのサイト
            // await lcpLocator[0]!.scrollIntoViewIfNeeded();
            const lcpBoundingBox = await lcpLocator[0]!.boundingBox();
            if (lcpBoundingBox) {
              // count += 1;
              const screenshot: Buffer = await lcpLocator[0]!.screenshot({
                type: "jpeg",
                quality: QUALITY,
              });
              // const img = sharp(screenshot);
              // const metadata = await img.metadata();
              // let resizedWidth = metadata.width ?? DEFAULT_WIDTH;
              // while (screenshot.length > TARGET_SIZE) {
              //   resizedWidth = Math.trunc(resizedWidth / 2);
              //   screenshot = await sharp(screenshot)
              //     .resize(Math.trunc(resizedWidth), null)
              //     .webp()
              //     .toBuffer();
              // }

              // レスポンスデータ
              const res: WSResponse = {
                url: currentUrl,
                img: screenshot,
                x: lcpBoundingBox!.x,
                y: lcpBoundingBox!.y,
              };
              ws.send(JSON.stringify(res));
              // setTimeout(() => {
              //   ws.send(JSON.stringify(res));
              // }, 2000 * count);
            } else {
              console.log("見つからへんかった?");
            }
          } else {
            console.log("lengthが0未満");
          }
        }
        const screenshot = await page.screenshot({
          type: "jpeg",
          quality: QUALITY,
        });

        const res: WSResponse = {
          url: currentUrl,
          img: screenshot,
          x: 0,
          y: 0,
        };
        // setTimeout(
        //   () => {
        //     ws.send(JSON.stringify(res));
        //   },
        //   2000 * (count + 1),
        // );
        ws.send(JSON.stringify(res));
        responses.splice(0, 0);
      } else {
        const screenshot = await page.screenshot({
          type: "jpeg",
          quality: QUALITY,
        });
        // const img = sharp(screenshot);
        // const metadata = await img.metadata();
        // let resizedWidth = metadata.width ?? DEFAULT_WIDTH;
        // while (screenshot.length > TARGET_SIZE) {
        //   resizedWidth = Math.trunc(resizedWidth / 2);
        //   screenshot = await sharp(screenshot)
        //     .resize(Math.trunc(resizedWidth), null)
        //     .webp()
        //     .toBuffer();
        // }

        const res: WSResponse = {
          url: currentUrl,
          img: screenshot,
          x: 0,
          y: 0,
        };
        ws.send(JSON.stringify(res));
        await urlRepository.save(currentUrl);
        // while (SubStack.length > 0) {
        //   await queue.enqueue(SubStack.pop()!);
        // }
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
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
