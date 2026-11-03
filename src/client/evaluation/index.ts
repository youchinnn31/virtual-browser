import {
  parseConfig,
  type ClientMessage,
  type DeviceInfo,
  type Phase,
  type ServerMessage,
  type Summary,
  type TrialResult,
} from "../../evaluation/protocol";

const settings = document.querySelector<HTMLFormElement>("#settings")!;
const controls = document.querySelector<HTMLElement>("#evaluation-controls")!;
const showBrowserButton =
  document.querySelector<HTMLButtonElement>("#show-browser")!;
const urlButton = document.querySelector<HTMLButtonElement>("#url-button")!;
const urlInput = document.querySelector<HTMLInputElement>("#url-input")!;
const fields = document.querySelector<HTMLFieldSetElement>("#fields")!;
const startButton = document.querySelector<HTMLButtonElement>("#start")!;
const stopButton = document.querySelector<HTMLButtonElement>("#stop")!;
const confirmButton =
  document.querySelector<HTMLButtonElement>("#confirm-profile")!;
const statusElement = document.querySelector<HTMLElement>("#status")!;
const connectionElement = document.querySelector<HTMLElement>("#connection")!;
const profilePanel = document.querySelector<HTMLElement>("#profile-panel")!;
const profileName = document.querySelector<HTMLElement>("#profile-name")!;
const trialUrl = document.querySelector<HTMLElement>("#trial-url")!;
const canvas = document.querySelector<HTMLCanvasElement>("#browser")!;
const context = canvas.getContext("2d")!;
const summaries =
  document.querySelector<HTMLTableSectionElement>("#summaries")!;
const trials = document.querySelector<HTMLTableSectionElement>("#trials")!;
const downloads = document.querySelector<HTMLElement>("#downloads")!;
const resultsDirectoryElement =
  document.querySelector<HTMLElement>("#results-directory")!;

interface Trial {
  id: string;
  phase: Phase;
  startedAt: number;
  expectedCount: number | null;
  viewportMs: number | null;
  received: Set<number>;
  rendered: Set<number>;
  loading: Map<number, { image: HTMLImageElement; url: string }>;
  complete: boolean;
  timer: ReturnType<typeof setTimeout>;
}

let socket: WebSocket | null = null;
let running = false;
let abortRequested = false;
let runId: string | null = null;
let active: Trial | null = null;
let device: DeviceInfo | null = null;
let profile: Extract<ServerMessage, { action: "profile:required" }> | null =
  null;
const descriptions = new Map<string, { url: string; profile: string }>();

function errorLabel(error: string): string {
  const labels: Record<string, string> = {
    trial_timeout: "アクセス全体の上限時間を超過しました",
    image_decode_failed: "受信画像を読み込めませんでした",
    canvas_render_failed: "画像を描画できませんでした",
    warmup_failed: "準備アクセス失敗のためスキップ",
    evaluation_browser_closed: "評価用ブラウザの終了によりスキップ",
    client_hidden: "ページが前面から外れました",
    user_aborted: "中断ボタンが押されました",
    client_disconnected: "端末との接続が切れました",
    server_shutdown: "評価サーバが停止しました",
  };
  return labels[error] ?? error;
}

function send(message: ClientMessage): boolean {
  if (socket?.readyState !== WebSocket.OPEN) return false;
  socket.send(JSON.stringify(message));
  return true;
}

function formatTime(value: number | null): string {
  return value === null ? "—" : `${(value / 1000).toFixed(3)} 秒`;
}

function releaseImage(trial: Trial, index: number): void {
  const pending = trial.loading.get(index);
  if (!pending) return;
  pending.image.onload = null;
  pending.image.onerror = null;
  URL.revokeObjectURL(pending.url);
  trial.loading.delete(index);
}

function clearTrial(): void {
  const trial = active;
  active = null;
  if (!trial) return;
  clearTimeout(trial.timer);
  for (const [index, pending] of trial.loading) {
    releaseImage(trial, index);
    pending.image.src = "";
  }
}

function showDownloads(id: string): void {
  downloads.replaceChildren();
  for (const [file, label] of [
    ["summary.csv", "全体の分析CSV"],
    ["measurements.csv", "各アクセスのCSV"],
    ["evaluation.sqlite", "評価DB"],
  ]) {
    const link = document.createElement("a");
    link.href = `/results/${encodeURIComponent(id)}/${file}`;
    link.textContent = label!;
    link.download = file!;
    downloads.append(link);
  }
  downloads.hidden = false;
}

function reset(): void {
  clearTrial();
  running = false;
  abortRequested = false;
  profile = null;
  profilePanel.hidden = true;
  controls.hidden = false;
  trialUrl.hidden = true;
  settings.hidden = false;
  fields.disabled = false;
  startButton.disabled = socket?.readyState !== WebSocket.OPEN;
  stopButton.disabled = true;
}

