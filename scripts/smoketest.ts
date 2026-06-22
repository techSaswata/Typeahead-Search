// Quick standalone validation of the engine core: seed -> build Trie ->
// run sample suggests, batch writes, trending. Prints timing + memory.
import { getEngine } from '../src/lib/engine';

function mb(bytes: number) {
  return (bytes / 1024 / 1024).toFixed(1) + ' MB';
}

async function main() {
  console.log('Booting engine (seed + Trie build)...');
  const t0 = Date.now();
  const e = await getEngine();
  console.log(`  booted in ${Date.now() - t0}ms`);
  console.log(`  seeded rows: ${e.seededRows}, trie size: ${e.trieSize}, buildMs: ${e.buildMs}`);
  console.log(`  store rowCount: ${e.store.rowCount()}`);
  console.log(`  heap used: ${mb(process.memoryUsage().heapUsed)}, rss: ${mb(process.memoryUsage().rss)}`);

  const prefixes = ['you', 'a', 'mar', 'iph', 'java', 'the', 'b', 'new york', 'zzz', ''];
  console.log('\nSample suggestions (popular mode):');
  for (const p of prefixes) {
    const r = e.suggest(p, 'popular');
    console.log(
      `  q="${p}" -> [${r.suggestions.slice(0, 5).map((s) => `${s.query}·${s.category}(${s.count})`).join(', ')}]  ${r.latencyMs}ms node=${r.cacheNode} hit=${r.cacheHit}`
    );
  }

  // Latency micro-bench over many random prefixes (cache warm + cold mix).
  console.log('\nLatency bench (5000 random suggests):');
  const alphabet = 'abcdefghijklmnopqrstuvwxyz';
  const t1 = Date.now();
  for (let i = 0; i < 5000; i++) {
    const len = 1 + (i % 4);
    let p = '';
    for (let j = 0; j < len; j++) p += alphabet[(i * 7 + j * 13) % 26];
    e.suggest(p, 'popular');
  }
  console.log(`  5000 suggests in ${Date.now() - t1}ms`);
  console.log('  latency snapshot:', e.latency.suggest.snapshot());

  // Batch write + trending demo.
  console.log('\nBatch write + trending demo:');
  for (let i = 0; i < 1000; i++) e.search('Claude (AI assistant)');
  for (let i = 0; i < 50; i++) e.search('YouTube');
  e.batch.flush('manual');
  console.log('  write reduction:', e.batch.writeReduction());
  console.log('  trending top:', e.trending.top(5, Date.now()));
  const tr = e.suggest('cla', 'trending');
  console.log('  "cla" trending mode:', tr.suggestions.slice(0, 5).map((s) => `${s.query}(${s.count}|${s.score})`));

  console.log('\ncache stats overallHitRate:', e.cache.stats().overallHitRate);
  console.log('ring distribution:', e.cache.ringDistribution());
  console.log('\nOK');
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
