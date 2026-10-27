"use strict";

/**
 * WebSocketのリクエスト情報
 */
export interface WSRequest {
  /** ユーザの操作 */
  action: "image" | "scroll" | "click" | "lcp" | "init";
  /** リクエストURL or アクセスしているURL */
  url: string;
  /** 対象サイト取得時のHTTPキャッシュ。省略時はサーバーの既定値 */
  cacheEnabled?: boolean;
  /** ビューポートのwidth */
  width: number;
  /** ビューポートのheight */
  height: number;
  /** ユーザエージェント */
  userAgent: string;
  /** クリックのx座標 */
  x: number;
  /** クリックのy座標 */
  y: number;
  /** 測定したLCP時間 */
  lcp: number;
  /** スクロール量 */
  scrollAmount: number;
}
