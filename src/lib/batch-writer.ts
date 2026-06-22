// batch-writer.ts — Buffered, aggregated, asynchronous write path.
//
// PRD §8: avoid writing to the primary store synchronously for every search.
// Instead, each POST /search appends to an in-memory buffer. A background
// flusher drains the buffer either every `intervalMs` OR as soon as it reaches
// `maxSize` events. Crucially, repeated queries are AGGREGATED before writing:
// 1000 searches for "youtube" become a single "+1000" row update.
//
// Effect on DB pressure:
//   writes_without_batching = number of searches (1 per event)
//   writes_with_batching    = number of distinct queries per flush
// We track both so the report can quantify the reduction.
//
// Failure trade-off (discussed in README): the buffer is in memory. If the
// process crashes between flushes, up to `maxSize` (or intervalMs worth of)
// events are lost — counts are approximate analytics, not transactional money,
// so this is an acceptable trade for the large write-amplification savings. A
// production system would back the buffer with an append-only log / Kafka to
// make it durable; the aggregation logic here would be identical.

import type { PrimaryStore } from './store';
import type { CompletionTrie } from './trie';
import type { DistributedCache } from './cache';
import type { TrendingEngine } from './trending';

interface BatchWriterDeps {
  store: PrimaryStore;
  trie: CompletionTrie;
  cache: DistributedCache;
  trending: TrendingEngine;
  maxSize: number;
  intervalMs: number;
  now: () => number;
}

export class BatchWriter {
  /** Aggregation buffer: query -> pending count delta since last flush. */
  private buffer = new Map<string, number>();
  /** Original casing seen for each normalized query (for fresh inserts). */
  private casing = new Map<string, string>();
  private timer: ReturnType<typeof setInterval> | null = null;

  metrics = {
    eventsAccepted: 0, // total searches submitted
    rowsWritten: 0, // total physical row upserts performed
    flushes: 0,
    lastFlushSize: 0,
    lastFlushAt: 0,
    bufferedNow: 0,
  };

  constructor(private deps: BatchWriterDeps) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.flush('interval'), this.deps.intervalMs);
    // Don't keep the event loop alive solely for the flush timer.
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Accept a search submission. Returns immediately (no DB write here).
   * Updating the recency/trending score IS done synchronously because it is a
   * cheap in-memory O(1) op and we want trending to reflect activity instantly.
   */
  submit(query: string): void {
    const now = this.deps.now();
    const key = query.trim().toLowerCase();
    if (!key) return;

    this.buffer.set(key, (this.buffer.get(key) ?? 0) + 1);
    if (!this.casing.has(key)) this.casing.set(key, query.trim());
    this.metrics.eventsAccepted++;
    this.metrics.bufferedNow = this.buffer.size;

    // Recency is hot and must be instant -> update synchronously.
    this.deps.trending.record(query, now);

    if (this.buffer.size >= this.deps.maxSize) {
      this.flush('size');
    }
  }

  /**
   * Drain the buffer: one DB transaction, update the Trie's top-K caches, and
   * invalidate affected cache prefixes so suggestions reflect the new counts.
   */
  flush(reason: 'size' | 'interval' | 'manual' = 'manual'): number {
    if (this.buffer.size === 0) return 0;
    const now = this.deps.now();
    const deltas = this.buffer;
    const casing = this.casing;
    this.buffer = new Map();
    this.casing = new Map();

    // 1) Durable write to the primary store (single transaction).
    const written = this.deps.store.applyBatch(
      new Map([...deltas].map(([k, v]) => [casing.get(k) ?? k, v])),
      now
    );

    // 2) Reflect deltas in the in-memory Trie and invalidate caches.
    for (const [key, delta] of deltas) {
      const original = casing.get(key) ?? key;
      this.deps.trie.upsert(original, delta);
      this.deps.cache.invalidateForQuery(original);
    }

    this.metrics.rowsWritten += written;
    this.metrics.flushes++;
    this.metrics.lastFlushSize = deltas.size;
    this.metrics.lastFlushAt = now;
    this.metrics.bufferedNow = 0;
    void reason;
    return written;
  }

  /** Write-amplification saved by batching, for the report. */
  writeReduction(): { events: number; rows: number; ratio: number; savedPct: number } {
    const events = this.metrics.eventsAccepted;
    const rows = this.metrics.rowsWritten + this.buffer.size; // pending not yet written
    const ratio = rows > 0 ? +(events / rows).toFixed(2) : 0;
    const saved = events > 0 ? +(((events - this.metrics.rowsWritten) / events) * 100).toFixed(2) : 0;
    return { events, rows: this.metrics.rowsWritten, ratio, savedPct: saved };
  }
}
