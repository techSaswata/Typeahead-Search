// POST /search   body: { "query": "<text>" }
// Dummy search endpoint (PRD §4.2 / §5). Records the submitted query via the
// batch writer (no synchronous DB write) and returns { "message": "Searched" }.
import { NextRequest, NextResponse } from 'next/server';
import { getEngine } from '@/lib/engine';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const engine = await getEngine();
  let query = '';
  try {
    const body = await req.json();
    query = (body?.query ?? '').toString();
  } catch {
    // Allow ?q= fallback for convenience / curl testing.
    query = (req.nextUrl.searchParams.get('q') ?? '').toString();
  }

  if (query.trim().length === 0) {
    return NextResponse.json(
      { message: 'Searched', recorded: false, reason: 'empty query' },
      { status: 200 }
    );
  }

  engine.search(query); // buffered + aggregated; flushed in batches

  return NextResponse.json({
    message: 'Searched',
    recorded: true,
    query: query.trim(),
    buffered: engine.batch.metrics.bufferedNow,
  });
}
