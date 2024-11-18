"use strict";
// webVitals.onLCP(
//   (metric) => {
//     console.trace(JSON.stringify(metric));
//     console.trace(metric.element);
//   },
//   { reportAllChanges: true },
// );

let LCP = 0;
const observer = new PerformanceObserver((list) => {
  const entries = list.getEntries();
  const lastEntry = entries[entries.length - 1];

  if (LCP !== lastEntry.startTime) {
    LCP = lastEntry.startTime;
    const element = lastEntry.element;
    const tagName = element.localName;
    const idName = element.id;
    const className = element.className;
    if (idName) {
      console.trace(
        JSON.stringify({
          lcp: LCP,
          selector: `${tagName}#${idName}`,
        }),
      );
    } else if (className) {
      console.trace(
        JSON.stringify({
          lcp: LCP,
          selector: `${tagName}.${className}`
            .replace(/\s[A-Za-z0-9-]+:[A-Za-z0-9-]+\b/g, "")
            .replace(/\s+/g, "."),
        }),
      );
    } else {
      console.trace(
        JSON.stringify({
          lcp: LCP,
          selector: tagName,
        }),
      );
    }
    // for (const key in element) {
    //   console.trace(`${key}: ${element[key]}`);
    // }
    // console.trace(JSON.stringify(lastEntry)); // トレースを表示
  }
});
observer.observe({ type: "largest-contentful-paint", buffered: true });
