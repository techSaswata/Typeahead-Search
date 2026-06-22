#!/usr/bin/env node
/*
 * merge-datasets.js — Merge all per-source datasets into one unified corpus.
 *
 * Input  : data/sources/*.tsv   (each "query\tcount", sorted by count desc)
 * Output : data/queries.tsv     ("query\tcount\tcategory", sorted desc)
 *
 * Why normalize?  Each source measures popularity on a different scale
 * (Wikipedia page views ~1e5, IMDb votes ~3e6, city population ~3e7, ORCAS
 * click counts ~1e4). Summing raw counts would let one source dominate. So we
 * log-normalize every source to a shared ceiling:
 *
 *     scaled = CEIL * ln(raw + 1) / ln(maxRawOfSource + 1)
 *
 * The top item of each source maps to ~CEIL and the rest compress
 * logarithmically, so famous things from every source interleave sensibly.
 * A query present in multiple sources sums its scaled contributions; its
 * category is the source that contributed the most.
 */
'use strict';
const fs = require('fs');
const readline = require('readline');
const path = require('path');

const SRC = path.join(process.cwd(), 'data', 'sources');
const OUT = path.join(process.cwd(), 'data', 'queries.tsv');

const CEIL = 100_000;
const PER_SOURCE_MAX = Number(process.env.MERGE_PER_SOURCE_MAX ?? 500_000);
const FINAL_MAX = Number(process.env.MERGE_FINAL_MAX ?? 1_200_000);

// Source file -> category label + weight. Files are read in this order.
// Weights rebalance how much each source contributes to the unified score:
// Wikipedia & ORCAS are the most "search-intent"-like, so they keep full
// weight; the huge IMDb name list is noisy (many common first names / single
// words) so it is down-weighted to stop it dominating rankings + category tags.
const SOURCES = [
  { file: 'wikipedia.tsv', category: 'wiki', weight: 1.0 },
  { file: 'imdb-titles.tsv', category: 'movie', weight: 0.85 },
  { file: 'imdb-names.tsv', category: 'person', weight: 0.5 },
  { file: 'geonames.tsv', category: 'place', weight: 0.85 },
  { file: 'orcas.tsv', category: 'query', weight: 1.0 },
];

const ALLOWED_RE = /^[\p{L}\p{N}][\p{L}\p{N} \-'&.,()!+#:/]*$/u;

function clean(q) {
  q = q.replace(/\s+/g, ' ').trim();
  if (q.length < 2 || q.length > 80) return null;
  if (q.split(' ').length > 10) return null;
  if (!ALLOWED_RE.test(q)) return null;
  return q;
}

function niceness(s) {
  let score = 0;
  for (const w of s.split(' ')) {
    if (/^[A-Z][a-z]/.test(w)) score += 2;
    else if (/^[a-z]/.test(w)) score += 1;
  }
  return score;
}

/** normKey -> { query, score, category, best } (best = top single contribution) */
const merged = new Map();

function fileLines(p) {
  return readline.createInterface({ input: fs.createReadStream(p), crlfDelay: Infinity });
}

async function ingest(file, category, weight = 1) {
  const full = path.join(SRC, file);
  if (!fs.existsSync(full)) {
    console.error(`[merge] skip missing ${file}`);
    return 0;
  }
  let maxRaw = 0;
  let n = 0;
  let added = 0;
  const lnMax = () => Math.log(maxRaw + 1);
  // Within ONE source, the same normalized key (e.g. many different people all
  // named "Brian Smith") must contribute its MAX, not its sum — otherwise common
  // names inflate. We sum only ACROSS sources. srcApplied tracks how much this
  // source has already contributed to each key.
  const srcApplied = new Map();
  for await (const line of fileLines(full)) {
    if (n >= PER_SOURCE_MAX) break;
    const tab = line.indexOf('\t');
    if (tab < 0) continue;
    const rawQ = line.slice(0, tab);
    const raw = parseInt(line.slice(tab + 1), 10);
    if (!Number.isFinite(raw) || raw <= 0) continue;
    if (maxRaw === 0) maxRaw = raw; // first line == max (files are sorted desc)
    n++;
    const q = clean(rawQ);
    if (!q) continue;
    const scaled = Math.round((weight * CEIL * Math.log(raw + 1)) / lnMax());
    if (scaled <= 0) continue;
    const key = q.toLowerCase();
    const cur = merged.get(key);
    if (cur) {
      const prevFromSrc = srcApplied.get(key) ?? 0;
      if (scaled > prevFromSrc) {
        cur.score += scaled - prevFromSrc; // raise this source's share to its max
        srcApplied.set(key, scaled);
        if (scaled > cur.best) {
          cur.best = scaled;
          cur.category = category;
        }
        if (niceness(q) > niceness(cur.query)) cur.query = q;
      }
    } else {
      merged.set(key, { query: q, score: scaled, category, best: scaled });
      srcApplied.set(key, scaled);
      added++;
    }
  }
  console.error(`[merge] ${file}: read ${n} (max raw ${maxRaw}) -> +${added} new, ${merged.size} total`);
  return added;
}

async function main() {
  for (const s of SOURCES) await ingest(s.file, s.category, s.weight);

  console.error(`[merge] sorting ${merged.size} unique queries...`);
  const rows = [...merged.values()].sort((a, b) => b.score - a.score);
  const out = fs.createWriteStream(OUT);
  const limit = Math.min(rows.length, FINAL_MAX);
  for (let i = 0; i < limit; i++) {
    const r = rows[i];
    out.write(`${r.query}\t${r.score}\t${r.category}\n`);
  }
  await new Promise((r) => out.end(r));

  // Category breakdown for the top slice (what the app will actually load).
  const byCat = {};
  for (let i = 0; i < limit; i++) byCat[rows[i].category] = (byCat[rows[i].category] ?? 0) + 1;
  console.error(`[merge] wrote ${limit} rows to ${OUT}`);
  console.error('[merge] category breakdown (top slice):', byCat);
}

main().catch((e) => { console.error(e); process.exit(1); });
