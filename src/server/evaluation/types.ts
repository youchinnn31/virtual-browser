import type { CandidateResult } from "../rendering/types";

export type {
  CandidateResult,
  NavigationWaitUntil,
  RenderFrame as EvaluationFrame,
} from "../rendering/types";

export interface DeviceInfo {
  name: string;
  userAgent: string;
  width: number;
  height: number;
  dpr: number;
  orientation: string;
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
