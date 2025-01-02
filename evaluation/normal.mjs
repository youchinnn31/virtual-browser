"use strict";

import fs from "fs";
import lighthouse from "lighthouse";
import * as chromeLauncher from "chrome-launcher";

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
  for (let i = 0; i < netSpeedList.length; i++) {
    for (let j = 0; j < urlList.length; j++) {
      for (let k = 0; k < 5; k++) {
        const result = JSON.parse(fs.readFileSync("./normal.json", "utf-8"));
        const chrome = await chromeLauncher.launch();
        const options = {
          logLevel: "info",
          output: "json",
          formFactor: "mobile",
          screenEmulation: {
            width: 375,
            height: 667,
            deviceScaleFactor: 2,
            mobile: true,
            disabled: true,
          },
          emulatedUserAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1",
          throttlingMethod: "devtools",
          throttling: {
            requestLatencyMs: netSpeedList[i].config.latency,
            downloadThroughputKbps: netSpeedList[i].config.downloadThroughput * 8 / 1000,
            uploadThroughputKbps: netSpeedList[i].config.uploadThroughput * 8 / 1000,
          },
          onlyAudits: ["largest-contentful-paint"],
          port: chrome.port
        }

        const runnerResult = await lighthouse(urlList[j], options);
        const report = JSON.parse(runnerResult.report);
        const lcp = report.audits["largest-contentful-paint"].numericvalue;
        const data = {
          url: urlList[j],
          speep: netSpeedList[i].speed,
          lcp: lcp
        };
        await result.push(data);
        fs.writeFileSync("./normal.json", JSON.stringify(result));
        chrome.kill();
      }
    }
  }
}

measure().catch((error) => {
  console.error(error);
  process.exit(1);
});
