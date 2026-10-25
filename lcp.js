"use strict";

function reportEntries(entries) {
  if (window !== window.top || entries.length === 0) return;
  for (const entry of entries) {
    if (!entry.element) continue;
    const xpath = getElementXPath(entry.element);
    console.trace(
      JSON.stringify({
        collectionId: window.__lcpCollectionId,
        url: location.href,
        lcp: entry.startTime,
        xpath: xpath,
      }),
    );
  }
}

const observer = new PerformanceObserver((list) =>
  reportEntries(list.getEntries()),
);

observer.observe({ type: "largest-contentful-paint", buffered: true });
window.__stopLcpCollection = () => {
  reportEntries(observer.takeRecords());
  observer.disconnect();
};

function getElementXPath(element) {
  if (element.id) {
    return `id("${element.id}")`;
  }

  let path = "";
  while (element.nodeType === Node.ELEMENT_NODE) {
    let sibling = element.previousSibling;
    let count = 1;
    while (sibling) {
      if (sibling.nodeName === element.nodeName) {
        count++;
      }
      sibling = sibling.previousSibling;
    }
    path =
      `${element.nodeName.toLowerCase()}[${count}]` + (path ? `/${path}` : "");
    element = element.parentNode;
  }
  return `/${path}`;
}
