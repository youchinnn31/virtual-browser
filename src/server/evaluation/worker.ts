import fs from "node:fs/promises";
import sqlite3 from "sqlite3";
import sharp from "sharp";
import type { Browser, BrowserContext, Page } from "puppeteer";
import { UrlRepository } from "../repository/url.repository";
import { LcpRepository } from "../repository/lcp.repository";
import type {
  CandidateResult,
  DeviceInfo,
  EvaluationFrame,
  NavigationWaitUntil,
} from "./types";
import type { ProgressLogger } from "./logger";

/** One fresh context and collection DB for one requested URL / speed pair. */
export class TabletWorker {
  private collecting = false;
  private writes = Promise.resolve();
  private scriptId: string | undefined;
  private nextAccess = 0;

  private constructor(
    private context: BrowserContext,
    private page: Page,
    private db: sqlite3.Database,
    private url: string,
    private urlId: number,
    private progress: ProgressLogger,
    private navigationWaitUntil: NavigationWaitUntil,
  ) {}

  static async open(
    browser: Browser,
    database: string,
    url: string,
    device: DeviceInfo,
    progress: ProgressLogger = () => {},
    navigationWaitUntil: NavigationWaitUntil = "networkidle2",
  ) {
    const context = await browser.createIncognitoBrowserContext();
    const db = new sqlite3.Database(database);
    try {
      await new Promise<void>((resolve, reject) =>
        db.exec(
          "CREATE TABLE url(id INTEGER PRIMARY KEY,url TEXT UNIQUE,image_lcp REAL NOT NULL,access_num INTEGER NOT NULL);" +
            "CREATE TABLE lcp(id INTEGER PRIMARY KEY AUTOINCREMENT,lcp REAL NOT NULL,xpath TEXT,url_id INTEGER REFERENCES url(id));",
          (error) => (error ? reject(error) : resolve()),
        ),
      );
      const urls = new UrlRepository(db);
      await urls.save(url);
      const entity = await urls.findByUrl(url);
      const page = await context.newPage();
      await page.setViewport({
        width: device.width,
        height: device.height,
        isMobile: true,
        deviceScaleFactor: 1,
      });
      await page.setUserAgent(device.userAgent);
      await page.setCacheEnabled(false);
      await page.setBypassServiceWorker(true);
      await page.setBypassCSP(true);
      await page.setExtraHTTPHeaders({ "Accept-Language": "ja-JP" });
      const worker = new TabletWorker(
        context,
        page,
        db,
        url,
        entity.id,
        progress,
        navigationWaitUntil,
      );
      const lcps = new LcpRepository(db);
      page.on("console", (message) => {
        if (!worker.collecting || message.type() !== "trace") return;
        try {
          const value: unknown = JSON.parse(message.text());
          if (!value || typeof value !== "object") return;
          const entry = value as Record<string, unknown>;
          if (
            entry["collectionId"] !== 1 ||
            typeof entry["lcp"] !== "number" ||
            !Number.isFinite(entry["lcp"]) ||
            typeof entry["xpath"] !== "string"
          )
            return;
          const lcp = entry["lcp"];
          const xpath = entry["xpath"];
          worker.writes = worker.writes.then(async () => {
            await lcps.save(lcp, xpath, entity.id);
            progress("candidate-collected", { lcpMs: lcp, xpath });
          });
          // Keep errors for the awaited flush without an unhandled rejection.
          void worker.writes.catch(() => {});
        } catch {
          /* Other page console traces are not LCP reports. */
        }
      });
      return worker;
    } catch (error) {
      await context.close();
      await new Promise<void>((resolve) => db.close(() => resolve()));
      throw error;
    }
  }

