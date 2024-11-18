"use strict";

/**
 * Infoのentriesの中身
 */
export interface Entries {
  /** 常に空文字列 */
  name: "";
  /** 常にlcpを指す */
  entryType: "largest-contentful-paint";
  /** renderTime if it is not 0, otherwise loadTime*/
  startTime: number;
  /** lcpは非対応なので常に0 */
  duration: 0;
  /** 画像要素の面積（width * height）*/
  size: number;
  /** 要素が画面にレンダリグされた時間 */
  renderTime: number;
  /** 要素がロードされた時間 */
  loadTime: number;
  /** 謎 */
  firstAnimatedFrameTime: number;
  /** 要素のid idがない場合には空 */
  id: string;
  /** 画像ならそのURL */
  url: string;
}
