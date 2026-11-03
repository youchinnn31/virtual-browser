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
    "evaluationId" | "url" | "profile" | "measurementCount"
  >,
  trials: TrialResult[],
): Summary {
  const measurements = trials.filter(
    (trial) =>
      trial.evaluationId === evaluation.evaluationId &&
      trial.phase === "measurement",
  );
  const values = measurements
    .filter((trial) => trial.status === "success" && trial.viewportMs !== null)
    .map((trial) => trial.viewportMs!);
  const warmupSucceeded = trials.some(
    (trial) =>
      trial.evaluationId === evaluation.evaluationId &&
      trial.phase === "warmup" &&
      trial.status === "success",
  );
  const complete =
    warmupSucceeded &&
    measurements.length === evaluation.measurementCount &&
    values.length === evaluation.measurementCount;
  return {
    ...evaluation,
    method: "viewport",
    successfulCount: values.length,
    viewportMedianMs: complete ? median(values) : null,
    status: complete ? "complete" : "incomplete",
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
      "rendering_method",
      "url",
      "charles_profile",
      "trial_id",
      "phase",
      "measurement_index",
      "final_url",
      "status",
      "viewport_ms",
      "image_count",
      "error",
    ],
  ];
  for (const trial of trials) {
    const summary = byId.get(trial.evaluationId);
    measurements.push([
      trial.evaluationId,
      "viewport",
      summary?.url,
      summary?.profile,
      trial.trialId,
      trial.phase,
      trial.measurementIndex,
      trial.finalUrl,
      trial.status,
      trial.viewportMs,
      trial.imageCount,
      trial.error,
    ]);
  }
  const aggregate: unknown[][] = [
    [
      "evaluation_id",
      "rendering_method",
      "url",
      "charles_profile",
      "measurement_count",
      "successful_count",
      "median_viewport_ms",
      "status",
    ],
  ];
  for (const summary of summaries) {
    aggregate.push([
      summary.evaluationId,
      summary.method,
      summary.url,
      summary.profile,
      summary.measurementCount,
      summary.successfulCount,
      summary.viewportMedianMs,
      summary.status,
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
