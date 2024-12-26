"use strict";

/**
 * LcpテーブルのEntity
 */
export interface LcpEntity {
  /** プライマリキー */
  id: number;
  /** LCP時間 */
  lcp: number;
  /** LCPコンテンツのxpath */
  xpath: string;
  /** urlテーブルの外部キー */
  urlId: number;
}
