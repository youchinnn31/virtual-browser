import ExcelJS from "exceljs";

export function median(samples) {
  if (samples.length !== 5) return null;
  return samples.map((sample) => sample.lcp).sort((a, b) => a - b)[2];
}

export async function writeReport(output, rows, options = {}) {
  const workbook = new ExcelJS.Workbook();
  const summary = workbook.addWorksheet("中央値");
  summary.addRow([
    "URL",
    "通信速度(kbps)",
    "中央値(ms)",
    "2回目(ms)",
    "3回目(ms)",
    "4回目(ms)",
    "5回目(ms)",
    "6回目(ms)",
    "初回・集計対象外(ms)",
    "初回収集LCP候補数",
    "状態",
    "DBファイル",
    "先行描画評価",
    "LCP画像で5回測定した中央値(ms)",
  ]);
  const details = workbook.addWorksheet("測定値");
  details.addRow([
    "URL",
    "通信速度(kbps)",
    "測定番号",
    "アクセス回数",
    "表示時間(ms)",
    "LCP部分画像数",
    "遷移後URL",
    "最初の描画種別",
    "最初の画像XPath",
    "ビューポート描画の理由",
  ]);
  const candidates = workbook.addWorksheet("候補処理");
  candidates.addRow([
    "URL",
    "通信速度(kbps)",
    "アクセス回数",
    "候補LCP(ms)",
    "XPath",
    "処理結果",
    "詳細",
  ]);
  for (const row of rows) {
    const eligible =
      row.status === "ok" &&
      row.samples.length === 5 &&
      row.samples.every((sample) => sample.renderKind === "lcp");
    summary.addRow([
      row.url,
      row.speed,
      row.status === "ok" ? median(row.samples) : null,
      ...Array.from({ length: 5 }, (_, i) => row.samples[i]?.lcp ?? null),
      row.warmup ?? null,
      row.collected?.candidates ?? null,
      row.status,
      row.database,
      eligible
        ? "5回ともLCP画像"
        : row.samples.length < 5
          ? "対象外：5回未完了"
          : "対象外：ビューポート描画または描画種別不明を含む",
      eligible ? median(row.samples) : null,
    ]);
    for (const sample of row.samples) {
      details.addRow([
        row.url,
        row.speed,
        sample.trial,
        sample.access,
        sample.lcp,
        sample.lcpImages,
        sample.finalUrl,
        sample.renderKind ?? "unknown",
        sample.firstXpath ?? "",
        sample.renderKind === "viewport"
          ? !sample.candidates?.length
            ? "no-collected-candidates"
            : sample.lcpImages > 0
              ? "viewport-rendered-first"
              : [
                  ...new Set(
                    sample.candidates.map((candidate) => candidate.status),
                  ),
                ].join(", ")
          : "",
      ]);
      for (const candidate of sample.candidates ?? []) {
        candidates.addRow([
          row.url,
          row.speed,
          sample.access,
          candidate.lcp,
          candidate.xpath,
          candidate.status,
          candidate.detail ?? "",
        ]);
      }
    }
  }
  const conditions = workbook.addWorksheet("測定条件");
  const overriddenConditions = new Set(
    (options.conditions ?? []).map(([key]) => key),
  );
  for (const entry of [
    ["項目", "条件"],
    ["測定対象", "URL送信から最初の画像をCanvasに描画するまでの時間"],
    ["測定回数", "初回収集1回を除き、2〜6回目の5回。5回成功時だけ中央値を出力"],
    ["代理サーバーHTTPキャッシュ", "有効"],
    ["代理サーバーService Worker", "ブラウザの既定動作（バイパスしない）"],
    ["クライアントHTTPキャッシュ", "ブラウザの既定動作"],
    ["DB", "調査ごと、URL・通信速度ごとに新規DB。初回収集後は同じDBを保持"],
    ["DBのURLキー", "遷移後URL（mainと同じ）"],
    ["ページ読み込みのタイムアウト", "30秒"],
    ["Canvas描画", "受信画像のサイズで描画（拡大・縮小なし）"],
    [
      "先行描画条件",
      "初回のimage_lcp収集後、同じ遷移後URLの候補を使用。部分画像数0は先行描画なし",
    ],
    [
      "通信制限",
      "クライアント側に適用。代理サーバーから対象サイトへの通信は制限なし",
    ],
    [
      "キャッシュ範囲",
      "DNS・接続再利用・対象サイトやCDNのキャッシュは除去対象外",
    ],
    ["画面", "375×667、deviceScaleFactor=2、isMobile=true"],
    [
      "User-Agent",
      "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1",
    ],
  ])
    if (!overriddenConditions.has(entry[0])) conditions.addRow(entry);
  for (const entry of options.conditions ?? []) conditions.addRow(entry);
  if (options.controls) {
    const controls = workbook.addWorksheet("速度設定");
    controls.addRow(["日時", "操作", "記録"]);
    for (const entry of options.controls)
      controls.addRow([entry.at, entry.kind, JSON.stringify(entry.data)]);
  }
  for (const sheet of workbook.worksheets) {
    sheet.views = [{ state: "frozen", ySplit: 1 }];
    sheet.getRow(1).font = { bold: true };
    sheet.columns.forEach((column, index) => {
      column.width = index === 0 ? 48 : 24;
    });
  }
  await workbook.xlsx.writeFile(output);
}
