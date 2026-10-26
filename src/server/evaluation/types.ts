export type NavigationWaitUntil = "domcontentloaded" | "load" | "networkidle2";

export interface DeviceInfo {
  name: string;
  userAgent: string;
  width: number;
  height: number;
  dpr: number;
  orientation: string;
}

export interface CandidateResult {
  xpath: string;
  lcp: number;
  status: "sent" | "not-found" | "no-bounding-box" | "error";
  detail?: string;
}

export interface EvaluationFrame {
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

export interface Sample {
  trial: number;
  access: number;
  lcp: number;
  renderKind: "lcp" | "viewport";
  firstXpath: string;
  finalUrl: string;
  lcpImages: number;
  candidates: CandidateResult[];
}

export interface ReportRow {
  url: string;
  speed: number;
  database: string;
  status: string;
  samples: Sample[];
  warmup?: number;
  collected?: { candidates: number };
}
