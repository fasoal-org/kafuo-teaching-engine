/**
 * `POST /api/tutor/conversations/:id/messages` — one Free Chat turn as SSE
 * (Kafuo R1 contracts §0 H2, §5; plan §4.2, P6).
 *
 * Body `{ clientMessageId, text, localeHint? }`. Student grant + the per-grant
 * turn token bucket (`RATE_LIMITED` 429). Pre-stream refusals are JSON with
 * their HTTP status (`409 TURN_IN_PROGRESS` + `Retry-After`,
 * `403 SUBJECT_NO_LONGER_AVAILABLE`, `422 REQUEST_TOO_LARGE`,
 * `429 ALLOWANCE_EXHAUSTED`, `503 METER_UNAVAILABLE`); everything after the
 * reservation streams as SSE events. Node runtime, 120 s.
 */
import type { NextRequest } from 'next/server';

import { readJsonObject } from '@/lib/server/teaching-package/route-helpers';
import { TeachingPackageError } from '@/lib/server/teaching-package/errors';
import { sendMessage } from '@/lib/server/tutor/conversation-service';
import { withStudentGrant } from '@/lib/server/tutor/guards';
import { resolveTutorRuntimeDeps } from '@/lib/server/tutor/runtime-deps';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;

type Params = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, { params }: Params) {
  return withStudentGrant(
    req,
    async (request, { grant }) => {
      const { id } = await params;
      const body = await readJsonObject(request);
      if (!body) throw new TeachingPackageError('INVALID_REQUEST', 'request body must be a JSON object');
      const deps = await resolveTutorRuntimeDeps();
      return sendMessage(deps, {
        grant,
        conversationId: id,
        clientMessageId: body.clientMessageId,
        text: body.text,
        localeHint: body.localeHint,
        requestSignal: request.signal,
      });
    },
    { rateLimit: true },
  );
}
