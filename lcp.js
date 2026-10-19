"use strict";

const observer = new PerformanceObserver((list) => {
  const entries = list.getEntries();
  const lastEntry = entries[entries.length - 1];
  const xpath = getElementXPath(lastEntry.element);
  const lcp = lastEntry.startTime;
  console.trace(
    JSON.stringify({
      url: location.href,
      lcp: lcp,
      xpath: xpath,
    }),
  );
});

observer.observe({ type: "largest-contentful-paint", buffered: true });

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
