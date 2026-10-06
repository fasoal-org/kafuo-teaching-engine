/**
 * POST /api/internal/sweep — one idempotent pass of every accounting sweeper
 * (Kafuo R1 plan §9.4 item 3).
 *
 * The built-in timers need a long-lived Node process. A deployment without one
 * (serverless) stays compliant by having an external scheduler call this at
 * least every minute with the service key. Both do the same guarded work, so
 * a timer and a scheduler running together are harmless.
 *
 * The meter finalize outbox sweeper (P5) is reached through the sweep
 * registry: `meter` is `null` until it registers.
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { isTeachingPackageApiConfigured } from '@/lib/config/feature-flags';
import { runAccountingSweepOnce } from '@/lib/server/teaching-model/accounting-sweeper';
import { getMeterOutboxSweeper } from '@/lib/server/teaching-model/sweep-registry';
import { teachingPackageErrorResponse } from '@/lib/server/teaching-package/route-helpers';
import { describeErrorSafely } from '@/lib/server/teaching-package/safe-error';
import { authenticateServiceRequest } from '@/lib/server/teaching-package/service-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  if (!isTeachingPackageApiConfigured()) return new Response('Not found', { status: 404 });
  try {
    authenticateServiceRequest(req);
    const ledger = await runAccountingSweepOnce();
    const meterSweeper = getMeterOutboxSweeper();
    const meter = meterSweeper ? await meterSweeper.runMeterOutboxSweepOnce() : null;
    return NextResponse.json({ ledger: { marked: ledger.marked }, meter });
  } catch (error) {
    const mapped = teachingPackageErrorResponse(error);
    if (mapped) return mapped;
    console.error('internal sweep failed', JSON.stringify(describeErrorSafely(error)));
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: 'sweep failed', retryable: true } },
      { status: 500 },
    );
  }
}
