export {};

const element = <T extends HTMLElement>(id: string) =>
  document.getElementById(id) as T;
const startButton = element<HTMLButtonElement>("start");
const stopButton = element<HTMLButtonElement>("stop");
const cacheSelect = element<HTMLSelectElement>("cache-enabled");
const confirmButton = element<HTMLButtonElement>("speed-confirm");
const speedPanel = element<HTMLElement>("speed-panel");
const status = element<HTMLElement>("status");
const download = element<HTMLAnchorElement>("download");
const canvas = element<HTMLCanvasElement>("evaluation-canvas");
const context = canvas.getContext("2d")!;
let socket: WebSocket;
let running = false;
let loaded = false;
let runId = "";
let speedId = "";
let baseline: {
  width: number;
  height: number;
  viewportWidth: number;
  viewportHeight: number;
};
let pendingStop = "";

interface Trial {
  id: string;
  access: number;
  url: string;
  speed: number;
  started: number;
  first: { frameId: number; lcp: number } | null;
  received: Set<number>;
  rendered: Set<number>;
  expected: number[] | null;
  submitted: boolean;
  saved: boolean;
  objectUrls: Set<string>;
  timer: ReturnType<typeof setTimeout>;
}
let trial: Trial | undefined;

function log(text: string) {
  status.textContent = text;
  const item = document.createElement("li");
  item.textContent = text;
  element<HTMLOListElement>("history").prepend(item);
}
function send(action: string, data: object = {}) {
  if (socket.readyState !== WebSocket.OPEN)
    throw new Error("サーバーに接続していません。");
  socket.send(JSON.stringify({ action, runId, ...data }));
}
function discardTrial() {
  if (trial) {
    clearTimeout(trial.timer);
    for (const url of trial.objectUrls) URL.revokeObjectURL(url);
  }
  trial = undefined;
}
function stop(reason: string) {
  if (!running) return;
  pendingStop = reason;
  discardTrial();
  speedPanel.hidden = true;
  stopButton.disabled = true;
  log(`${reason}。取得済み結果を保存しています。`);
  if (runId && socket.readyState === WebSocket.OPEN)
    send("evaluation:stop", { reason });
}
function finish() {
  discardTrial();
  running = false;
  cacheSelect.disabled = false;
  pendingStop = "";
  speedPanel.hidden = true;
  stopButton.disabled = true;
  startButton.disabled = !loaded || socket.readyState !== WebSocket.OPEN;
}
function maybeReport(current: Trial) {
  if (
    trial !== current ||
    current.submitted ||
    !current.first ||
    !current.expected ||
    current.expected.length !== current.rendered.size ||
    !current.expected.every((id) => current.rendered.has(id))
  )
    return;
  current.submitted = true;
  send("evaluation:trial-result", {
    id: current.id,
    firstFrameId: current.first.frameId,
    lcp: current.first.lcp,
    renderedFrameIds: [...current.rendered],
  });
}

function connect(token?: string) {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const next = new WebSocket(
    `${protocol}//${location.host}/evaluation/ws${token ? `?token=${encodeURIComponent(token)}` : ""}`,
  );
  socket = next;
  next.onopen = () => {
    startButton.disabled = running || !loaded;
    if (pendingStop && runId) send("evaluation:stop", { reason: pendingStop });
  };
  next.onclose = () => {
    if (socket !== next) return;
    if (running) {
      discardTrial();
      finish();
      if (runId) {
        download.href = `/evaluation/results/${runId}`;
        download.hidden = false;
      }
      log(
        "接続が切れました。進行中の試行は無効です。保存完了後、Excelリンクから結果を確認してください。",
      );
    } else log("接続が切れました。ページを再読み込みしてください。");
    startButton.disabled = true;
  };
  next.onerror = () => {
    if (socket === next) log("サーバーへの接続に失敗しました。");
  };
  next.onmessage = (event) => {
    if (socket !== next) return;
    try {
      const data = JSON.parse(event.data);
      if (data.runId && runId && data.runId !== runId) return;
      switch (data.action) {
        case "evaluation:hello":
          if (!running)
            log(
              "接続しました。対象URLと速度を選び、測定開始を押してください。",
            );
          break;
        case "evaluation:started":
          runId = data.id;
          download.href = data.download;
          download.hidden = true;
          if (pendingStop) send("evaluation:stop", { reason: pendingStop });
          break;
        case "evaluation:speed-required":
          if (pendingStop) break;
          speedId = data.id;
          confirmButton.disabled = false;
          speedPanel.hidden = false;
          element<HTMLElement>("speed-message").textContent =
            `Charlesで上下とも${data.speed} kbps、追加遅延0msに手動設定してください。設定後、下のボタンを押してください。`;
          log(`${data.speed} kbpsの手動設定を待っています。`);
          break;
        case "evaluation:reconnect": {
          const old = socket;
          connect(data.token);
          old.close();
          break;
        }
        case "evaluation:trial-ready": {
          if (pendingStop) break;
          if (trial && !trial.saved)
            throw new Error("前の試行が保存されていません。");
          discardTrial();
          context.clearRect(0, 0, canvas.width, canvas.height);
          const current: Trial = {
            id: data.id,
            access: data.access,
            url: data.url,
            speed: data.speed,
            started: 0,
            first: null,
            received: new Set(),
            rendered: new Set(),
            expected: null,
            submitted: false,
            saved: false,
            objectUrls: new Set(),
            timer: setTimeout(
              () => stop("試行が180秒でタイムアウトしました"),
              180000,
            ),
          };
          trial = current;
          log(
            `${data.speed} kbps / ${data.url} / ${data.access === 1 ? "初回収集" : `測定 ${data.access - 1}/5`}`,
          );
          current.started = performance.now();
          send("evaluation:trial-start", { id: current.id });
          break;
        }
        case "evaluation:frame": {
          const current = trial;
          if (
            !current ||
            data.id !== current.id ||
            current.received.has(data.frameId)
          )
            break;
          current.received.add(data.frameId);
          const blob = new Blob([new Uint8Array(data.img.data)], {
            type: "image/webp",
          });
          const url = URL.createObjectURL(blob);
          current.objectUrls.add(url);
          const image = new Image();
          image.onload = () => {
            try {
              if (trial !== current || pendingStop) return;
              context.drawImage(image, data.x, data.y);
              const drawnAt = performance.now();
              current.first ??= {
                frameId: data.frameId,
                lcp: drawnAt - current.started,
              };
              current.rendered.add(data.frameId);
              maybeReport(current);
            } catch (error) {
              stop(String(error));
            } finally {
              URL.revokeObjectURL(url);
              current.objectUrls.delete(url);
            }
          };
          image.onerror = () => {
            URL.revokeObjectURL(url);
            current.objectUrls.delete(url);
            if (trial === current) stop("画像をデコードできませんでした");
          };
          image.src = url;
          break;
        }
        case "evaluation:complete":
          if (trial && trial.id === data.id) {
            trial.expected = data.frameIds;
            maybeReport(trial);
          }
          break;
        case "evaluation:trial-saved":
          if (trial && trial.id === data.id) {
            trial.saved = true;
            clearTimeout(trial.timer);
            log(
              `${trial.url} / アクセス${trial.access}：${data.lcp?.toFixed(1) ?? ""} ms / ${data.renderKind ?? ""}（保存済み）`,
            );
          }
          break;
        case "evaluation:condition-error":
          discardTrial();
          log(`${data.url}：${data.error}。この条件を終了しました。`);
          break;
        case "evaluation:error":
          log(data.error);
          if (!runId) finish();
          break;
        case "evaluation:finished":
          download.href = data.download;
          download.hidden = !data.download;
          finish();
          log(`評価終了：${data.status}。Excelをダウンロードできます。`);
          break;
      }
    } catch (error) {
      stop(String(error));
    }
  };
}

