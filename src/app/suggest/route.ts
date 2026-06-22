// GET /suggest?q=<prefix>&mode=<popular|trending>&limit=<n>
// Returns up to 10 prefix-matching suggestions sorted by count (popular) or by
// a recency-aware blend (trending). Served from the distributed cache when warm,
// otherwise computed from the Trie and then cached.
import { NextRequest, NextResponse } from 'next/server';
import { getEngine } from '@/lib/engine';
import { config } from '@/lib/config';
import type { RankingMode } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const engine = await getEngine();
  const sp = req.nextUrl.searchParams;

  // Graceful handling of empty / missing input (PRD §4.1).
  const raw = sp.get('q');
  const q = (raw ?? '').toString();
  const mode: RankingMode = sp.get('mode') === 'trending' ? 'trending' : 'popular';
  const VALID_CATS = ['wiki', 'movie', 'person', 'place', 'query', 'search'];
  const catParam = (sp.get('category') ?? 'all').toLowerCase();
  const category = catParam === 'all' || VALID_CATS.includes(catParam) ? catParam : 'all';
  const limitParam = Number(sp.get('limit'));
  const limit =
    Number.isFinite(limitParam) && limitParam > 0
      ? Math.min(limitParam, config.maxSuggestions)
      : config.maxSuggestions;

  if (q.trim().length === 0) {
    return NextResponse.json({
      prefix: q,
      mode,
      suggestions: [],
      cacheHit: false,
      cacheNode: null,
      latencyMs: 0,
    });
  }

  const result = engine.suggest(q, mode, limit, category);
  return NextResponse.json(result);
}
