// metrics.ts — Lightweight latency recorder with percentile reporting.
//
// Keeps a bounded ring buffer of the most recent samples (so memory is O(1))
// and computes p50/p95/p99 on demand. Used to satisfy PRD §10's request to
// measure and report suggestion latency, including p95.

export class LatencyRecorder {
  private buf: Float64Array;
  private idx = 0;
  private filled = 0;
  count = 0;
  sum = 0;

  constructor(private capacity = 5000) {
    this.buf = new Float64Array(capacity);
  }

  record(ms: number): void {
    this.buf[this.idx] = ms;
    this.idx = (this.idx + 1) % this.capacity;
    this.filled = Math.min(this.filled + 1, this.capacity);
    this.count++;
    this.sum += ms;
  }

  private percentile(sorted: number[], p: number): number {
    if (sorted.length === 0) return 0;
    const rank = (p / 100) * (sorted.length - 1);
    const lo = Math.floor(rank);
    const hi = Math.ceil(rank);
    if (lo === hi) return sorted[lo];
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (rank - lo);
  }

  snapshot() {
    const sample = Array.from(this.buf.subarray(0, this.filled)).sort((a, b) => a - b);
    return {
      count: this.count,
      avgMs: this.count ? +(this.sum / this.count).toFixed(4) : 0,
      p50Ms: +this.percentile(sample, 50).toFixed(4),
      p95Ms: +this.percentile(sample, 95).toFixed(4),
      p99Ms: +this.percentile(sample, 99).toFixed(4),
      maxMs: sample.length ? +sample[sample.length - 1].toFixed(4) : 0,
      windowSize: this.filled,
    };
  }
}
