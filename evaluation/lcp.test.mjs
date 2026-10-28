import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

test("reports only the last candidate in each batch and flushes pending candidates", async () => {
  const source = await fs.readFile(
    new URL("../lcp.js", import.meta.url),
    "utf8",
  );
  const reports = [];
  const window = { __lcpCollectionId: 42 };
  window.top = window;
  let notify;
  let disconnected = false;
  class PerformanceObserver {
    constructor(callback) {
      notify = callback;
    }
    observe() {}
    takeRecords() {
      return [{ element: { id: "pending" }, startTime: 400 }];
    }
    disconnect() {
      disconnected = true;
    }
  }
  vm.runInNewContext(source, {
    window,
    PerformanceObserver,
    location: { href: "http://fixture/redirected" },
    console: { trace: (message) => reports.push(JSON.parse(message)) },
  });
  notify({
    getEntries: () => [
      { element: { id: "first" }, startTime: 100 },
      { element: null, startTime: 150 },
      { element: { id: "second" }, startTime: 200 },
      { element: { id: "third" }, startTime: 300 },
    ],
  });
  window.__stopLcpCollection();
  assert.deepEqual(
    reports.map((report) => report.lcp),
    [300, 400],
  );
  assert.deepEqual(
    reports.map((report) => report.xpath),
    ['id("third")', 'id("pending")'],
  );
  assert.ok(reports.every((report) => report.collectionId === 42));
  assert.ok(disconnected);
  window.top = {};
  notify({ getEntries: () => [{ element: { id: "iframe" }, startTime: 500 }] });
  assert.equal(reports.length, 2, "Ignore iframe candidates");
  window.top = window;
  notify({ getEntries: () => [] });
  notify({
    getEntries: () => [
      { element: { id: "earlier" }, startTime: 600 },
      { element: null, startTime: 700 },
    ],
  });
  assert.equal(reports.length, 2, "Do not fall back to an earlier candidate");
});
