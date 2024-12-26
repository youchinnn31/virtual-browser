"use strcit";

import child_process from "child_process";
import fs from "fs";
import { resolve } from "path";
import puppeteer from "puppeteer";

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

async function measure() {
  const result = [];
  // for (let i = 0; i < netSpeedList.length; i++) {
  for (let i = 0; i < 1; i++) {
    for (let j = 0; j < urlList.length; j++) {
      for (let k = 0; k < 1; k++) {
        let i = 3;
        // 1回目用
        // await new Promise((resolve, reject) => {
        //   child_process.exec("rm ../json.db", (err) => {
        //     if (err) reject(err);
        //     child_process.spawn("npm", ["start"]);
        //     resolve();
        //   });
        // });

        // 2回目用
        child_process.spawn("npm", ["start"]);

        const browser = await puppeteer.launch({
          headless: false,
          ignoreHTTPSErrors: true,
          args: ["--lang=ja"],
        });
        const page = await browser.newPage();
        await page.setViewport({
          height: 667,
          width: 375,
          deviceScaleFactor: 2,
          isMobile: true,
        });
        await page.setUserAgent(
          "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1",
        );

        const cdpSession = await page.createCDPSession();
        await cdpSession.send(
          "Network.emulateNetworkConditions",
          netSpeedList[i].config,
        );

        await new Promise((resolve) => setTimeout(resolve, 2000));
        await page.goto(`http://localhost:3000/evaluation?url=${urlList[j]}`);

        const lcp = await new Promise((resolve) => {
          page.on("console", async (msg) => {
            if (msg.type() === "trace") {
              // await page.screenshot({
              //   type: "webp",
              //   path: "./a.webp"
              // });
              resolve(msg.text());
            }
          });
        });

        const data = {
          url: urlList[j],
          speed: netSpeedList[i].speed,
          lcp: lcp,
        };
        console.log(data);
        result.push(data);

        await browser.close();
        child_process.exec("kill -9 $(lsof -ti :3000)");
      }
    }
  }
  fs.writeFileSync("./result.json", JSON.stringify(result));
}

measure().catch((error) => {
  console.error(error);
  process.exit(1);
});
