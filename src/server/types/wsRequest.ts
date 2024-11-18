"use strict";

/**
 * WebSocketのリクエスト情報
 */
export interface WSRequest {
  /** ユーザの操作 */
  action: "init" | "click" | "lcp";
  /** リクエストURL or アクセスしているURL */
  url: string;
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
}
