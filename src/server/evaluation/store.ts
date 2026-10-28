import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import sqlite3 from "sqlite3";
import type {
  DeviceInfo,
  NavigationWaitUntil,
  ReportRow,
  Sample,
} from "./types";

export interface RunConfig {
  device: DeviceInfo;
  urls: string[];
  speeds: number[];
  speedMode: "external-unverified";
  navigationWaitUntil?: NavigationWaitUntil;
  cacheEnabled?: boolean;
  versions?: {
    node: string;
    chrome: string;
    revision: string;
    charles: string;
  };
}

export class RunStore {
  readonly rows: ReportRow[] = [];
  readonly controls: Array<{ at: string; kind: string; data: unknown }> = [];
  private conditions = new Map<string, ReportRow>();

  private constructor(
    readonly id: string,
    readonly directory: string,
    readonly config: RunConfig,
    private db: sqlite3.Database,
  ) {}

  static async create(root: string, config: RunConfig) {
    config = { ...config, cacheEnabled: config.cacheEnabled ?? true };
    const id = `tablet-${Date.now()}-${randomUUID().slice(0, 8)}`;
    const directory = path.resolve(root, id);
    await fs.mkdir(path.join(directory, "collected"), { recursive: true });
    await fs.writeFile(
      path.join(directory, "config.json"),
      JSON.stringify(
        {
          ...config,
          createdAt: new Date().toISOString(),
          proxyDeviceScaleFactor: 1,
        },
        null,
        2,
      ),
    );
    const db = new sqlite3.Database(path.join(directory, "results.db"));
    const store = new RunStore(id, directory, config, db);
    try {
      await new Promise<void>((resolve, reject) =>
        db.exec(
          "PRAGMA journal_mode=WAL;" +
            "CREATE TABLE runs(id TEXT PRIMARY KEY,status TEXT,config TEXT);" +
            "CREATE TABLE conditions(id TEXT PRIMARY KEY,url TEXT,speed INTEGER,database_path TEXT,status TEXT);" +
            "CREATE TABLE trials(id TEXT PRIMARY KEY,condition_id TEXT,access INTEGER,status TEXT,lcp REAL,render_kind TEXT,payload TEXT,started_at TEXT,ended_at TEXT);" +
            "CREATE TABLE candidate_attempts(trial_id TEXT,ordinal INTEGER,payload TEXT,PRIMARY KEY(trial_id,ordinal));" +
            "CREATE TABLE controls(id INTEGER PRIMARY KEY,at TEXT,kind TEXT,payload TEXT);",
          (error) => (error ? reject(error) : resolve()),
        ),
      );
      await store.run("INSERT INTO runs VALUES(?,?,?)", [
        id,
        "running",
        JSON.stringify(config),
      ]);
      return store;
    } catch (error) {
      await store.close();
      throw error;
    }
  }

  private run(sql: string, parameters: unknown[] = []) {
    return new Promise<void>((resolve, reject) =>
      this.db.run(sql, parameters, (error) =>
        error ? reject(error) : resolve(),
      ),
    );
  }

  async condition(url: string, speed: number) {
    const id = `${this.id}-${this.rows.length + 1}`;
    const row: ReportRow = {
      url,
      speed,
      samples: [],
      status: "running",
      database: path.join(
        this.directory,
        "collected",
        `${this.rows.length + 1}.db`,
      ),
    };
    await this.run("INSERT INTO conditions VALUES(?,?,?,?,?)", [
      id,
      url,
      speed,
      row.database,
      row.status,
    ]);
    this.rows.push(row);
    this.conditions.set(id, row);
    return { id, row };
  }

  async beginTrial(id: string, condition: string, access: number) {
    await this.run(
      "INSERT INTO trials(id,condition_id,access,status,started_at) VALUES(?,?,?,?,?)",
      [id, condition, access + 1, "running", new Date().toISOString()],
    );
  }

