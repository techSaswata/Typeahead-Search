#!/usr/bin/env node
/*
 * clean-dataset.js — Turn raw aggregated Wikipedia titles into clean queries.
 *
 * Input  : TSV "<raw_title>\t<count>" (titles use underscores, may be junk)
 * Output : TSV "<query>\t<count>" sorted by count desc, junk removed.
 *
 * Filtering rules (keep things that read like real search queries):
 *   - drop namespaced/meta pages (User:, Talk:, File:, Wikipedia:, etc.)
 *   - drop the Main_Page and obvious non-queries
 *   - require the title to start with a letter or digit
 *   - length 2..60 chars, at most 8 words
 *   - underscores -> spaces; collapse whitespace
 *   - merge case-variant duplicates by summing counts (keep nicest casing)
 */
'use strict';
const fs = require('fs');
const readline = require('readline');

const [, , inPath, outPath] = process.argv;
if (!inPath || !outPath) {
  console.error('usage: clean-dataset.js <in.tsv> <out.tsv>');
  process.exit(1);
}

const NAMESPACE_RE =
  /^(User|Talk|Wikipedia|File|Category|Template|Portal|Help|Draft|Module|MediaWiki|Special|Book|TimedText|Education_Program|Gadget|Topic)([ _]talk)?:/i;
const JUNK_TITLES = new Set([
  'Main_Page', '-', '404.php', 'Undefined', 'Search', 'Hello', 'Test',
]);

// Keep letters (incl. accented/unicode), digits, spaces, and a few separators.
const ALLOWED_RE = /^[\p{L}\p{N}][\p{L}\p{N} \-'&.,()!+#]*$/u;

/** @type {Map<string, {query: string, count: number}>} */
const merged = new Map();

const rl = readline.createInterface({ input: fs.createReadStream(inPath), crlfDelay: Infinity });

let read = 0;
let kept = 0;

rl.on('line', (line) => {
  read++;
  const tab = line.indexOf('\t');
  if (tab < 0) return;
  const rawTitle = line.slice(0, tab);
  const count = parseInt(line.slice(tab + 1), 10);
  if (!Number.isFinite(count) || count <= 0) return;

  if (JUNK_TITLES.has(rawTitle)) return;
  if (NAMESPACE_RE.test(rawTitle)) return;

  // Decode %xx escapes that occasionally appear, then underscores -> spaces.
  let q;
  try {
    q = decodeURIComponent(rawTitle);
  } catch {
    q = rawTitle;
  }
  q = q.replace(/_/g, ' ').replace(/\s+/g, ' ').trim();

  if (q.length < 2 || q.length > 60) return;
  if (q.split(' ').length > 8) return;
  if (!ALLOWED_RE.test(q)) return;
  // Drop list/index style meta pages that slip past namespace filter.
  if (/^(List of|Index of|Lists of|Outline of)\b/i.test(q)) return;

  // Merge case-insensitively; prefer the casing with most leading-cap words.
  const key = q.toLowerCase();
  const prev = merged.get(key);
  if (prev) {
    prev.count += count;
    if (niceness(q) > niceness(prev.query)) prev.query = q;
  } else {
    merged.set(key, { query: q, count });
    kept++;
  }
});

function niceness(s) {
  // Prefer "Barack Obama" over "barack obama" or "BARACK OBAMA".
  let score = 0;
  for (const w of s.split(' ')) {
    if (/^[A-Z][a-z]/.test(w)) score += 2;
    else if (/^[a-z]/.test(w)) score += 1;
  }
  return score;
}

rl.on('close', () => {
  const rows = [...merged.values()].sort((a, b) => b.count - a.count);
  const out = fs.createWriteStream(outPath);
  for (const r of rows) out.write(`${r.query}\t${r.count}\n`);
  out.end(() => {
    console.error(
      `[clean] read ${read} raw rows -> ${rows.length} unique queries ` +
        `(min count ${rows.length ? rows[rows.length - 1].count : 0}, max ${rows.length ? rows[0].count : 0})`
    );
  });
});