function abort(reason: string): void {
  if (!running || abortRequested) return;
  abortRequested = true;
  clearTrial();
  profilePanel.hidden = true;
  stopButton.disabled = true;
  statusElement.textContent = "評価を中断しています…";
  controls.hidden = false;
  send({ action: "run:abort", reason });
}

function failTrial(trial: Trial, error: string): void {
  if (active !== trial) return;
  send({ action: "trial:error", trialId: trial.id, error });
  clearTrial();
}

function completeIfRendered(trial: Trial): void {
  if (
    active !== trial ||
    trial.complete ||
    trial.expectedCount !== 1 ||
    trial.received.size !== 1 ||
    trial.rendered.size !== 1 ||
    trial.viewportMs === null
  )
    return;
  trial.complete = true;
  clearTimeout(trial.timer);
  send({
    action: "trial:complete",
    trialId: trial.id,
    viewportMs: trial.viewportMs,
    renderedCount: 1,
  });
}

function renderImage(
  message: Extract<ServerMessage, { action: "trial:image" }>,
): void {
  const trial = active;
  if (!trial || trial.id !== message.trialId || abortRequested) return;
  if (trial.complete || trial.received.size !== 0) {
    failTrial(trial, "duplicate_or_late_image");
    return;
  }
  if (message.kind !== "viewport" || message.imageIndex !== 1) {
    failTrial(trial, "invalid_viewport_image");
    return;
  }
  trial.received.add(message.imageIndex);
  urlInput.value = message.url;
  const image = new Image();
  const url = URL.createObjectURL(
    new Blob([new Uint8Array(message.img.data)], { type: "image/webp" }),
  );
  trial.loading.set(message.imageIndex, { image, url });
  image.onload = () => {
    try {
      if (active !== trial || abortRequested) return;
      context.drawImage(image, message.x, message.y);
      const elapsed = performance.now() - trial.startedAt;
      trial.viewportMs = elapsed;
      statusElement.textContent = `ビューポート：${formatTime(elapsed)}`;
      trial.rendered.add(message.imageIndex);
      completeIfRendered(trial);
    } catch {
      failTrial(trial, "canvas_render_failed");
    } finally {
      releaseImage(trial, message.imageIndex);
    }
  };
  image.onerror = () => {
    releaseImage(trial, message.imageIndex);
    failTrial(trial, "image_decode_failed");
  };
  image.src = url;
}

function addTrial(result: TrialResult): void {
  const row = trials.insertRow();
  const description = descriptions.get(result.evaluationId);
  row.dataset["phase"] = result.phase;
  row.dataset["status"] = result.status;
  row.dataset["trialId"] = result.trialId;
  for (const value of [
    description?.url ?? "—",
    description?.profile ?? "—",
    result.phase === "warmup"
      ? "準備（中央値の対象外）"
      : `計測 ${result.measurementIndex}`,
    formatTime(result.viewportMs),
    String(result.imageCount),
    result.error ? errorLabel(result.error) : "成功",
  ])
    row.insertCell().textContent = value;
}

function addSummary(summary: Summary): void {
  const row = summaries.insertRow();
  row.dataset["evaluationId"] = summary.evaluationId;
  row.dataset["status"] = summary.status;
  for (const value of [
    summary.url,
    summary.profile,
    `${summary.successfulCount} / ${summary.measurementCount}`,
    formatTime(summary.viewportMedianMs),
    summary.status === "complete" ? "完了" : "欠測あり",
  ])
    row.insertCell().textContent = value;
}

function receive(message: ServerMessage): void {
  switch (message.action) {
    case "connection:ready":
      connectionElement.textContent = "接続済み";
      startButton.disabled = running;
      break;
    case "run:created":
      runId = message.runId;
      resultsDirectoryElement.textContent = `サーバPCの保存先：${message.resultsDirectory}`;
      resultsDirectoryElement.hidden = false;
      statusElement.textContent = `${message.evaluationCount}件の評価を開始します。`;
      break;
    case "profile:required":
      if (abortRequested) break;
      profile = message;
      profileName.textContent = message.profile;
      profilePanel.hidden = false;
      controls.hidden = false;
      statusElement.textContent = "Charlesの設定確認を待っています。";
      break;
    case "trial:ready": {
      if (
        !running ||
        abortRequested ||
        document.visibilityState !== "visible"
      ) {
        abort("client_hidden");
        break;
      }
      clearTrial();
      descriptions.set(message.evaluationId, {
        url: message.url,
        profile: message.profile,
      });
      context.clearRect(0, 0, canvas.width, canvas.height);
      trialUrl.textContent = `${message.profile} · ${message.url}`;
      statusElement.textContent =
        message.phase === "warmup"
          ? "準備アクセス：ビューポート表示を準備中"
          : `計測 ${message.measurementIndex}：ビューポート画像を準備中`;
      const trial: Trial = {
        id: message.trialId,
        phase: message.phase,
        startedAt: performance.now(),
        expectedCount: null,
        viewportMs: null,
        received: new Set(),
        rendered: new Set(),
        loading: new Map(),
        complete: false,
        timer: setTimeout(() => {
          failTrial(trial, "trial_timeout");
        }, message.timeoutMs),
      };
      active = trial;
      send({ action: "trial:start", trialId: trial.id });
      break;
    }
    case "trial:image":
      renderImage(message);
      break;
    case "trial:images-end":
      if (active?.id === message.trialId) {
        if (
          message.kind !== "viewport" ||
          message.imageCount !== 1 ||
          active.received.size !== 1
        ) {
          failTrial(active, "invalid_image_count");
        } else {
          active.expectedCount = 1;
          completeIfRendered(active);
        }
      }
      break;
    case "trial:saved":
      if (active?.id === message.result.trialId) clearTrial();
      addTrial(message.result);
      break;
    case "evaluation:complete":
      addSummary(message.summary);
      break;
    case "run:finished":
      reset();
      showDownloads(message.runId);
      downloads.scrollIntoView({ block: "start" });
      statusElement.textContent =
        message.status === "completed"
          ? "評価が終了しました。結果をダウンロードできます。"
          : `評価を中断しました：${errorLabel(message.error ?? message.status)}`;
      break;
    case "error":
      if (runId && running) abort("server_error");
      else reset();
      statusElement.textContent = message.error;
      break;
  }
}

