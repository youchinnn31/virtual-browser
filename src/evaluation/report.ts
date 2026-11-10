import fs from "node:fs/promises";
import path from "node:path";
import type { Summary, TrialResult } from "./protocol";

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const upper = sorted[middle]!;
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + upper) / 2 : upper;
}

export function summarize(
  evaluation: Pick<
    Summary,
    "evaluationId" | "url" | "profile" | "revisitCount"
  >,
  trials: TrialResult[],
): Summary {
  const revisits = trials.filter(
    (trial) =>
      trial.evaluationId === evaluation.evaluationId &&
      trial.phase === "revisit",
  );
  const values = revisits
    .filter(
      (trial) => trial.lcpImagesMs !== null && trial.firstImageMs !== null,
    )
    .map((trial) => trial.firstImageMs!);
  const initialSucceeded = trials.some(
    (trial) =>
      trial.evaluationId === evaluation.evaluationId &&
      trial.phase === "initial" &&
      trial.status === "success",
  );
  const viewportValues = revisits
    .filter((trial) => trial.viewportMs !== null)
    .map((trial) => trial.viewportMs!);
  const navigationValues = revisits
    .filter((trial) => trial.navigationMs !== null)
    .map((trial) => trial.navigationMs!);
  const lcpComplete =
    initialSucceeded &&
    revisits.length === evaluation.revisitCount &&
    values.length === evaluation.revisitCount;
  const viewportComplete =
    initialSucceeded &&
    revisits.length === evaluation.revisitCount &&
    viewportValues.length === evaluation.revisitCount;
  const navigationComplete =
    initialSucceeded &&
    revisits.length === evaluation.revisitCount &&
    navigationValues.length === evaluation.revisitCount;
  return {
    ...evaluation,
    successfulCount: values.length,
    medianMs: lcpComplete ? median(values) : null,
    viewportSuccessfulCount: viewportValues.length,
    viewportMedianMs: viewportComplete ? median(viewportValues) : null,
    navigationCompletedCount: navigationValues.length,
    navigationMedianMs: navigationComplete ? median(navigationValues) : null,
    status: lcpComplete && viewportComplete ? "complete" : "incomplete",
  };
}

export function csv(rows: unknown[][]): string {
  return (
    rows
      .map((row) =>
        row
          .map((value) => {
            const cell =
              value === null || value === undefined ? "" : String(value);
            return /[",\r\n]/.test(cell)
              ? `"${cell.replace(/"/g, '""')}"`
              : cell;
          })
          .join(","),
      )
      .join("\r\n") + "\r\n"
  );
}

export async function exportReports(
  directory: string,
  summaries: Summary[],
  trials: TrialResult[],
): Promise<void> {
  const byId = new Map(
    summaries.map((summary) => [summary.evaluationId, summary]),
  );
  const measurements: unknown[][] = [
    [
      "evaluation_id",
      "url",
      "charles_profile",
      "trial_id",
      "phase",
      "visit_index",
      "final_url",
      "status",
      "first_image_ms",
      "lcp_images_ms",
      "viewport_ms",
      "all_images_ms",
      "first_image_index",
      "image_count",
      "lcp_image_count",
      "error",
      "navigation_ms",
    ],
  ];
  for (const trial of trials) {
    const summary = byId.get(trial.evaluationId);
    measurements.push([
      trial.evaluationId,
      summary?.url,
      summary?.profile,
      trial.trialId,
      trial.phase,
      trial.visitIndex,
      trial.finalUrl,
      trial.status,
      trial.firstImageMs,
      trial.lcpImagesMs,
      trial.viewportMs,
      trial.allImagesMs,
      trial.firstImageIndex,
      trial.imageCount,
      trial.lcpImageCount,
      trial.error,
      trial.navigationMs,
    ]);
  }
  const aggregate: unknown[][] = [
    [
      "evaluation_id",
      "url",
      "charles_profile",
      "revisit_count",
      "successful_count",
      "median_client_lcp_image_ms",
      "viewport_successful_count",
      "median_viewport_ms",
      "status",
      "navigation_completed_count",
      "median_navigation_ms",
    ],
  ];
  for (const summary of summaries) {
    aggregate.push([
      summary.evaluationId,
      summary.url,
      summary.profile,
      summary.revisitCount,
      summary.successfulCount,
      summary.medianMs,
      summary.viewportSuccessfulCount,
      summary.viewportMedianMs,
      summary.status,
      summary.navigationCompletedCount,
      summary.navigationMedianMs,
    ]);
  }
  for (const [name, rows] of [
    ["measurements.csv", measurements],
    ["summary.csv", aggregate],
  ] as const) {
    const destination = path.join(directory, name);
    await fs.writeFile(`${destination}.tmp`, "\uFEFF" + csv(rows), "utf8");
    await fs.rename(`${destination}.tmp`, destination);
  }
}
