#!/usr/bin/env node
/*
 * process-imdb.js — Turn IMDb's official TSV dumps into query\tcount files.
 *
 *   data/sources/imdb-titles.tsv  : "<title>\t<numVotes>"   (movies & TV)
 *   data/sources/imdb-names.tsv   : "<person>\t<sumVotes>"  (cast/crew)
 *
 * Count signal = IMDb vote counts (a real popularity measure):
 *   - titles  -> the title's own numVotes
 *   - people  -> sum of numVotes across their knownForTitles
 *
 * Source: https://datasets.imdbws.com/ (free, no auth).
 */
'use strict';
const fs = require('fs');
const zlib = require('zlib');
const readline = require('readline');
const path = require('path');

const RAW = path.join(process.cwd(), 'data', '.raw');
const OUT = path.join(process.cwd(), 'data', 'sources');
fs.mkdirSync(OUT, { recursive: true });

const TITLE_MIN_VOTES = Number(process.env.IMDB_TITLE_MIN_VOTES ?? 20);
const NAME_MIN_VOTES = Number(process.env.IMDB_NAME_MIN_VOTES ?? 200);
const TITLE_TYPES = new Set(['movie', 'tvSeries', 'tvMiniSeries', 'tvMovie', 'tvSpecial']);

function lines(gzPath) {
  return readline.createInterface({
    input: fs.createReadStream(gzPath).pipe(zlib.createGunzip()),
    crlfDelay: Infinity,
  });
}

async function main() {
  // 1) tconst -> numVotes
  console.error('[imdb] reading ratings...');
  const votes = new Map();
  {
    let first = true;
    for await (const line of lines(path.join(RAW, 'imdb-title-ratings.tsv.gz'))) {
      if (first) { first = false; continue; } // header
      const c = line.split('\t');
      const v = parseInt(c[2], 10);
      if (Number.isFinite(v)) votes.set(c[0], v);
    }
  }
  console.error(`[imdb] ${votes.size} rated titles`);

  // 2) titles -> title\tnumVotes
  console.error('[imdb] writing titles...');
  const titlesOut = fs.createWriteStream(path.join(OUT, 'imdb-titles.tsv'));
  let nTitles = 0;
  {
    let first = true;
    for await (const line of lines(path.join(RAW, 'imdb-title-basics.tsv.gz'))) {
      if (first) { first = false; continue; }
      // tconst titleType primaryTitle originalTitle isAdult startYear endYear runtime genres
      const c = line.split('\t');
      if (!TITLE_TYPES.has(c[1])) continue;
      if (c[4] === '1') continue; // skip adult
      const v = votes.get(c[0]) ?? 0;
      if (v < TITLE_MIN_VOTES) continue;
      const title = c[2];
      if (!title || title === '\\N') continue;
      titlesOut.write(`${title}\t${v}\n`);
      nTitles++;
    }
  }
  await new Promise((r) => titlesOut.end(r));
  console.error(`[imdb] wrote ${nTitles} titles`);

  // 3) people -> person\tsum(votes of knownForTitles)
  console.error('[imdb] writing names...');
  const namesOut = fs.createWriteStream(path.join(OUT, 'imdb-names.tsv'));
  let nNames = 0;
  {
    let first = true;
    for await (const line of lines(path.join(RAW, 'imdb-name-basics.tsv.gz'))) {
      if (first) { first = false; continue; }
      // nconst primaryName birthYear deathYear primaryProfession knownForTitles
      const c = line.split('\t');
      const name = c[1];
      if (!name || name === '\\N') continue;
      const known = c[5];
      if (!known || known === '\\N') continue;
      let sum = 0;
      for (const t of known.split(',')) sum += votes.get(t) ?? 0;
      if (sum < NAME_MIN_VOTES) continue;
      namesOut.write(`${name}\t${sum}\n`);
      nNames++;
    }
  }
  await new Promise((r) => namesOut.end(r));
  console.error(`[imdb] wrote ${nNames} names`);
}

main().catch((e) => { console.error(e); process.exit(1); });
