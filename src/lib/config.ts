// config.ts — Central, env-overridable configuration for the whole engine.
// Every tunable lives here so the design choices are easy to find and explain.

function num(name: string, def: number): number {
  const v = process.env[name];
  if (v === undefined) return def;
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

export const config = {
  // ---- Suggestions ----
  maxSuggestions: num('MAX_SUGGESTIONS', 10), // PRD: at most 10
  // Candidate pool fetched from the Trie before recency re-ranking (trending).
  rerankPool: num('RERANK_POOL', 60),

  // ---- Dataset / seeding ----
  // Rows seeded from the (count-sorted) TSV into the durable primary store on
  // first boot. The full TSV (millions of rows) stays on disk; the store keeps
  // a generous top slice so it is richer than the in-memory Trie.
  seedMaxRows: num('SEED_MAX_ROWS', 1_200_000),
  // Cap of top-by-count queries loaded from the store into the in-memory Trie
  // (the hot read structure). Far above the PRD's 100k minimum.
  datasetMaxRows: num('DATASET_MAX_ROWS', 500_000),

  // ---- Distributed cache ----
  cacheNodes: (process.env.CACHE_NODES ?? 'cache-0,cache-1,cache-2,cache-3,cache-4,cache-5,cache-6,cache-7')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  cacheCapacityPerNode: num('CACHE_CAPACITY_PER_NODE', 5_000),
  cacheTtlMs: num('CACHE_TTL_MS', 30_000), // 30s expiry so updates show through
  cacheVirtualNodes: num('CACHE_VNODES', 150),

  // ---- Batch writes ----
  batchMaxSize: num('BATCH_MAX_SIZE', 200), // flush after N buffered events
  batchIntervalMs: num('BATCH_INTERVAL_MS', 2_000), // ...or every N ms

  // ---- Trending / recency ----
  trendingHalfLifeMs: num('TRENDING_HALF_LIFE_MS', 5 * 60_000), // 5 min half-life
  trendingRecencyWeight: num('TRENDING_RECENCY_WEIGHT', 2.5), // blend weight
  trendingPruneIntervalMs: num('TRENDING_PRUNE_INTERVAL_MS', 60_000),
};

export type Config = typeof config;
