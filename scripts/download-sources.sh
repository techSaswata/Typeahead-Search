#!/usr/bin/env bash
# download-sources.sh — fetch the raw multi-source datasets (idempotent).
# Total ~880MB. Files land in data/.raw/ and are processed by the per-source
# processors invoked from fetch-dataset.sh.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p data/.raw

dl() { # url dest
  if [[ -s "$2" ]]; then echo "  have $(basename "$2")"; else
    echo "  fetching $(basename "$2")..."; curl -sf "$1" -o "$2";
  fi
}

echo "[sources] IMDb (movies/TV/people)..."
dl "https://datasets.imdbws.com/title.basics.tsv.gz"  data/.raw/imdb-title-basics.tsv.gz
dl "https://datasets.imdbws.com/title.ratings.tsv.gz" data/.raw/imdb-title-ratings.tsv.gz
dl "https://datasets.imdbws.com/name.basics.tsv.gz"   data/.raw/imdb-name-basics.tsv.gz

echo "[sources] GeoNames (world places)..."
dl "https://download.geonames.org/export/dump/cities500.zip" data/.raw/geonames-cities500.zip

echo "[sources] ORCAS (real Bing search queries)..."
dl "https://msmarco.z22.web.core.windows.net/msmarcoranking/orcas.tsv.gz" data/.raw/orcas.tsv.gz

echo "[sources] done."
