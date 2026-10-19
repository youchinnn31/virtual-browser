"use strict";

let startTime = 0;
let endTime = 0;
let lcp = 0;

/**
 * 送信ボダン要素の取得
 * @return Button要素
 */
const getButton = (id: string): HTMLButtonElement => {
  const urlButton: HTMLElement | null = document.getElementById(id);
  if (urlButton instanceof HTMLButtonElement) {
    return urlButton;
  }
  throw new Error();
};

/**
 * アドレスバー要素の取得
 * @return Input要素
 */
const getUrlInput = (): HTMLInputElement => {
  const urlInput: HTMLElement | null = document.getElementById("url-input");
  if (urlInput instanceof HTMLInputElement) {
    return urlInput;
  }
  throw new Error();
};

/**
 * Canvas要素の取得
 * @return Canvas要素
 */
const getBrowser = (): HTMLCanvasElement => {
  const browser: HTMLElement | null = document.getElementById("browser");
  if (browser instanceof HTMLCanvasElement) {
    return browser;
  }
  throw new Error();
};

/**
 * canvasに画像をレンダリング
 * @param blob 画像のBlob形式
 * @param x X座標
 * @param y y座標
 */
const renderSite = async (blob: Blob, x: number, y: number): Promise<void> => {
  const ctx: CanvasRenderingContext2D = browser.getContext("2d")!;
  const image: HTMLImageElement = new Image();
  const imgUrl: string = URL.createObjectURL(blob);

  // 画像がloadされた場合
  image.addEventListener("load", () => {
    ctx?.drawImage(image, x, y);
    endTime = performance.now();
    if (lcp === 0) {
      lcp = endTime - startTime;
      const lcpValueEl = document.getElementById("lcp-value");
      if (lcpValueEl) lcpValueEl.textContent = lcp.toString();
      const data = {
        action: "lcp",
        lcp: lcp,
      };
      webSocket.send(JSON.stringify(data));
    }
  });
  image.src = imgUrl;
};

const wsScheme = location.protocol === "https:" ? "wss://" : "ws://";
const webSocket = new WebSocket(wsScheme + location.host);

const browser: HTMLCanvasElement = getBrowser();
const urlButton: HTMLButtonElement = getButton("url-button");
const urlInput: HTMLInputElement = getUrlInput();

// 送信ボダンが押されたときの処理
urlButton.addEventListener("click", () => {
  lcp = 0;
  startTime = performance.now();
  const url: string = urlInput.value;

  const data: object = {
    action: "image",
    url: url,
  };
  webSocket.send(JSON.stringify(data));
});

//画面click時の処理
browser.addEventListener("click", (event) => {
  const rect: DOMRect = browser.getBoundingClientRect();
  const x = (event.clientX - rect.left) * (browser.width / rect.width);
  const y = (event.clientY - rect.top) * (browser.height / rect.height);
  const data = {
    action: "click",
    x,
    y,
  };
  webSocket.send(JSON.stringify(data));
});

let scrollStartY: number;
let scrollStartX: number;

// スクロール開始時の処理
browser.addEventListener("touchstart", (event) => {
  scrollStartY = event.touches[0]?.clientY ?? -1;
  scrollStartX = event.touches[0]?.clientX ?? -1; 
});

// スクロール終了時の処理
browser.addEventListener("touchend", (event) => {
  const scrollEndX = event.changedTouches[0]?.clientX ?? -1;
  const scrollEndY = event.changedTouches[0]?.clientY ?? -1;

  if (scrollStartX > 0 && scrollStartY > 0 && scrollEndX > 0 && scrollEndY > 0) {
    const scrollX = scrollStartX - scrollEndX; // 横
    const scrollY = scrollStartY - scrollEndY; // 縦

    webSocket.send(
      JSON.stringify({
        action: "scroll",
        scrollX,
        scrollY,
      }),
    );
  }
});


// 画像をサーバから取得した際の処理
webSocket.onmessage = (event) => {
  const res = JSON.parse(event.data);
  const arrayBuffer = new Uint8Array(res.img.data);
  const blob: Blob = new Blob([arrayBuffer.buffer], { type: "image/webp" });
  urlInput.value = res.url;
  renderSite(blob, res.x, res.y);
};

// モバイル端末の情報をサーバに送信する
webSocket.addEventListener("open", () => {
  const browserTop: number = browser.getBoundingClientRect().top;
  const width: number = Math.trunc(
    browser.clientWidth / window.devicePixelRatio,
  );
  const height: number = Math.trunc(
    (window.innerHeight - browserTop) / window.devicePixelRatio,
  );
  const data = {
    action: "init",
    userAgent: window.navigator.userAgent,
    width: width,
    height: height,
  };
  browser.width = width;
  browser.height = height;
  webSocket.send(JSON.stringify(data));
});