startButton.onclick = async () => {
  try {
    (document.activeElement as HTMLElement | null)?.blur();
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
    const urls = element<HTMLTextAreaElement>("urls")
      .value.split(/\r?\n/)
      .map((value) => value.trim())
      .filter(Boolean);
    const speeds = [
      ...document.querySelectorAll<HTMLInputElement>("#speeds input:checked"),
    ].map((input) => Number(input.value));
    if (!urls.length || !speeds.length)
      throw new Error("URLと速度を指定してください。");
    if (document.visibilityState !== "visible")
      throw new Error("評価ページを前面に表示してください。");
    element<HTMLOListElement>("history").replaceChildren();
    download.hidden = true;
    // The controls can put the canvas below the viewport. Make it visible
    // before applying the same viewport calculation as the main client.
    canvas.scrollIntoView({ block: "start" });
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
    const canvasTop = canvas.getBoundingClientRect().top;
    const width = Math.trunc(canvas.clientWidth / window.devicePixelRatio);
    const height = Math.trunc(
      (window.innerHeight - canvasTop) / window.devicePixelRatio,
    );
    baseline = {
      width: canvas.clientWidth,
      height: canvas.clientHeight,
      viewportWidth: innerWidth,
      viewportHeight: innerHeight,
    };
    canvas.width = width;
    canvas.height = height;
    running = true;
    cacheSelect.disabled = true;
    runId = "";
    pendingStop = "";
    startButton.disabled = true;
    stopButton.disabled = false;
    send("evaluation:start", {
      urls,
      speeds,
      cacheEnabled: cacheSelect.value === "on",
      navigationWaitUntil: element<HTMLSelectElement>("navigation-wait-until")
        .value,
      device: {
        name: element<HTMLInputElement>("device-name").value.trim(),
        userAgent: navigator.userAgent,
        width,
        height,
        dpr: devicePixelRatio,
        orientation:
          screen.orientation?.type ??
          (innerWidth > innerHeight ? "landscape" : "portrait"),
      },
    });
  } catch (error) {
    finish();
    log(String(error));
  }
};
stopButton.onclick = () => stop("利用者が停止しました");
confirmButton.onclick = () => {
  confirmButton.disabled = true;
  speedPanel.hidden = true;
  send("evaluation:speed-confirmed", { id: speedId });
};
document.addEventListener("visibilitychange", () => {
  if (running && document.visibilityState !== "visible")
    stop("ページが非表示になりました");
});
window.addEventListener("resize", () => {
  if (
    running &&
    baseline &&
    (innerWidth !== baseline.viewportWidth ||
      innerHeight !== baseline.viewportHeight ||
      canvas.clientWidth !== baseline.width ||
      canvas.clientHeight !== baseline.height)
  )
    stop("画面サイズが変わりました");
});
window.addEventListener("pagehide", () => stop("ページを閉じました"));
connect();
void fetch("/evaluation/config", { cache: "no-store" })
  .then((response) => {
    if (!response.ok) throw new Error("評価設定を取得できません。");
    return response.json();
  })
  .then((data) => {
    element<HTMLTextAreaElement>("urls").value = data.urls.join("\n");
    loaded = true;
    startButton.disabled = running || socket.readyState !== WebSocket.OPEN;
  })
  .catch((error) => log(String(error)));
