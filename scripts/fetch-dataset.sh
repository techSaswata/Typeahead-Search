#!/usr/bin/env bash
#
# fetch-dataset.sh — Build a unified, multi-source query dataset.
#
# Sources (all free, no auth):
#   1. Wikipedia pageviews   -> encyclopedic topics      (category: wiki)
#   2. IMDb title basics     -> movies & TV              (category: movie)
#   3. IMDb name basics      -> people (cast/crew)       (category: person)
#   4. GeoNames cities500    -> world places             (category: place)
#   5. ORCAS (Bing)          -> real search queries      (category: query)
#
# Each source is normalized into data/sources/<name>.tsv ("query\tcount", sorted
# by count desc), then merge-datasets.js log-normalizes and combines them into
# data/queries.tsv ("query\tcount\tcategory").

set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p data data/.raw data/sources

RAW=data/.raw
SRC=data/sources

# ── 0. Download all raw inputs ────────────────────────────────────────────
bash scripts/download-sources.sh

# ── 1. Wikipedia pageviews (downloads its own hourly dumps if absent) ──────
DATE="20240115"; MONTH="2024-01"; YEAR="2024"
HOURS=(000000 030000 060000 090000 120000 150000 180000 210000)
BASE="https://dumps.wikimedia.org/other/pageviews/${YEAR}/${MONTH}"
echo "[wiki] ensuring hourly dumps..."
for h in "${HOURS[@]}"; do
  f="$RAW/pageviews-${DATE}-${h}.gz"
  [[ -s "$f" ]] || { echo "  fetching ${h}"; curl -sf "${BASE}/pageviews-${DATE}-${h}.gz" -o "$f"; }
done
echo "[wiki] aggregating + cleaning..."
gzip -dc $RAW/pageviews-${DATE}-*.gz \
  | awk '$1=="en" { c[$2]+=$3 } END { for (t in c) print t "\t" c[t] }' \
  > $RAW/en-aggregated.tsv
node scripts/clean-dataset.js $RAW/en-aggregated.tsv $SRC/wikipedia.tsv   # sorted desc

# ── 2. IMDb (titles + names) via the node processor ───────────────────────
echo "[imdb] processing..."
node scripts/process-imdb.js
echo "[imdb] sorting by count desc..."
sort -t$'\t' -k2,2nr -o $SRC/imdb-titles.tsv $SRC/imdb-titles.tsv
sort -t$'\t' -k2,2nr -o $SRC/imdb-names.tsv  $SRC/imdb-names.tsv

# ── 3. GeoNames cities (name \t population, summed per name, sorted desc) ──
echo "[geonames] processing..."
unzip -o -q $RAW/geonames-cities500.zip -d $RAW/geonames
# Columns: 2=name, 15=population (tab-separated). Sum population per name.
awk -F'\t' '$15+0 > 0 { c[$2]+=$15 } END { for (n in c) print n "\t" c[n] }' \
  $RAW/geonames/cities500.txt | sort -t$'\t' -k2,2nr > $SRC/geonames.tsv

# ── 4. ORCAS (real Bing queries): frequency = number of click rows ─────────
echo "[orcas] aggregating query frequencies (this takes a minute)..."
# Format: qid \t query \t did \t url  -> take query column, count occurrences.
gzip -dc $RAW/orcas.tsv.gz \
  | cut -f2 \
  | sort -S 1G \
  | uniq -c \
  | sort -rn \
  | awk '{ n=$1; $1=""; q=substr($0,2); if (n>=2 && length(q)>=2) print q "\t" n }' \
  > $SRC/orcas.tsv

# ── 5. Merge everything into the unified corpus ───────────────────────────
echo "[merge] combining all sources..."
NODE_OPTIONS=--max-old-space-size=6144 node scripts/merge-datasets.js

echo
echo "[dataset] Done. Unified dataset:"
wc -l data/queries.tsv
echo "[dataset] Top 15:"
head -15 data/queries.tsv
echo "[dataset] Per-source line counts:"
wc -l $SRC/*.tsv
