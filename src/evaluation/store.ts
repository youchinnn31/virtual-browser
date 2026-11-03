import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import sqlite3 from "sqlite3";
import { open, type Database } from "sqlite";
import type {
  DeviceInfo,
  EvaluationConfig,
  Phase,
  Summary,
  TrialResult,
} from "./protocol";
import { exportReports, summarize } from "./report";

export interface EvaluationRecord {
  evaluationId: string;
  url: string;
  profile: string;
  measurementCount: number;
}

export class EvaluationStore {
  private constructor(
    readonly runId: string,
    readonly directory: string,
    private readonly db: Database,
  ) {}

  static async create(
    root: string,
    config: EvaluationConfig,
    device: DeviceInfo,
    metadata: Record<string, unknown> = {},
  ): Promise<EvaluationStore> {
    const runId = randomUUID();
    const directory = path.join(root, runId);
    await fs.mkdir(directory, { recursive: true });
    const db = await open({
      filename: path.join(directory, "evaluation.sqlite"),
      driver: sqlite3.Database,
    });
    try {
      await db.exec(`
        PRAGMA foreign_keys = ON;
        CREATE TABLE runs (
          id TEXT PRIMARY KEY, method TEXT NOT NULL, started_at TEXT NOT NULL, ended_at TEXT,
          status TEXT NOT NULL, error TEXT, config_json TEXT NOT NULL,
          device_json TEXT NOT NULL, metadata_json TEXT NOT NULL
        );
        CREATE TABLE evaluations (
          id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id),
          url TEXT NOT NULL, profile TEXT NOT NULL, measurement_count INTEGER NOT NULL,
          status TEXT NOT NULL DEFAULT 'incomplete', successful_count INTEGER NOT NULL DEFAULT 0,
          viewport_median_ms REAL, UNIQUE(run_id, url, profile)
        );
        CREATE TABLE trials (
          trial_id TEXT PRIMARY KEY, evaluation_id TEXT NOT NULL REFERENCES evaluations(id),
          phase TEXT NOT NULL, measurement_index INTEGER NOT NULL,
          started_at TEXT NOT NULL, ended_at TEXT, final_url TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL DEFAULT 'running', viewport_ms REAL,
          image_count INTEGER NOT NULL DEFAULT 0, error TEXT,
          UNIQUE(evaluation_id, phase, measurement_index)
        );
      `);
      await db.run(
        "INSERT INTO runs VALUES (?, 'viewport', ?, NULL, 'running', NULL, ?, ?, ?)",
        runId,
        new Date().toISOString(),
        JSON.stringify(config),
        JSON.stringify(device),
        JSON.stringify(metadata),
      );
      return new EvaluationStore(runId, directory, db);
    } catch (error) {
      await db.close();
      throw error;
    }
  }

  async createEvaluation(
    url: string,
    profile: string,
    measurementCount: number,
  ): Promise<EvaluationRecord> {
    const evaluation = {
      evaluationId: randomUUID(),
      url,
      profile,
      measurementCount,
    };
    await this.db.run(
      "INSERT INTO evaluations(id, run_id, url, profile, measurement_count) VALUES (?, ?, ?, ?, ?)",
      evaluation.evaluationId,
      this.runId,
      url,
      profile,
      measurementCount,
    );
    return evaluation;
  }

  async beginTrial(
    evaluationId: string,
    phase: Phase,
    measurementIndex: number,
  ): Promise<string> {
    const trialId = randomUUID();
    await this.db.run(
      "INSERT INTO trials(trial_id, evaluation_id, phase, measurement_index, started_at) VALUES (?, ?, ?, ?, ?)",
      trialId,
      evaluationId,
      phase,
      measurementIndex,
      new Date().toISOString(),
    );
    return trialId;
  }

  async finishTrial(result: TrialResult): Promise<void> {
    await this.db.run(
      `UPDATE trials SET ended_at = ?, final_url = ?, status = ?, viewport_ms = ?,
       image_count = ?, error = ? WHERE trial_id = ? AND evaluation_id = ?`,
      new Date().toISOString(),
      result.finalUrl,
      result.status,
      result.viewportMs,
      result.imageCount,
      result.error,
      result.trialId,
      result.evaluationId,
    );
  }

  async getTrials(evaluationId?: string): Promise<TrialResult[]> {
    const columns = `trial_id AS trialId, evaluation_id AS evaluationId, phase,
      measurement_index AS measurementIndex, final_url AS finalUrl, status,
      viewport_ms AS viewportMs, image_count AS imageCount, error`;
    return evaluationId === undefined
      ? this.db.all<TrialResult[]>(
          `SELECT ${columns} FROM trials ORDER BY rowid`,
        )
      : this.db.all<TrialResult[]>(
          `SELECT ${columns} FROM trials WHERE evaluation_id = ? ORDER BY rowid`,
          evaluationId,
        );
  }

  async summarize(evaluation: EvaluationRecord): Promise<Summary> {
    const summary = summarize(
      evaluation,
      await this.getTrials(evaluation.evaluationId),
    );
    await this.db.run(
      "UPDATE evaluations SET status = ?, successful_count = ?, viewport_median_ms = ? WHERE id = ?",
      summary.status,
      summary.successfulCount,
      summary.viewportMedianMs,
      summary.evaluationId,
    );
    return summary;
  }

  async exportReports(): Promise<void> {
    const evaluations = await this.db.all<EvaluationRecord[]>(
      "SELECT id AS evaluationId, url, profile, measurement_count AS measurementCount FROM evaluations ORDER BY rowid",
    );
    const summaries: Summary[] = [];
    for (const evaluation of evaluations)
      summaries.push(await this.summarize(evaluation));
    await exportReports(this.directory, summaries, await this.getTrials());
  }

  async finish(
    status: "completed" | "aborted" | "failed",
    error: string | null,
  ): Promise<void> {
    await this.db.run(
      "UPDATE runs SET status = ?, ended_at = ?, error = ? WHERE id = ?",
      status,
      new Date().toISOString(),
      error,
      this.runId,
    );
    await this.exportReports();
  }

  async close(): Promise<void> {
    await this.db.close();
  }
}
