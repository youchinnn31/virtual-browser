"use strict";

/**
 * UrlテーブルのEntity
 */
export interface UrlEntity {
  /** プライマリキー */
  id: number;
  /** アクセスURL */
  url: string;
  /** 画像化のLCP */
  image_lcp: number;
  /** アクセス回数 */
  access_num: number;
}