  async sample(
    id: string,
    condition: string,
    access: number,
    sample: Sample,
    collected: { candidates: number },
  ) {
    const row = this.conditions.get(condition);
    if (!row) throw new Error("Unknown condition");
    const previous = await new Promise<{ status: string } | undefined>(
      (resolve, reject) =>
        this.db.get(
          "SELECT status FROM trials WHERE id=? AND condition_id=?",
          [id, condition],
          (error, value: { status: string } | undefined) =>
            error ? reject(error) : resolve(value),
        ),
    );
    if (previous?.status === "ok") return;
    if (previous?.status !== "running") throw new Error("Trial is not running");
    await this.run("BEGIN IMMEDIATE");
    try {
      await this.run(
        "UPDATE trials SET status='ok',lcp=?,render_kind=?,payload=?,ended_at=? WHERE id=? AND status='running'",
        [
          sample.lcp,
          sample.renderKind,
          JSON.stringify(sample),
          new Date().toISOString(),
          id,
        ],
      );
      for (let i = 0; i < sample.candidates.length; i++)
        await this.run(
          "INSERT OR IGNORE INTO candidate_attempts VALUES(?,?,?)",
          [id, i, JSON.stringify(sample.candidates[i])],
        );
      await this.run("COMMIT");
    } catch (error) {
      await this.run("ROLLBACK");
      throw error;
    }
    if (access === 0) {
      row.warmup = sample.lcp;
      row.collected = collected;
    } else if (
      !row.samples.some((previous) => previous.access === sample.access)
    )
      row.samples.push(sample);
  }

  async failTrial(id: string, reason: string) {
    await this.run(
      "UPDATE trials SET status='invalid',payload=?,ended_at=? WHERE id=?",
      [JSON.stringify({ error: reason }), new Date().toISOString(), id],
    );
  }

  async finishCondition(id: string, status: string) {
    const row = this.conditions.get(id);
    if (row) row.status = status;
    await this.run("UPDATE conditions SET status=? WHERE id=?", [status, id]);
  }

  async log(kind: string, data: unknown) {
    const entry = { at: new Date().toISOString(), kind, data };
    await this.run("INSERT INTO controls(at,kind,payload) VALUES(?,?,?)", [
      entry.at,
      kind,
      JSON.stringify(data),
    ]);
    this.controls.push(entry);
  }

  async export(status: string) {
    await this.run("UPDATE runs SET status=? WHERE id=?", [status, this.id]);
    const { writeReport } = await import("../../../evaluation/report.mjs");
    const output = path.join(this.directory, "results.xlsx");
    const temporary = path.join(this.directory, "results.tmp.xlsx");
    const device = this.config.device;
    await writeReport(temporary, this.rows, {
      conditions: [
        ["評価方法", "タブレット実機"],
        [
          "代理サーバーHTTPキャッシュ",
          this.config.cacheEnabled ? "有効" : "無効",
        ],
        [
          "HTTPキャッシュの保持範囲",
          this.config.cacheEnabled
            ? "URL・通信速度ごとに空の状態で開始し、初回収集から続く5回の測定まで保持。サイトのHTTPキャッシュ指定に従う"
            : "全6アクセスで利用しない。LCP候補のDBは保持",
        ],
        [
          "撮影開始の待機条件",
          this.config.navigationWaitUntil ?? "networkidle2",
        ],
        ["ページ読み込みのタイムアウト", "30秒"],
        ["Canvas描画", "受信画像のサイズで描画（拡大・縮小なし）"],
        [
          "ビューポート寸法の計算方法",
          "mainと同じ。幅=CanvasのCSS幅÷実機DPR、高さ=(ウィンドウの高さ−Canvas上端)÷実機DPR。小数点以下切り捨て",
        ],
        ["実機名", device.name],
        ["User-Agent", device.userAgent],
        [
          "画面",
          `${device.width}×${device.height} CSS px、実機DPR=${device.dpr}、仮想ブラウザDPR=1`,
        ],
        [
          "クライアントHTTPキャッシュ",
          "評価ページno-store・画像は新規Blob。端末全体のキャッシュ消去は行わない",
        ],
        ["通信制限", "外部設定。仮想ブラウザから対象サイトへの通信は制限なし"],
        ["仮想ブラウザのビューポート寸法", `${device.width}×${device.height}`],
        ["実機DPR", device.dpr],
        ["実機の向き", device.orientation],
        ["仮想ブラウザDPR", 1],
        ["速度設定方法", "Charles等で手動設定"],
        ["速度設定の記録形式", this.config.speedMode],
        ["実行状態", status],
        ["サーバーNode", this.config.versions?.node ?? "未記録"],
        ["仮想Chrome", this.config.versions?.chrome ?? "未記録"],
        ["実装コミット", this.config.versions?.revision ?? "未記録"],
        ["Charlesバージョン", this.config.versions?.charles ?? "未設定"],
        ["注意", "速度は手動設定の申告値。ソフトウェアでは検証していません。"],
      ],
      controls: this.controls,
    });
    await fs.rename(temporary, output);
    return output;
  }

  async close() {
    await new Promise<void>((resolve, reject) =>
      this.db.close((error) => (error ? reject(error) : resolve())),
    );
  }
}
