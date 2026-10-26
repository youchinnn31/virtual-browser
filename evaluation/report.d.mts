export function writeReport(
  output: string,
  rows: Array<{
    url: string;
    speed: number;
    status: string;
    database?: string;
    warmup?: number;
    collected?: { candidates: number };
    samples: Array<{
      lcp: number;
      trial: number;
      access: number;
      renderKind?: string;
      firstXpath?: string;
      finalUrl?: string;
      lcpImages?: number;
      candidates?: Array<{
        xpath: string;
        lcp: number;
        status: string;
        detail?: string;
      }>;
    }>;
  }>,
  options?: {
    conditions?: Array<[string, string | number]>;
    controls?: Array<{ at: string; kind: string; data: unknown }>;
  },
): Promise<void>;
export function median(samples: Array<{ lcp: number }>): number | null;
