"use strict";

/**
 * WebSocketのレスポンス情報
 */
export interface WSResponse {
  /** サーバがアクセスしたURL */
  url: string;
  /** スクショデータ */
  img: Buffer;
  /** コンテンツのx座標 */
  x: number;
  /** コンテンツのy座標 */
  y: number;
}
