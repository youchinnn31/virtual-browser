import fs from "node:fs/promises";
import type { ConsoleMessage, Page } from "puppeteer";
import type { Database } from "sqlite3";
import { LcpRepository } from "../repository/lcp.repository";
import { UrlRepository } from "../repository/url.repository";
import { prepareImage } from "./image";
import type {
  CandidateResult,
  RenderFrame,
  RenderOptions,
  RenderProgress,
} from "./types";

interface Collection {
  id: number;
  urlId: number;
  accepting: boolean;
  writes: Promise<void>;
  progress: RenderProgress;
}

/** Owns rendering and LCP collection; callers own the page, DB, and transport. */
export class PageRenderer {
  private urls: UrlRepository;
  private lcps: LcpRepository;
  private navigationId = 0;
  private scriptId: string | undefined;
  private collection: Collection | undefined;

  private constructor(
    private page: Page,
    db: Database,
    private observerSource: string,
  ) {
    this.urls = new UrlRepository(db);
    this.lcps = new LcpRepository(db);
    page.on("console", this.onConsole);
  }

  static async create(page: Page, db: Database) {
    return new PageRenderer(page, db, await fs.readFile("lcp.js", "utf8"));
  }

  private onConsole = (message: ConsoleMessage) => {
    const target = this.collection;
    if (!target?.accepting || message.type() !== "trace") return;
    let value: unknown;
    try {
      value = JSON.parse(message.text());
    } catch {
      return;
    }
    if (!value || typeof value !== "object") return;
    const entry = value as Record<string, unknown>;
    const lcp = entry["lcp"];
    const xpath = entry["xpath"];
    if (
      entry["collectionId"] !== target.id ||
      typeof lcp !== "number" ||
      !Number.isFinite(lcp) ||
      typeof xpath !== "string"
    )
      return;
    target.writes = target.writes.then(async () => {
      await this.lcps.save(lcp, xpath, target.urlId);
      target.progress("candidate-collected", { lcpMs: lcp, xpath });
    });
    // Retain failures for the render/close flush without an unhandled rejection.
    void target.writes.catch(() => {});
  };

  async render(
    url: string,
    send: (frame: RenderFrame) => void,
    options: RenderOptions = {},
  ) {
    const progress: RenderProgress = (event, details) =>
      options.progress?.(event, {
        ...(options.access === undefined ? {} : { access: options.access }),
        ...details,
      });
    await this.urls.save(url);
    const entity = await this.urls.findByUrl(url);
    const collecting = options.collect ?? entity.image_lcp < 0;
    const target: Collection = {
      id: ++this.navigationId,
      urlId: entity.id,
      accepting: collecting,
      writes: Promise.resolve(),
      progress,
    };
    this.collection = target;
    try {
      if (this.scriptId) {
        await this.page.removeScriptToEvaluateOnNewDocument(this.scriptId);
        this.scriptId = undefined;
      }
      if (collecting) {
        this.scriptId = (
          await this.page.evaluateOnNewDocument(
            `window.__lcpCollectionId = ${target.id};\n${this.observerSource}`,
          )
        ).identifier;
      }

      const waitUntil = options.waitUntil ?? "networkidle2";
      const timeout = options.timeout ?? 30000;
      progress("navigate-start", { url, waitUntil, timeout });
      const started = performance.now();
      const response = await this.page
        .goto(url, { waitUntil, timeout })
        .catch((error: unknown) => {
          progress("navigate-failed", {
            waitUntil,
            timeout,
            elapsedMs: performance.now() - started,
            error: String(error),
          });
          if (error instanceof Error && error.name === "TimeoutError")
            throw new Error(
              `ページ読み込み待ち（${waitUntil}）が${timeout / 1000}秒でタイムアウトしました。画像の撮影・転送はまだ開始していません。待機条件を確認してください。`,
            );
          throw error;
        });
      const finalUrl = this.page.url();
      progress("navigate-complete", {
        url: finalUrl,
        status: response?.status() ?? null,
        waitUntil,
        timeout,
        elapsedMs: performance.now() - started,
      });
      await this.urls.incrementAccessNumByUrl(url);

      const candidates: CandidateResult[] = [];
      const frames: RenderFrame[] = [];
      const emit = async (
        image: Buffer,
        data: Omit<RenderFrame, "img" | "frameId" | "url">,
      ) => {
        const frame = await this.frame(
          image,
          data,
          frames.length + 1,
          finalUrl,
        );
        frames.push(frame);
        send(frame);
      };
      if (!collecting) {
        const entries = await this.lcps.findAllByUrlId(entity.id);
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
                progress("capture-start", { kind: "lcp", xpath: entry.xpath });
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
            progress("candidate-skipped", { ...result });
        }
      }
      await this.page.evaluate(() => window.scrollTo(0, 0));
      progress("capture-start", { kind: "viewport" });
      const viewport = await this.viewportImage();
      if (collecting) {
        await this.page.evaluate("window.__stopLcpCollection?.()");
        target.accepting = false;
        await target.writes;
      }
      await emit(viewport, this.viewportBounds());
      const collected = await this.lcps.findAllByUrlId(entity.id);
      if (collecting)
        progress("collection-complete", { candidates: collected.length });
      return {
        frames,
        finalUrl,
        candidates,
        collected: { candidates: collected.length },
      };
    } finally {
      target.accepting = false;
      await target.writes;
    }
  }

  async saveInitial(url: string, lcp: number) {
    const entity = await this.urls.findByUrl(url);
    if (entity.image_lcp < 0) await this.urls.updateImageLcpByUrl(url, lcp);
  }

  private viewportImage() {
    return this.page.screenshot({ type: "webp" });
  }

  private viewportBounds() {
    const viewport = this.page.viewport()!;
    return {
      kind: "viewport" as const,
      x: 0,
      y: 0,
      width: viewport.width,
      height: viewport.height,
    };
  }

  private async frame(
    image: Buffer,
    data: Omit<RenderFrame, "img" | "frameId" | "url">,
    frameId: number,
    url = this.page.url(),
  ): Promise<RenderFrame> {
    return {
      ...data,
      frameId,
      img: await prepareImage(image),
      url,
    };
  }

  async captureViewport() {
    return this.frame(await this.viewportImage(), this.viewportBounds(), 1);
  }

  async close() {
    if (this.collection) this.collection.accepting = false;
    this.page.off("console", this.onConsole);
    await this.collection?.writes;
  }
}
