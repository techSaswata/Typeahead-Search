// GET /metrics
// One-stop performance + behavior report (PRD §10): suggestion latency
// percentiles, cache hit rate per node, DB read/write counts, and the
// write-reduction achieved by batching.
import { NextResponse } from 'next/server';
import { getEngine } from '@/lib/engine';
import { config } from '@/lib/config';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const engine = await getEngine();
  const mem = process.memoryUsage();

  return NextResponse.json({
    uptimeMs: Date.now() - engine.bootedAt,
    dataset: {
      storeRows: engine.store.rowCount(),
      trieSize: engine.trieSize,
      seededRows: engine.seededRows,
      buildMs: engine.buildMs,
    },
    suggestLatency: engine.latency.suggest.snapshot(),
    cache: engine.cache.stats(),
    batchWrites: {
      ...engine.batch.metrics,
      reduction: engine.batch.writeReduction(),
    },
    primaryStore: engine.store.metrics,
    trending: {
      trackedQueries: engine.trending.trackedCount,
      totalEvents: engine.trending.totalEvents,
      halfLifeMs: config.trendingHalfLifeMs,
      recencyWeight: config.trendingRecencyWeight,
    },
    memory: {
      heapUsedMB: +(mem.heapUsed / 1048576).toFixed(1),
      rssMB: +(mem.rss / 1048576).toFixed(1),
    },
    config: {
      maxSuggestions: config.maxSuggestions,
      cacheNodes: config.cacheNodes,
      cacheTtlMs: config.cacheTtlMs,
      cacheCapacityPerNode: config.cacheCapacityPerNode,
      cacheVirtualNodes: config.cacheVirtualNodes,
      batchMaxSize: config.batchMaxSize,
      batchIntervalMs: config.batchIntervalMs,
    },
  });
}
