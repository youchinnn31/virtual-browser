export type NavigationWaitUntil = "domcontentloaded" | "load" | "networkidle2";

export interface CandidateResult {
  xpath: string;
  lcp: number;
  status: "sent" | "not-found" | "no-bounding-box" | "error";
  detail?: string;
}

export interface RenderFrame {
  frameId: number;
  kind: "lcp" | "viewport";
  xpath?: string;
  img: Buffer;
  x: number;
  y: number;
  width: number;
  height: number;
  url: string;
}

export type RenderProgress = (
  event: string,
  details: Record<string, unknown>,
) => void;

export interface RenderOptions {
  waitUntil?: NavigationWaitUntil;
  timeout?: number;
  /** Omit to collect only while the URL has no saved initial display time. */
  collect?: boolean;
  access?: number;
  progress?: RenderProgress;
}
