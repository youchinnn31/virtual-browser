"use strict";

import path from "path";
import fs from "fs";
import child_process from "child_process";

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

const FILE_PATH = "./first.json";

const urlList = [
  "https://www.google.com/",
  "https://m.yahoo.co.jp/",
  "https://m.youtube.com/",
  "https://news.yahoo.co.jp/",
  "https://www.amazon.co.jp/",
  "https://www.docomo.ne.jp/",
  "https://x.com/?mx=2",
  "https://www.rakuten.co.jp/",
  "https://www.google.co.jp/",
  "https://www.pixiv.net/",
  "https://weather.yahoo.co.jp/weather/",
  "https://ameblo.jp/",
  "https://www.wikipedia.org/",
  "https://livedoor.com/lite/",
  "https://tenki.jp/lite/",
  "https://www.instagram.com/",
  "https://m.facebook.com/",
  "https://portal.auone.jp/",
  "https://note.com/",
  "https://sports.yahoo.co.jp/",
  "https://www.nhk.or.jp/",
  "https://fc2.com/",
  "https://shopping.yahoo.co.jp/",
  "https://sp.nicovideo.jp/",
  "https://blog.jp/",
  "https://www.cmoa.jp/",
  "https://weathernews.jp/",
  "https://trilltrill.jp/",
  "https://syosetu.com/",
  "https://www.mercari.com/",
];

const netSpeedList = [
  {
    speed: 128,
    config: {
      downloadThroughput: 16000,
      uploadThroughput: 16000,
      latency: 0,
      offline: false,
    },
  },
  {
    speed: 200,
    config: {
      downloadThroughput: 25000,
      uploadThroughput: 25000,
      latency: 0,
      offline: false,
    },
  },
  {
    speed: 300,
    config: {
      downloadThroughput: 37500,
      uploadThroughput: 37500,
      latency: 0,
      offline: false,
    },
  },
  {
    speed: 1024,
    config: {
      downloadThroughput: 128000,
      uploadThroughput: 128000,
      latency: 0,
      offline: false,
    },
  },
];

/**
 * 仮想ブラウザの処理
 */
async function main(): Promise<void> {
  for (let i = 0; i < netSpeedList.length; i++) {
    for (let j = 0; j < urlList.length; i++) {
      for (let k = 0; k < 25; k++) {
        const result = JSON.parse(fs.readFileSync(FILE_PATH, "utf-8"));
        // 1回目用
        child_process.exec("rm ../json.db");

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
            const urlEntity: UrlEntity = await urlRepository.findByUrl(
              lcpInfo.url,
            );
            if (urlEntity.access_num === 1) {
              await lcpRepository.save(
                lcpInfo.lcp,
                lcpInfo.xpath,
                urlEntity.id,
              );
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
            const urlEntity: UrlEntity =
              await urlRepository.findByUrl(currentUrl);
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
            const urlEntity: UrlEntity =
              await urlRepository.findByUrl(accesedUrl);
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

        const browser2 = await puppeteer.launch({
          headless: false,
          ignoreHTTPSErrors: true,
          args: ["--lang=ja"],
        });
        const page2 = await browser2.newPage();
        await page2.setViewport({
          height: 667,
          width: 375,
          deviceScaleFactor: 2,
          isMobile: true,
        });
        await page2.setUserAgent(
          "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1",
        );

        const cdpSession = await page2.createCDPSession();
        await cdpSession.send(
          "Network.emulateNetworkConditions",
          netSpeedList[i]?.config,
        );

        await new Promise((resolve) => setTimeout(resolve, 2000));
        await page2.goto(`http://localhost:3000/evaluation?url=${urlList[j]}`);

        const lcp = await new Promise((resolve) => {
          page.on("console", async (msg) => {
            if (msg.type() === "trace") {
              resolve(msg.text());
            }
          });
        });

        const data = {
          url: urlList[j],
          speed: netSpeedList[i]?.speed,
          lcp: lcp,
        };
        console.log(data);
        await result.push(data);
        fs.writeFileSync(FILE_PATH, JSON.stringify(result));

        await browser2.close();
        server.close();
        // child_process.exec("kill -9 $(lsof -ti :3000)");
      }
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
