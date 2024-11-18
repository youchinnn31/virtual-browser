"use strict";

import { Database } from "sqlite3";
import { LcpEntity } from "../types/lcpEntity";

/**
 * LCPテーブル用のレポジトリ
 */
export class LcpRepository {
  /** データベースインスタンス*/
  private db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  /**
   * LCPテーブルに保存する
   */
  async save(lcp: number, url: string, urlId: number): Promise<void> {
    this.db.run(
      // "INSERT INTO lcp(lcp_metric, url_id) VALUES(JSON($lcp_metric), $url_id)",
      "INSERT INTO lcp(lcp, url, url_id) VALUES($lcp, $url , $url_id)",
      {
        $lcp: lcp,
        $url: url,
        $url_id: urlId,
      },
    );
  }

  /**
   * LcpEntity[]をurlIdから取得
   */
  async findAllByUrlId(urlId: number): Promise<Array<LcpEntity>> {
    return new Promise((resolve, reject) => {
      this.db.all(
        "SELECT * FROM lcp WHERE url_id = $urlId ORDER BY lcp DESC",
        { $urlId: urlId },
        (err, row: Array<LcpEntity>) => {
          if (err) {
            return reject(err);
          }
          resolve(row);
        },
      );
    });
  }
}
