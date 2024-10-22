"use strict";

import axios from "axios";

const getButton = (id: string): HTMLButtonElement => {
  const urlButton = document.getElementById(id);
  if (urlButton instanceof HTMLButtonElement) {
    return urlButton;
  }
  throw new Error();
};

const getUrlInput = (): HTMLInputElement => {
  const urlInput = document.getElementById("url-input");
  if (urlInput instanceof HTMLInputElement) {
    return urlInput;
  }
  throw new Error();
};

const getBrowser = (): HTMLImageElement => {
  const browser = document.getElementById("browser");
  if (browser instanceof HTMLImageElement) {
    return browser;
  }
  throw new Error();
};

let numPages = 0;
let currentPage = 0;

const renderSite = async (id: number): Promise<void> => {
  const browser = getBrowser();
  const response = await axios.get(`/sites/${id}`, { responseType: "blob" });
  const canvas = response.data;
  browser.setAttribute("src", URL.createObjectURL(canvas));
};

const urlButton = getButton("url-button");
urlButton.addEventListener("click", () => {
  (async () => {
    const urlInput = getUrlInput();
    const url = urlInput.value;
    const browser = getBrowser();
    const browserTop = browser.getBoundingClientRect().top;
    const width = Math.trunc(browser.clientWidth / window.devicePixelRatio);
    const height = Math.trunc(
      (window.innerHeight - browserTop) / window.devicePixelRatio,
    );
    const data = {
      url,
      width,
      height,
    };
    console.log("width: " + width);
    console.log("height: " + height);
    const response = await axios.post("/sites", data);
    urlInput.value = response.data.currentUrl;
    numPages = parseInt(response.data.numPages, 10);

    await renderSite(0);
  })().catch((error) => {
    console.error(error);
  });
});

const upButton = getButton("up-button");
upButton.addEventListener("click", () => {
  (async () => {
    const nextPage: number = currentPage < 0 ? 0 : --currentPage;
    await renderSite(nextPage);
  })().catch((error) => {
    console.error(error);
  });
});

const downButton = getButton("down-button");
downButton.addEventListener("click", () => {
  (async () => {
    const nextPage: number = currentPage > numPages ? numPages : ++currentPage;
    await renderSite(nextPage);
  })().catch((error) => {
    console.error(error);
  });
});
