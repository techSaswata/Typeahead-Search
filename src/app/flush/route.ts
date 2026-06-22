// POST /flush  — force the batch writer to drain its buffer now.
// Convenience endpoint for demos/tests so you can immediately observe batched
// writes hitting the store instead of waiting for the periodic flush.
import { NextResponse } from 'next/server';
import { getEngine } from '@/lib/engine';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST() {
  const engine = await getEngine();
  const before = engine.batch.metrics.bufferedNow;
  const written = engine.batch.flush('manual');
  return NextResponse.json({ flushedBufferedQueries: before, rowsWritten: written });
}
