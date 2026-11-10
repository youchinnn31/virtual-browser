import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import sqlite3 from "sqlite3";
import { open, type Database } from "sqlite";
import type {
  Candidate,
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
  revisitCount: number;
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
          id TEXT PRIMARY KEY, started_at TEXT NOT NULL, ended_at TEXT,
          status TEXT NOT NULL, error TEXT, config_json TEXT NOT NULL,
          device_json TEXT NOT NULL, metadata_json TEXT NOT NULL
        );
        CREATE TABLE evaluations (
          id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id),
          url TEXT NOT NULL, profile TEXT NOT NULL, revisit_count INTEGER NOT NULL,
          status TEXT NOT NULL DEFAULT 'incomplete', successful_count INTEGER NOT NULL DEFAULT 0,
          median_ms REAL, viewport_successful_count INTEGER NOT NULL DEFAULT 0,
          viewport_median_ms REAL, navigation_completed_count INTEGER NOT NULL DEFAULT 0,
          navigation_median_ms REAL, UNIQUE(run_id, url, profile)
        );
        CREATE TABLE candidates (
          id INTEGER PRIMARY KEY, evaluation_id TEXT NOT NULL REFERENCES evaluations(id),
          url TEXT NOT NULL, lcp_ms REAL NOT NULL, xpath TEXT NOT NULL
        );
        CREATE TABLE trials (
          trial_id TEXT PRIMARY KEY, evaluation_id TEXT NOT NULL REFERENCES evaluations(id),
          phase TEXT NOT NULL, visit_index INTEGER NOT NULL,
          started_at TEXT NOT NULL, ended_at TEXT, final_url TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL DEFAULT 'running', first_image_ms REAL, lcp_images_ms REAL,
          viewport_ms REAL, all_images_ms REAL, first_image_index INTEGER,
          image_count INTEGER NOT NULL DEFAULT 0, lcp_image_count INTEGER NOT NULL DEFAULT 0, error TEXT,
          navigation_ms REAL,
          UNIQUE(evaluation_id, phase, visit_index)
        );
      `);
      await db.run(
        "INSERT INTO runs VALUES (?, ?, NULL, 'running', NULL, ?, ?, ?)",
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
    revisitCount: number,
  ): Promise<EvaluationRecord> {
    const evaluation = {
      evaluationId: randomUUID(),
      url,
      profile,
      revisitCount,
    };
    await this.db.run(
      "INSERT INTO evaluations(id, run_id, url, profile, revisit_count) VALUES (?, ?, ?, ?, ?)",
      evaluation.evaluationId,
      this.runId,
      url,
      profile,
      revisitCount,
    );
    return evaluation;
  }

  async saveCandidates(
    evaluationId: string,
    candidates: Candidate[],
  ): Promise<void> {
    await this.db.exec("BEGIN TRANSACTION");
    try {
      for (const candidate of candidates) {
        await this.db.run(
          "INSERT INTO candidates(evaluation_id, url, lcp_ms, xpath) VALUES (?, ?, ?, ?)",
          evaluationId,
          candidate.url,
          candidate.lcp,
          candidate.xpath,
        );
      }
      await this.db.exec("COMMIT");
    } catch (error) {
      await this.db.exec("ROLLBACK");
      throw error;
    }
  }

  async getCandidates(evaluationId: string): Promise<Candidate[]> {
    return this.db.all<Candidate[]>(
      "SELECT url, lcp_ms AS lcp, xpath FROM candidates WHERE evaluation_id = ? ORDER BY lcp_ms DESC, id ASC",
      evaluationId,
    );
  }

  async beginTrial(
    evaluationId: string,
    phase: Phase,
    visitIndex: number,
  ): Promise<string> {
    const trialId = randomUUID();
    await this.db.run(
      "INSERT INTO trials(trial_id, evaluation_id, phase, visit_index, started_at) VALUES (?, ?, ?, ?, ?)",
      trialId,
      evaluationId,
      phase,
      visitIndex,
      new Date().toISOString(),
    );
    return trialId;
  }

  async finishTrial(result: TrialResult): Promise<void> {
    await this.db.run(
      `UPDATE trials SET ended_at = ?, final_url = ?, status = ?, first_image_ms = ?,
       lcp_images_ms = ?, viewport_ms = ?, all_images_ms = ?, first_image_index = ?,
       image_count = ?, lcp_image_count = ?, error = ?, navigation_ms = ?
       WHERE trial_id = ? AND evaluation_id = ?`,
      new Date().toISOString(),
      result.finalUrl,
      result.status,
      result.firstImageMs,
      result.lcpImagesMs,
      result.viewportMs,
      result.allImagesMs,
      result.firstImageIndex,
      result.imageCount,
      result.lcpImageCount,
      result.error,
      result.navigationMs,
      result.trialId,
      result.evaluationId,
    );
  }

  async getTrials(evaluationId?: string): Promise<TrialResult[]> {
    const columns = `trial_id AS trialId, evaluation_id AS evaluationId, phase,
      visit_index AS visitIndex, final_url AS finalUrl, status,
      first_image_ms AS firstImageMs, lcp_images_ms AS lcpImagesMs,
      viewport_ms AS viewportMs, all_images_ms AS allImagesMs,
      first_image_index AS firstImageIndex, image_count AS imageCount,
      lcp_image_count AS lcpImageCount, error, navigation_ms AS navigationMs`;
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
      "UPDATE evaluations SET status = ?, successful_count = ?, median_ms = ?, viewport_successful_count = ?, viewport_median_ms = ?, navigation_completed_count = ?, navigation_median_ms = ? WHERE id = ?",
      summary.status,
      summary.successfulCount,
      summary.medianMs,
      summary.viewportSuccessfulCount,
      summary.viewportMedianMs,
      summary.navigationCompletedCount,
      summary.navigationMedianMs,
      summary.evaluationId,
    );
    return summary;
  }

  async exportReports(): Promise<void> {
    const evaluations = await this.db.all<EvaluationRecord[]>(
      "SELECT id AS evaluationId, url, profile, revisit_count AS revisitCount FROM evaluations ORDER BY rowid",
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