  async render(access: number, send: (frame: EvaluationFrame) => void) {
    if (access !== this.nextAccess || access > 5)
      throw new Error("Unexpected access number");
    this.collecting = access === 0;
    if (this.scriptId) {
      await this.page.removeScriptToEvaluateOnNewDocument(this.scriptId);
      this.scriptId = undefined;
    }
    if (this.collecting) {
      const source = await fs.readFile("lcp.js", "utf8");
      this.scriptId = (
        await this.page.evaluateOnNewDocument(
          `window.__lcpCollectionId = 1;\n${source}`,
        )
      ).identifier;
    }
    this.progress("navigate-start", {
      access: access + 1,
      url: this.url,
      waitUntil: this.navigationWaitUntil,
    });
    const navigationStart = performance.now();
    const response = await this.page
      .goto(this.url, {
        waitUntil: this.navigationWaitUntil,
        timeout: 60000,
      })
      .catch((error: unknown) => {
        this.progress("navigate-failed", {
          access: access + 1,
          waitUntil: this.navigationWaitUntil,
          elapsedMs: performance.now() - navigationStart,
          error: String(error),
        });
        if (error instanceof Error && error.name === "TimeoutError")
          throw new Error(
            `ページ読み込み待ち（${this.navigationWaitUntil}）が60秒でタイムアウトしました。画像の撮影・転送はまだ開始していません。待機条件を確認してください。`,
          );
        throw error;
      });
    const finalUrl = this.page.url();
    this.progress("navigate-complete", {
      access: access + 1,
      url: finalUrl,
      status: response?.status() ?? null,
      waitUntil: this.navigationWaitUntil,
      elapsedMs: performance.now() - navigationStart,
    });
    const candidates: CandidateResult[] = [];
    const frames: EvaluationFrame[] = [];
    const emit = async (
      image: Buffer,
      data: Omit<EvaluationFrame, "img" | "frameId" | "url">,
    ) => {
      let width = (await sharp(image).metadata()).width ?? data.width;
      while (image.length > 64000 && width > 1) {
        width = Math.max(1, Math.trunc(width / 2));
        image = await sharp(image).resize(width).webp().toBuffer();
      }
      const frame = {
        ...data,
        frameId: frames.length + 1,
        img: image,
        url: finalUrl,
      };
      frames.push(frame);
      send(frame);
    };
    if (access > 0) {
      const entries = await new LcpRepository(this.db).findAllByUrlId(
        this.urlId,
      );
      for (const entry of entries) {
        const result: CandidateResult = {
          xpath: entry.xpath,
          lcp: entry.lcp,
          status: "not-found",
        };
        try {
          const [element] = await this.page.$x(entry.xpath);
          if (element) {
            const box = await element.boundingBox();
            if (box && box.width > 0 && box.height > 0) {
              this.progress("capture-start", {
                access: access + 1,
                kind: "lcp",
                xpath: entry.xpath,
              });
              const image = await element.screenshot({ type: "webp" });
              await emit(image, { kind: "lcp", xpath: entry.xpath, ...box });
              result.status = "sent";
            } else result.status = "no-bounding-box";
          }
        } catch (error) {
          result.status = "error";
          result.detail = String(error);
        }
        candidates.push(result);
        if (result.status !== "sent")
          this.progress("candidate-skipped", { access: access + 1, ...result });
      }
    }
    await this.page.evaluate(() => window.scrollTo(0, 0));
    this.progress("capture-start", { access: access + 1, kind: "viewport" });
    const viewport = await this.page.screenshot({ type: "webp" });
    if (this.collecting) {
      await this.page.evaluate("window.__stopLcpCollection?.()");
      this.collecting = false;
      await this.writes;
    }
    const size = this.page.viewport()!;
    await emit(viewport, {
      kind: "viewport",
      x: 0,
      y: 0,
      width: size.width,
      height: size.height,
    });
    await new Promise<void>((resolve, reject) =>
      this.db.run(
        "UPDATE url SET access_num = access_num + 1 WHERE id = ?",
        [this.urlId],
        (error) => (error ? reject(error) : resolve()),
      ),
    );
    const collected = await new LcpRepository(this.db).findAllByUrlId(
      this.urlId,
    );
    if (access === 0)
      this.progress("collection-complete", { candidates: collected.length });
    this.nextAccess++;
    return {
      frames,
      finalUrl,
      candidates,
      collected: { candidates: collected.length },
    };
  }

  async saveInitial(lcp: number) {
    await new UrlRepository(this.db).updateImageLcpByUrl(this.url, lcp);
  }

  async abort() {
    this.collecting = false;
    await this.context.close();
  }

  async close() {
    this.collecting = false;
    await this.context.close().catch(() => {});
    await this.writes.catch(() => {});
    await new Promise<void>((resolve, reject) =>
      this.db.close((error) => (error ? reject(error) : resolve())),
    );
  }
}
