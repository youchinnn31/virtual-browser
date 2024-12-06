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
  async save(lcp: number, selector: string, urlId: number): Promise<void> {
    this.db.run(
      "INSERT INTO lcp(lcp, selector, url_id) VALUES($lcp, $selector , $url_id)",
      {
        $lcp: lcp,
        $selector: selector,
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
