"use strict";

// import { Entries } from "./entries";

/**
 * LCPコンテンツのMetric
 */
export interface LcpMetric {
  // //** Metric名 */
  // name: "CLS" | "FCP" | "FID" | "INP" | "LCP" | "TTFB";
  // //** 時間  */
  // value: number;
  // //** valueの評価  */
  // rating: "good" | "needs-improvement" | "poor";
  // //** 一個前のvalueとの差  */
  // delta: number;
  // //**  */
  // entries: Array<Entries>;
  // //** Metricのインスタンスid */
  // id: string;
  // //** NavivationTimeAPIの種類 */
  // navigationType:
  //   | "navigate"
  //   | "reload"
  //   | "back-forward"
  //   | "back-forward-cache"
  //   | "prerender"
  //   | "restore";
  lcp: number;
  selector: string;
}
