// GET /cache/debug?prefix=<prefix>&mode=<popular|trending>
// Shows how a prefix routes through the consistent-hashing ring: which cache
// node owns it, the key hash, the ring position, and whether it is currently a
// hit or a miss. Also returns the ring's load distribution across nodes.
import { NextRequest, NextResponse } from 'next/server';
import { getEngine } from '@/lib/engine';
import type { RankingMode } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const engine = await getEngine();
  const sp = req.nextUrl.searchParams;
  const prefix = (sp.get('prefix') ?? sp.get('q') ?? '').toString();
  const mode: RankingMode = sp.get('mode') === 'trending' ? 'trending' : 'popular';

  const info = engine.cache.debug(mode, prefix, Date.now());

  return NextResponse.json({
    prefix,
    mode,
    ownerNode: info.node,
    keyHash: info.keyHash,
    ringPosition: info.ringPos,
    cacheKey: info.key,
    status: info.hit ? 'HIT' : 'MISS',
    nodes: engine.cache.nodeIds,
    ringDistributionPct: engine.cache.ringDistribution(),
  });
}
