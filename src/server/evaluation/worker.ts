import sqlite3 from "sqlite3";
import type { Browser, BrowserContext } from "puppeteer";
import { PageRenderer } from "../rendering/page-renderer";
import type { DeviceInfo, EvaluationFrame, NavigationWaitUntil } from "./types";
import type { ProgressLogger } from "./logger";

/** One fresh context and collection DB for one requested URL / speed pair. */
export class TabletWorker {
  private nextAccess = 0;
  private finalUrl: string;

  private constructor(
    private context: BrowserContext,
    private renderer: PageRenderer,
    private db: sqlite3.Database,
    private url: string,
    private progress: ProgressLogger,
    private navigationWaitUntil: NavigationWaitUntil,
  ) {
    this.finalUrl = url;
  }

  static async open(
    browser: Browser,
    database: string,
    url: string,
    device: DeviceInfo,
    progress: ProgressLogger = () => {},
    navigationWaitUntil: NavigationWaitUntil = "networkidle2",
    cacheEnabled = true,
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
      const page = await context.newPage();
      await page.setViewport({
        width: device.width,
        height: device.height,
        isMobile: true,
        deviceScaleFactor: 1,
      });
      await page.setUserAgent(device.userAgent);
      await page.setCacheEnabled(cacheEnabled);
      await page.setBypassCSP(true);
      await page.setExtraHTTPHeaders({ "Accept-Language": "ja-JP" });
      return new TabletWorker(
        context,
        await PageRenderer.create(page, db),
        db,
        url,
        progress,
        navigationWaitUntil,
      );
    } catch (error) {
      await context.close();
      await new Promise<void>((resolve) => db.close(() => resolve()));
      throw error;
    }
  }

  async render(access: number, send: (frame: EvaluationFrame) => void) {
    if (access !== this.nextAccess || access > 5)
      throw new Error("Unexpected access number");
    const result = await this.renderer.render(this.url, send, {
      collect: access === 0,
      access: access + 1,
      waitUntil: this.navigationWaitUntil,
      timeout: 30000,
      progress: this.progress,
    });
    this.finalUrl = result.finalUrl;
    this.nextAccess++;
    return result;
  }

  async saveInitial(lcp: number) {
    await this.renderer.saveInitial(this.finalUrl, lcp);
  }

  async abort() {
    await this.context.close();
  }

  async close() {
    try {
      await this.renderer.close();
    } finally {
      await this.context.close().catch(() => {});
      await new Promise<void>((resolve, reject) =>
        this.db.close((error) => (error ? reject(error) : resolve())),
      );
    }
  }
}
