"use strict";
// webVitals.onLCP(
//   (metric) => {
//     console.trace(JSON.stringify(metric));
//   },
//   { reportAllChanges: true },
// );

let LCP = 0;
const observer = new PerformanceObserver((list) => {
  const entries = list.getEntries();
  const lastEntry = entries[entries.length - 1];

  // LCPが変わったときのみ処理を行う
  if (LCP !== lastEntry.startTime) {
    LCP = lastEntry.startTime; // LCPの値を更新
    console.trace(lastEntry); // トレースを表示
  }
});
observer.observe({ type: "largest-contentful-paint", buffered: true });