function connect(): void {
  const url = new URL("/ws", window.location.href);
  url.protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  socket = new WebSocket(url);
  socket.addEventListener("open", () => {
    const browserTop: number = canvas.getBoundingClientRect().top;
    const width: number = Math.trunc(
      canvas.clientWidth / window.devicePixelRatio,
    );
    const height: number = Math.trunc(
      (window.innerHeight - browserTop) / window.devicePixelRatio,
    );
    canvas.width = width;
    canvas.height = height;
    device = {
      width,
      height,
      devicePixelRatio: window.devicePixelRatio,
      userAgent: window.navigator.userAgent,
    };
  });
  socket.addEventListener("message", (event: MessageEvent<string>) => {
    try {
      receive(JSON.parse(event.data) as ServerMessage);
    } catch {
      abort("invalid_server_message");
      statusElement.textContent = "受信したデータを処理できませんでした。";
    }
  });
  socket.addEventListener("close", () => {
    const wasRunning = running;
    device = null;
    reset();
    connectionElement.textContent = "切断・再接続待ち";
    startButton.disabled = true;
    if (wasRunning) {
      statusElement.textContent =
        "接続が切れたため評価を中断しました。保存済みの結果は残ります。";
      if (runId) showDownloads(runId);
    }
    setTimeout(connect, 1500);
  });
  socket.addEventListener("error", () => {
    connectionElement.textContent = "接続できません";
  });
}

settings.addEventListener("submit", (event) => {
  event.preventDefault();
  if (running || !device || socket?.readyState !== WebSocket.OPEN) return;
  try {
    const lines = (id: string): string[] =>
      document
        .querySelector<HTMLTextAreaElement>(id)!
        .value.split(/\r?\n/)
        .map((value) => value.trim())
        .filter(Boolean);
    const config = parseConfig({
      urls: lines("#urls"),
      profiles: lines("#profiles"),
      measurementCount: Number(
        document.querySelector<HTMLInputElement>("#measurement-count")!.value,
      ),
      trialTimeoutMs:
        Number(document.querySelector<HTMLInputElement>("#timeout")!.value) *
        1000,
    });
    if (document.visibilityState !== "visible")
      throw new Error("ページを前面に表示してください。");
    running = true;
    abortRequested = false;
    runId = null;
    fields.disabled = true;
    settings.hidden = true;
    controls.hidden = true;
    trialUrl.hidden = false;
    stopButton.disabled = false;
    summaries.replaceChildren();
    trials.replaceChildren();
    descriptions.clear();
    downloads.hidden = true;
    resultsDirectoryElement.hidden = true;
    trialUrl.textContent = "";
    statusElement.textContent = "評価を準備しています…";
    send({ action: "run:start", config, device });
  } catch (error) {
    reset();
    statusElement.textContent =
      error instanceof Error ? error.message : String(error);
  }
});

confirmButton.addEventListener("click", () => {
  if (!profile || abortRequested) return;
  send({
    action: "profile:confirmed",
    runId: profile.runId,
    profileIndex: profile.profileIndex,
  });
  profile = null;
  profilePanel.hidden = true;
  controls.hidden = true;
  statusElement.textContent = "評価を進めています…";
});
stopButton.addEventListener("click", () => abort("user_aborted"));
document.addEventListener("visibilitychange", () => {
  if (running && document.visibilityState !== "visible") abort("client_hidden");
});
urlButton.addEventListener("click", () => {
  controls.hidden = false;
});
showBrowserButton.addEventListener("click", () => {
  controls.hidden = true;
});
connect();
