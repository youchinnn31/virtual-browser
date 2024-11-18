"use strict";

let startTime = 0;
let endTime = 0;

/**
 * 送信ボダン要素の取得
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
  const ctx: CanvasRenderingContext2D | null = browser.getContext("2d");
  const image: HTMLImageElement = new Image();
  const imgUrl: string = URL.createObjectURL(blob);

  image.addEventListener("load", () => {
    endTime = performance.now();
    console.log(endTime - startTime);
    ctx?.drawImage(image, x, y);
  });
  image.src = imgUrl;
};

const webSocket: WebSocket = new WebSocket("ws://localhost:3000");
const browser: HTMLCanvasElement = getBrowser();
const urlButton: HTMLButtonElement = getButton("url-button");
const urlInput: HTMLInputElement = getUrlInput();

// 送信ボダンが押されたときの処理
urlButton.addEventListener("click", () => {
  (async () => {
    startTime = performance.now();
    const url: string = urlInput.value;
    const browserTop: number = browser.getBoundingClientRect().top;
    const width: number = Math.trunc(
      browser.clientWidth / window.devicePixelRatio,
    );
    const height: number = Math.trunc(
      (window.innerHeight - browserTop) / window.devicePixelRatio,
    );
    const userAgent: string = window.navigator.userAgent;

    const data: object = {
      action: "init",
      url: url,
      width: width,
      height: height,
      userAgent: userAgent,
    };
    console.log("width: " + width);
    console.log("height: " + height);
    browser.width = width;
    browser.height = height;
    webSocket.send(JSON.stringify(data));
  })().catch((error) => {
    console.error(error);
  });
});

// 画像を取得した際の処理
webSocket.onmessage = (event) => {
  const res = JSON.parse(event.data);
  const arrayBuffer = new Uint8Array(res.img.data);
  const blob: Blob = new Blob([arrayBuffer.buffer], { type: "image/png" });
  urlInput.value = res.url;
  renderSite(blob, res.x, res.y);
};

// webSocket.addEventListener("open", () => {
//   const clickEvent = new Event("click");
//   const urlButton = document.getElementById("url-button") as HTMLButtonElement;
//   urlButton.dispatchEvent(clickEvent);
// });
