"use strict";

/**
 * LcpテーブルのEntity
 */
export interface LcpEntity {
  /** プライマリキー */
  id: number;
  /** */
  lcp: number;
  /** */
  url: string;
  // /** LCP情報のJSON文字列 */
  // lcp_metric: string;
}
