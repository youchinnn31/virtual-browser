"use strict";

import express from "express";
import path from "path";
import playwright from "playwright";
// import sharp from "sharp";

const PORT = 3000;
const DEFAULT_HEIGHT = 2000;
// const DEFAULT_WIDTH = 1000;
// const TARGET_SIZE = (128 / 8) * 1000 * 4;

async function main(): Promise<void> {
  const app = express();

  const browser = await playwright.chromium.launch({
    headless: true,
  });
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Mobile Safari/537.36",
    isMobile: true,
  });
  const page = await context.newPage();

  app.use(express.static(path.resolve("dist/client")));
  app.use(express.json());

  app.post("/sites", (req, res, next) => {
    (async () => {
      const requestURl: string = req.body.url;
      const width: number = req.body.width;
      const height: number = req.body.height;
      page.setViewportSize({
        height,
        width,
      });

      await page.goto(requestURl, { waitUntil: "networkidle" });

      const currentUrl: string = page.url();

      const pageHeight = await page.evaluate(async () => {
        return await Promise.resolve(document.body.scrollHeight);
      });
      const numPages: number = Math.ceil(pageHeight / height);
      res.send({ currentUrl, numPages });
    })().catch(next);
  });

  app.get("/sites/:id", (req, res, next) => {
    (async () => {
      const id = parseInt(req.params.id, 10);
      const viewport = page.viewportSize();
      const height = viewport?.height ?? DEFAULT_HEIGHT;

      await page.evaluate(
        ({ height, id }) => {
          window.scrollTo(0, height * id);
        },
        { height, id },
      );
      const screenshot = await page.screenshot();
      // const img = sharp(screenshot);
      // const metadata = await img.metadata();
      // let resizedWidth = metadata.width ?? DEFAULT_WIDTH;
      // while (screenshot.length > TARGET_SIZE) {
      //   resizedWidth = Math.trunc(resizedWidth / 2);
      //   screenshot = await sharp(screenshot)
      //     .resize(resizedWidth, null)
      //     .toBuffer();
      // }
      res.type("image/png");
      res.send(screenshot);
    })().catch(next);
  });

  app.listen(PORT, () => {
    console.log(`App listening on port ${PORT}`);
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
