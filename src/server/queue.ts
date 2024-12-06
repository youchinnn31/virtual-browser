"use strict";

import { QueueForm } from "./types/queueForm";
import { LcpRepository } from "./repository/lcp.repository";

/**
 * Queue
 */
export class Queue {
  /** データ保存用Queue */
  private queue: QueueForm[] = [];
  /** Queueの処理状態を管理 */
  private isProcessing = false;

  private lcpRepository: LcpRepository;

  /**
   * コンストラクタ
   */
  constructor(lcpRepository: LcpRepository) {
    this.lcpRepository = lcpRepository;
  }

  /**
   * Queueに値を入れる
   */
  async enqueue(value: QueueForm): Promise<void> {
    this.queue.push(value);
    await this.processQueue();
  }

  /**
   * Queueの中身を処理する
   */
  private async processQueue(): Promise<void> {
    if (this.isProcessing === true) {
      return;
    }

    this.isProcessing = true;

    while (this.queue.length > 0) {
      const value: QueueForm = this.queue.shift()!;
      if (value) {
        await this.saveToDB(value);
      }
    }

    this.isProcessing = false;
  }

  /**
   * LCPテーブルにLCP情報を保存
   */
  private async saveToDB(value: QueueForm): Promise<void> {
    // await this.urlRepository.save(value.url);
    // const urlEntity: UrlEntity = await this.urlRepository.findByUrl(value.url);
    await this.lcpRepository.save(value.lcp, value.selector, value.urlId);
  }
}
