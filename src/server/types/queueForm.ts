"use strict";

/**
 * Queueに入れるコンテンツ
 */
export interface QueueForm {
  /** LCPの値 */
  lcp: number;
  /** LCPのセレクタ */
  selector: string;
  /** ページのId */
  urlId: number;
}
