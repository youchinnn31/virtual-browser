import lighthouse from "lighthouse";
import * as chromeLauncher from "chrome-launcher";

const urls = ["https://google.com"];

const chrome = await chromeLauncher.launch({
  chromeFlags: ["--headless"],
  chromePath: "/usr/bin/google-chrome",
});
const options = {
  logLevel: "info",
  output: "json",
  maxWaitForFcp: 10 * 60 * 1000,
  maxWaitForLoad: 10 * 60 * 1000,
  formFactor: "mobile",
  // Pixel 7a
  screenEmulation: {
    width: 750,
    height: 1334,
    deviceScaleFactor: 2,
    mobile: true,
    disabled: true,
  },
  throttlingMethod: "devtools",
  throttling: {
    requestLatencyMs: 0,
    downloadThroughputKbps: 128,
    uploadThroughputKbps: 128,
  },
  onlyAudits: ["largest-contentful-paint"],
  port: chrome.port,
};

for (const url of urls) {
  const runnerResult = await lighthouse(
    `http://localhost:3000/evaluation?url=${url}`,
    options,
  );
  // const runnerResult = await lighthouse(url, options);
  const report = JSON.parse(runnerResult.report);
  const lcp = report.audits["largest-contentful-paint"].numericValue;
  console.log(`${url}: ${lcp}`);
}

chrome.kill();
