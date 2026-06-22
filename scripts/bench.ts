// bench.ts — End-to-end performance harness over HTTP (PRD §10).
//
// Measures, against a running server:
//   1. /suggest latency (p50/p95/p99) over a realistic mix of cold + warm
//      prefixes, reporting the client-observed and server-observed numbers.
//   2. Cache hit rate that results from that traffic.
//   3. Write reduction from batching after a burst of /search submissions.
//
// Usage:  npm run bench            (defaults to http://localhost:3210, 5000 reqs)
//         BASE=http://localhost:3000 N=20000 npm run bench

const BASE = process.env.BASE ?? 'http://localhost:3210';
const N = Number(process.env.N ?? 5000);

// A pool of prefixes: a few "hot" ones (cacheable) plus a long tail of random
// short prefixes to mimic real typing (1–4 chars dominate keystroke traffic).
const HOT = ['you', 'the', 'a', 'mar', 'new', 'jav', 'goo', 'app', 'bar', 'cli'];
const LETTERS = 'abcdefghijklmnopqrstuvwxyz';

function randomPrefix(i: number): string {
  if (i % 3 === 0) return HOT[i % HOT.length]; // ~1/3 hot -> drives cache hits
  const len = 1 + (i % 4);
  let s = '';
  for (let j = 0; j < len; j++) s += LETTERS[(i * 7 + j * 31) % 26];
  return s;
}

function pct(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const r = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(r),
    hi = Math.ceil(r);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (r - lo);
}

async function main() {
  console.log(`\nBenchmarking ${BASE} with ${N} /suggest requests...\n`);

  // Warm up + confirm server is alive (and engine is built).
  await fetch(`${BASE}/suggest?q=you`).then((r) => r.json());

  const clientLat: number[] = [];
  const serverLat: number[] = [];
  let hits = 0;

  const t0 = performance.now();
  // Fire with bounded concurrency for realistic throughput.
  const CONC = 24;
  let idx = 0;
  async function worker() {
    while (idx < N) {
      const i = idx++;
      const q = randomPrefix(i);
      const s = performance.now();
      const res = await fetch(`${BASE}/suggest?q=${encodeURIComponent(q)}`);
      const data = await res.json();
      clientLat.push(performance.now() - s);
      serverLat.push(data.latencyMs);
      if (data.cacheHit) hits++;
    }
  }
  await Promise.all(Array.from({ length: CONC }, worker));
  const elapsed = performance.now() - t0;

  clientLat.sort((a, b) => a - b);
  serverLat.sort((a, b) => a - b);

  console.log('── /suggest latency ──');
  console.log(`  throughput      : ${(N / (elapsed / 1000)).toFixed(0)} req/s (conc ${CONC})`);
  console.log(`  client p50/p95/p99 : ${pct(clientLat, 50).toFixed(3)} / ${pct(clientLat, 95).toFixed(3)} / ${pct(clientLat, 99).toFixed(3)} ms`);
  console.log(`  server p50/p95/p99 : ${pct(serverLat, 50).toFixed(4)} / ${pct(serverLat, 95).toFixed(4)} / ${pct(serverLat, 99).toFixed(4)} ms`);
  console.log(`  cache hit rate  : ${((hits / N) * 100).toFixed(1)}%  (${hits}/${N})`);

  // ── Write-reduction test: burst of searches over a small distinct set ──
  console.log('\n── batch write reduction ──');
  const DISTINCT = ['Claude (AI assistant)', 'YouTube', 'Next.js', 'TypeScript', 'Consistent hashing'];
  const SEARCHES = 2000;
  const sw: Promise<unknown>[] = [];
  for (let i = 0; i < SEARCHES; i++) {
    sw.push(
      fetch(`${BASE}/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: DISTINCT[i % DISTINCT.length] }),
      })
    );
    if (sw.length >= 50) {
      await Promise.all(sw.splice(0));
    }
  }
  await Promise.all(sw);
  await fetch(`${BASE}/flush`, { method: 'POST' });

  const m = await fetch(`${BASE}/metrics`).then((r) => r.json());
  console.log(`  searches submitted : ${m.batchWrites.eventsAccepted}`);
  console.log(`  db row-writes      : ${m.batchWrites.rowsWritten}`);
  console.log(`  flushes            : ${m.batchWrites.flushes}`);
  console.log(`  write reduction    : ${m.batchWrites.reduction.savedPct}%  (${m.batchWrites.reduction.ratio}× fewer writes)`);

  console.log('\n── final server metrics ──');
  console.log(`  cache overall hit rate : ${(m.cache.overallHitRate * 100).toFixed(1)}%`);
  console.log(`  trie size / store rows : ${m.dataset.trieSize} / ${m.dataset.storeRows}`);
  console.log(`  memory rss             : ${m.memory.rssMB} MB`);
  console.log(`  ring distribution      :`, m.cache.ringDistribution);
  console.log('\nDone.\n');
}

main().catch((e) => {
  console.error('bench failed:', e);
  process.exit(1);
});
