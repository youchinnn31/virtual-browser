"use strict";

import { LcpMetric } from "./lcpMetric";

/**
 * Queueの入れるコンテンツ
 */
export interface QueueForm {
  /** LCPメトリック */
  lcpMetric: LcpMetric;
  /** ページのURL */
  url: string;
}
