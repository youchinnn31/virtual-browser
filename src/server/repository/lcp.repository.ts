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
  async save(lcp: number, xpath: string, urlId: number): Promise<void> {
    return new Promise((resolve, reject) => {
      this.db.run(
        "INSERT INTO lcp(lcp, xpath, url_id) VALUES($lcp, $xpath , $url_id)",
        { $lcp: lcp, $xpath: xpath, $url_id: urlId },
        (error) => {
          if (error) reject(error);
          else resolve();
        },
      );
    });
  }

  /**
   * urlIdからLcpEntity[]を取得
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
