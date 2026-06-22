// GET /trending?limit=<n>
// Top trending queries right now, ranked by decayed recency score (PRD §7).
import { NextRequest, NextResponse } from 'next/server';
import { getEngine } from '@/lib/engine';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const engine = await getEngine();
  const n = Number(req.nextUrl.searchParams.get('limit'));
  const limit = Number.isFinite(n) && n > 0 ? Math.min(n, 25) : 10;
  const now = Date.now();

  return NextResponse.json({
    trending: engine.trending.top(limit, now),
    trackedQueries: engine.trending.trackedCount,
    totalEvents: engine.trending.totalEvents,
  });
}
