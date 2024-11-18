"use strict";

import { QueueForm } from "./types/queueForm";
import { UrlEntity } from "./types/urlEntity";
import { UrlRepository } from "./repository/url.repository";
import { LcpRepository } from "./repository/lcp.repository";

/**
 *
 */
export class Queue {
  /** データ保存用Queue */
  private queue: QueueForm[] = [];
  /** Queueの処理状態を管理 */
  private isProcessing = false;

  private urlRepository: UrlRepository;
  private lcpRepository: LcpRepository;

  /**
   * コンストラクタ
   */
  constructor(urlRepository: UrlRepository, lcpRepository: LcpRepository) {
    this.urlRepository = urlRepository;
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

    // if (this.queue.length > 0) {
    //   await this.processQueue();
    // }
  }

  /**
   * LCPテーブルにLCP情報を保存
   */
  private async saveToDB(value: QueueForm): Promise<void> {
    // const url: string | undefined = value.lcpMetric.entries[0]?.url;
    const url: string = value.lcpMetric.selector;
    await this.urlRepository.save(value.url);
    const urlEntity: UrlEntity = await this.urlRepository.findByUrl(value.url);
    await this.lcpRepository.save(value.lcpMetric.lcp, url!, urlEntity.id);
    // await this.lcpRepository.save(
    //   JSON.stringify(value.lcpMetric),
    //   urlEntity.id!,
    // );
  }
}
