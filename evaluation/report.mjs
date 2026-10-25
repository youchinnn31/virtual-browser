import ExcelJS from "exceljs";

export function median(samples) {
  if (samples.length !== 5) return null;
  return samples.map((sample) => sample.lcp).sort((a, b) => a - b)[2];
}

export async function writeReport(output, rows) {
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
  ]);
  for (const row of rows) {
    summary.addRow([
      row.url,
      row.speed,
      row.status === "ok" ? median(row.samples) : null,
      ...Array.from({ length: 5 }, (_, i) => row.samples[i]?.lcp ?? null),
      row.warmup ?? null,
      row.collected?.candidates ?? null,
      row.status,
      row.database,
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
      ]);
    }
  }
  const conditions = workbook.addWorksheet("測定条件");
  for (const entry of [
    ["項目", "条件"],
    ["測定対象", "URL送信から最初の画像をCanvasに描画するまでの時間"],
    ["測定回数", "初回収集1回を除き、2〜6回目の5回。5回成功時だけ中央値を出力"],
    ["代理サーバーHTTPキャッシュ", "無効"],
    ["代理サーバーService Worker", "バイパス"],
    ["クライアントHTTPキャッシュ", "無効"],
    ["DB", "URL・通信速度ごとに新規DB。初回収集後は同じDBを保持"],
    [
      "先行描画条件",
      "既存仕様：初回のimage_lcp > 4000ms。部分画像数0は先行描画なし",
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
  ])
    conditions.addRow(entry);
  for (const sheet of workbook.worksheets) {
    sheet.views = [{ state: "frozen", ySplit: 1 }];
    sheet.getRow(1).font = { bold: true };
    sheet.columns.forEach((column, index) => {
      column.width = index === 0 ? 48 : 24;
    });
  }
  await workbook.xlsx.writeFile(output);
}
