"use strict";

/**
 * WebSocketのレスポンス情報
 */
export interface WSResponse {
  /** 画像の種類と、部分画像の場合のXPath */
  kind?: "lcp" | "viewport";
  xpath?: string;
  /** サーバがアクセスしたURL */
  url: string;
  /** スクショデータ */
  img: Buffer;
  /** コンテンツのx座標 */
  x: number;
  /** コンテンツのy座標 */
  y: number;
}
