export interface EvaluationConfig {
  urls: string[];
  profiles: string[];
  measurementCount: number;
  trialTimeoutMs: number;
}

export interface DeviceInfo {
  userAgent: string;
  width: number;
  height: number;
  devicePixelRatio: number;
}

export type Phase = "warmup" | "measurement";
export type TrialStatus = "success" | "failed" | "skipped";

export interface TrialResult {
  trialId: string;
  evaluationId: string;
  phase: Phase;
  measurementIndex: number;
  finalUrl: string;
  status: TrialStatus;
  viewportMs: number | null;
  imageCount: number;
  error: string | null;
}

export interface Summary {
  evaluationId: string;
  url: string;
  profile: string;
  method: "viewport";
  measurementCount: number;
  successfulCount: number;
  viewportMedianMs: number | null;
  status: "complete" | "incomplete";
}

export type ClientMessage =
  | { action: "run:start"; config: EvaluationConfig; device: DeviceInfo }
  | { action: "run:abort"; reason: string }
  | { action: "profile:confirmed"; runId: string; profileIndex: number }
  | { action: "trial:start"; trialId: string }
  | {
      action: "trial:complete";
      trialId: string;
      viewportMs: number;
      renderedCount: number;
    }
  | { action: "trial:error"; trialId: string; error: string };

export type ServerMessage =
  | { action: "connection:ready" }
  | {
      action: "run:created";
      runId: string;
      resultsDirectory: string;
      evaluationCount: number;
    }
  | {
      action: "profile:required";
      runId: string;
      profileIndex: number;
      profile: string;
    }
  | {
      action: "trial:ready";
      trialId: string;
      evaluationId: string;
      url: string;
      profile: string;
      phase: Phase;
      measurementIndex: number;
      timeoutMs: number;
    }
  | {
      action: "trial:image";
      trialId: string;
      imageIndex: number;
      kind: "viewport";
      url: string;
      img: { type: "Buffer"; data: number[] };
      x: number;
      y: number;
    }
  | {
      action: "trial:images-end";
      trialId: string;
      kind: "viewport";
      imageCount: number;
    }
  | { action: "trial:saved"; result: TrialResult }
  | { action: "evaluation:complete"; summary: Summary }
  | {
      action: "run:finished";
      runId: string;
      status: "completed" | "aborted" | "failed";
      error: string | null;
    }
  | { action: "error"; error: string };

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("メッセージはオブジェクトで指定してください。");
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${name}を指定してください。`);
  }
  return value.trim();
}

function positive(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${name}は正の数で指定してください。`);
  }
  return value;
}

function integer(value: unknown, name: string, minimum = 0): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum
  ) {
    throw new Error(`${name}は${minimum}以上の整数で指定してください。`);
  }
  return value;
}

function strings(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${name}を1件以上指定してください。`);
  }
  return [...new Set(value.map((item: unknown) => text(item, name)))];
}

export function parseConfig(value: unknown): EvaluationConfig {
  const input = record(value);
  const urls = strings(input["urls"], "URL");
  for (const url of urls) {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("URLにはhttpまたはhttpsを指定してください。");
    }
  }
  const trialTimeoutMs = integer(input["trialTimeoutMs"], "試行上限時間", 1);
  if (trialTimeoutMs > 2_147_483_647) {
    throw new Error("試行上限時間が長すぎます。");
  }
  return {
    urls,
    profiles: strings(input["profiles"], "Charlesの通信条件名"),
    measurementCount: integer(input["measurementCount"], "計測回数", 1),
    trialTimeoutMs,
  };
}

export function parseDevice(value: unknown): DeviceInfo {
  const input = record(value);
  const width = integer(input["width"], "画面幅", 1);
  const height = integer(input["height"], "画面高さ", 1);
  if (width > 10_000 || height > 10_000) {
    throw new Error("画面サイズが大きすぎます。");
  }
  return {
    userAgent: text(input["userAgent"], "ユーザーエージェント"),
    width,
    height,
    devicePixelRatio: positive(input["devicePixelRatio"], "端末のDPR"),
  };
}

export function parseClientMessage(value: unknown): ClientMessage {
  const input = record(value);
  const action = input["action"];
  switch (action) {
    case "run:start":
      return {
        action,
        config: parseConfig(input["config"]),
        device: parseDevice(input["device"]),
      };
    case "run:abort":
      return { action, reason: text(input["reason"], "中断理由") };
    case "profile:confirmed":
      return {
        action,
        runId: text(input["runId"], "評価全体ID"),
        profileIndex: integer(input["profileIndex"], "通信条件番号"),
      };
    case "trial:start":
      return { action, trialId: text(input["trialId"], "試行ID") };
    case "trial:complete":
      return {
        action,
        trialId: text(input["trialId"], "試行ID"),
        viewportMs: positive(input["viewportMs"], "ビューポート描画完了時間"),
        renderedCount: integer(input["renderedCount"], "描画枚数", 1),
      };
    case "trial:error":
      return {
        action,
        trialId: text(input["trialId"], "試行ID"),
        error: text(input["error"], "描画エラー"),
      };
    default:
      throw new Error("未対応のメッセージです。");
  }
}
