/**
 * POST /api/tutor/answers/ownership — is this Free Chat message a rateable
 * Kafuo answer of this tenant + student? (D-05 plan §3.2 B, contracts §3.5.)
 *
 * Server-to-server, called by Kafuo before it stores a 👍/👎: the service-key
 * bearer AND the Kafuo request signature (`kafuo-request-signature.ts`); 404
 * when the Teaching Package API is not configured. The body is read ONCE as
 * text and verified before it is parsed.
 *
 *   { "purpose": "free_chat_answer_ownership", "tenantContext": { "tenantId": "1" },
 *     "studentRef": "…", "messageId": "msg-…" }
 *
 * Answers `200 {"rateable": true}`, `200 {"rateable": false, "reason":
 * "not_completed" | "safety_boundary"}`, or one non-enumerating
 * `404 ANSWER_NOT_FOUND`. A read only: no Kafuo meter, model or grounding
 * call, no student grant (so no turn bucket), no refusal cache, and nothing
 * of the body (text, ref or id) is logged.
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { isTeachingPackageApiConfigured } from '@/lib/config/feature-flags';
import { TeachingPackageError } from '@/lib/server/teaching-package/errors';
import {
  parseTenantContext,
  teachingPackageErrorResponse,
} from '@/lib/server/teaching-package/route-helpers';
import { describeErrorSafely } from '@/lib/server/teaching-package/safe-error';
import { authenticateServiceRequest } from '@/lib/server/teaching-package/service-auth';
import { checkAnswerOwnership } from '@/lib/server/tutor/conversation-service';
import { verifyKafuoSignedRequest } from '@/lib/server/tutor/kafuo-request-signature';
import { resolveTutorRuntimeDeps } from '@/lib/server/tutor/runtime-deps';
import { parseStudentRef } from '@/lib/server/tutor/student-context';

export const runtime = 'nodejs';

/** `msg-<uuid>` today (`turn-runner.ts`); 64 chars at most, Kafuo's `answer_source_id`. */
const MESSAGE_ID_PATTERN = /^msg-[A-Za-z0-9_-]{1,60}$/;

function parseMessageId(value: unknown): string {
  if (typeof value !== 'string' || !MESSAGE_ID_PATTERN.test(value)) {
    throw new TeachingPackageError('INVALID_REQUEST', 'messageId must be a msg-<id> message id');
  }
  return value;
}

export async function POST(req: NextRequest) {
  if (!isTeachingPackageApiConfigured()) return new Response('Not found', { status: 404 });
  try {
    authenticateServiceRequest(req);
    const rawBody = await req.text();
    const body = verifyKafuoSignedRequest(req.headers, rawBody);
    const tenantId = parseTenantContext(body);
    const studentRef = parseStudentRef(body.studentRef);
    const messageId = parseMessageId(body.messageId);

    const { pool } = await resolveTutorRuntimeDeps();
    const ownership = await checkAnswerOwnership({ pool }, { tenantId, studentRef, messageId });
    return NextResponse.json(ownership, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    const mapped = teachingPackageErrorResponse(error);
    if (mapped) return mapped;
    console.error(
      'Tutor answer ownership internal error',
      JSON.stringify(describeErrorSafely(error)),
    );
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: 'failed to check answer ownership' } },
      { status: 500 },
    );
  }
}
