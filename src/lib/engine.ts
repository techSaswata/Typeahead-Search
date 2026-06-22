// engine.ts — The singleton that wires every subsystem together.
//
//   PrimaryStore (SQLite)  --seed-->  CompletionTrie (in-memory, hot reads)
//                                          ^
//   POST /search --> BatchWriter --flush--+--> invalidate DistributedCache
//                        |                       (consistent hashing)
//                        +--> TrendingEngine (recency)
//
// GET /suggest reads:  DistributedCache (fast path)  ->  Trie (+ recency
// re-rank for trending mode)  ->  cache the result.
//
// The engine is created exactly once per process and cached on globalThis so
// Next.js's dev module reloading doesn't rebuild the (expensive) Trie.

import { PrimaryStore } from './store';
import { CompletionTrie } from './trie';
import { DistributedCache } from './cache';
import { TrendingEngine } from './trending';
import { BatchWriter } from './batch-writer';
import { LatencyRecorder } from './metrics';
import { config } from './config';
import type { RankingMode, SuggestResult, Category } from './types';

export interface Engine {
  store: PrimaryStore;
  trie: CompletionTrie;
  cache: DistributedCache;
  trending: TrendingEngine;
  batch: BatchWriter;
  latency: { suggest: LatencyRecorder };
  bootedAt: number;
  seededRows: number;
  trieSize: number;
  buildMs: number;
  suggest(prefix: string, mode: RankingMode, limit?: number, category?: string): SuggestResult;
  search(query: string): void;
}

const now = () => Date.now();

async function build(): Promise<Engine> {
  const t0 = now();
  const store = new PrimaryStore();
  const seeded = await store.seedIfEmpty(config.seedMaxRows);

  // Build the Trie from the primary store (capped to the top-N rows by count).
  const trie = new CompletionTrie(config.maxSuggestions);
  const cap = config.datasetMaxRows;
  // store.all() yields in PK order; we want the highest counts. Collect into an
  // array and, if it grows large, periodically trim by count to bound memory.
  let collected: Array<{ query: string; count: number; category?: Category }> = [];
  for (const r of store.all()) {
    collected.push({ query: r.query, count: r.count, category: r.category as Category });
    if (collected.length >= cap * 4) {
      collected.sort((a, b) => b.count - a.count);
      collected.length = cap;
    }
  }
  collected.sort((a, b) => b.count - a.count);
  if (collected.length > cap) collected.length = cap;
  trie.bulkLoad(collected);

  const cache = new DistributedCache({
    nodeIds: config.cacheNodes,
    capacityPerNode: config.cacheCapacityPerNode,
    ttlMs: config.cacheTtlMs,
    virtualNodesPerNode: config.cacheVirtualNodes,
  });

  const trending = new TrendingEngine(config.trendingHalfLifeMs);

  const batch = new BatchWriter({
    store,
    trie,
    cache,
    trending,
    maxSize: config.batchMaxSize,
    intervalMs: config.batchIntervalMs,
    now,
  });
  batch.start();

  // Periodically prune negligible trending entries.
  const pruneTimer = setInterval(
    () => trending.prune(now()),
    config.trendingPruneIntervalMs
  );
  if (typeof pruneTimer.unref === 'function') pruneTimer.unref();

  const latency = { suggest: new LatencyRecorder() };
  const buildMs = now() - t0;

  const engine: Engine = {
    store,
    trie,
    cache,
    trending,
    batch,
    latency,
    bootedAt: t0,
    seededRows: seeded,
    trieSize: trie.size,
    buildMs,
    suggest(prefix, mode, limit = config.maxSuggestions, category = 'all') {
      const start = performance.now();
      const t = now();
      const norm = prefix.trim().toLowerCase();

      let cacheHit = false;
      let suggestions = this.cache.get(mode, norm, t, category);
      if (suggestions) {
        cacheHit = true;
      } else {
        const filtered = category !== 'all';
        if (mode === 'trending') {
          // Over-fetch a candidate pool, then re-rank by popularity+recency.
          let pool = this.trie.candidates(norm, config.rerankPool * (filtered ? 4 : 1));
          if (filtered) pool = pool.filter((s) => s.category === category);
          suggestions = this.trending.rerank(pool, t, config.trendingRecencyWeight, limit);
        } else if (filtered) {
          // Category filter: over-fetch from the Trie, then keep matching ones.
          suggestions = this.trie
            .candidates(norm, config.rerankPool * 4)
            .filter((s) => s.category === category)
            .slice(0, limit);
        } else {
          suggestions = this.trie.suggest(norm, limit);
        }
        // Only cache non-empty-prefix results (avoid caching the empty prefix,
        // and there's nothing to cache for empty input anyway).
        if (norm.length > 0) this.cache.set(mode, norm, suggestions, t, category);
      }

      const node = this.cache.debug(mode, norm, t, category).node;
      const latencyMs = +(performance.now() - start).toFixed(4);
      this.latency.suggest.record(latencyMs);
      return { prefix, mode, suggestions, cacheHit, cacheNode: node, latencyMs };
    },
    search(query) {
      this.batch.submit(query);
    },
  };

  return engine;
}

// ---- Singleton management (survives Next.js dev hot-reloads) ----

declare global {
  // eslint-disable-next-line no-var
  var __TYPEAHEAD_ENGINE__: Promise<Engine> | undefined;
}

export function getEngine(): Promise<Engine> {
  if (!globalThis.__TYPEAHEAD_ENGINE__) {
    globalThis.__TYPEAHEAD_ENGINE__ = build();
  }
  return globalThis.__TYPEAHEAD_ENGINE__;
}
