"use strict";

import { Database } from "sqlite3";
import { UrlEntity } from "../types/urlEntity";

/**
 * URLテーブルのレポジトリ
 */
export class UrlRepository {
  /** データベースインスタンス*/
  private db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  /**
   * URLテーブルに保存する
   */
  async save(url: string): Promise<void> {
    this.db.run("INSERT OR IGNORE INTO url(url, image_lcp) VALUES($url, -1)", {
      $url: url,
    });
  }

  /**
   * UrlEntityをidから取得
   */
  async findById(id: number): Promise<UrlEntity> {
    return new Promise((resolve, reject) => {
      this.db.get(
        "SElECT * FROM url WHERE id = $id",
        { $id: id },
        (err, row: UrlEntity) => {
          if (err) {
            return reject(err);
          }
          resolve(row);
        },
      );
    });
  }

  /**
   * UrlEntityをurlから取得
   */
  async findByUrl(url: string): Promise<UrlEntity> {
    return new Promise((resolve, reject) => {
      this.db.get(
        "SELECT * FROM url WHERE url = $url",
        { $url: url },
        (err, row: UrlEntity) => {
          if (err) {
            return reject(err);
          }
          resolve(row);
        },
      );
    });
  }

  /**
   * UrlEntityをurlからimage_lcpを更新
   */
  async updateImageLcpByUrl(url: string, imageLcp: number): Promise<void> {
    this.db.run("UPDATE url SET image_lcp = $image_lcp WHERE url = $url", {
      $image_lcp: imageLcp,
      $url: url,
    });
  }
}
