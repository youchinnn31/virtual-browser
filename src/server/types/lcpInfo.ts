"use strict";

/**
 * 仮想ブラウザから受け取るLCP周りの情報
 */
export interface LcpInfo {
  /** LCPの値 */
  lcp: number;
  /** 現在のurl */
  url: string;
  /** セレクタ */
  selector: string;
}
