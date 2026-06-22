// trending.ts — Recency-aware ranking via exponential time decay.
//
// PRD §7 asks us to combine all-time popularity with recent activity, without
// permanently over-ranking a query that was hot for only a short window.
//
// Approach — exponentially decayed counters (a streaming, O(1)-per-event
// alternative to fixed sliding windows):
//   * Every search adds +1 to that query's "recency score".
//   * The score decays continuously with a configurable half-life. A query
//     searched 5x in the last minute outranks one searched 5x an hour ago, and
//     a short burst fades on its own once searches stop — no manual expiry.
//   * We never store a timestamp series; we keep one (score, lastTs) pair per
//     active query and lazily apply decay on read/write. This is cheap and
//     bounded: queries decay out of relevance and get pruned.
//
// Two consumers:
//   1. Trending section  -> pure recency score (what's hot right now).
//   2. "trending" suggest ranking -> a BLEND of log(all-time count) and recency
//      so the dropdown favours rising queries while staying stable for the
//      long tail. The blend weight is configurable (TRENDING_RECENCY_WEIGHT).

import type { Suggestion } from './types';

interface Decayed {
  score: number;
  lastTs: number;
}

export class TrendingEngine {
  private map = new Map<string, Decayed>();
  private readonly halfLifeMs: number;
  /** ln(2) precomputed for the decay exponent. */
  private static readonly LN2 = Math.log(2);
  totalEvents = 0;

  constructor(halfLifeMs: number) {
    this.halfLifeMs = halfLifeMs;
  }

  private decayFactor(dtMs: number): number {
    if (dtMs <= 0) return 1;
    return Math.exp((-TrendingEngine.LN2 * dtMs) / this.halfLifeMs);
  }

  /** Record one search occurrence for `query` at time `now`. */
  record(query: string, now: number, weight = 1): void {
    const key = query.trim().toLowerCase();
    if (!key) return;
    const cur = this.map.get(key);
    if (cur) {
      cur.score = cur.score * this.decayFactor(now - cur.lastTs) + weight;
      cur.lastTs = now;
    } else {
      this.map.set(key, { score: weight, lastTs: now });
    }
    this.totalEvents += weight;
  }

  /** Current decayed recency score for a query (0 if untracked). */
  recencyScore(query: string, now: number): number {
    const e = this.map.get(query.trim().toLowerCase());
    if (!e) return 0;
    return e.score * this.decayFactor(now - e.lastTs);
  }

  /**
   * Re-rank a candidate pool by a blend of all-time popularity and recency.
   * blended = log10(count + 1) + weight * recencyScore
   * Returns the top `limit` with the blended score attached for transparency.
   */
  rerank(candidates: Suggestion[], now: number, weight: number, limit: number): Suggestion[] {
    const scored = candidates.map((c) => {
      const recency = this.recencyScore(c.query, now);
      const score = Math.log10(c.count + 1) + weight * recency;
      return { query: c.query, count: c.count, category: c.category, score: +score.toFixed(4) };
    });
    scored.sort((a, b) => b.score - a.score || b.count - a.count);
    return scored.slice(0, limit);
  }

  /** Top trending queries right now, by pure decayed recency score. */
  top(limit: number, now: number): Array<{ query: string; score: number }> {
    const out: Array<{ query: string; score: number }> = [];
    for (const [query, e] of this.map) {
      const score = e.score * this.decayFactor(now - e.lastTs);
      if (score > 0.01) out.push({ query, score: +score.toFixed(4) });
    }
    out.sort((a, b) => b.score - a.score);
    return out.slice(0, limit);
  }

  /** Drop queries whose decayed score has become negligible (housekeeping). */
  prune(now: number, threshold = 0.01): number {
    let n = 0;
    for (const [query, e] of [...this.map]) {
      if (e.score * this.decayFactor(now - e.lastTs) < threshold) {
        this.map.delete(query);
        n++;
      }
    }
    return n;
  }

  get trackedCount(): number {
    return this.map.size;
  }
}
