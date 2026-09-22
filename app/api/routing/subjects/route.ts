/**
 * GET /api/routing/subjects — the routed subject set (contracts §3.3).
 *
 * Kafuo Backend mirrors the policy in `master_subjects.routing_key` and reads
 * this endpoint to warn when its copy drifts from OpenMAIC's (plan §7.5). It
 * reports the CODE-OWNED table, not what currently resolves: a subject whose
 * provider key is missing is still "routed" — its calls refuse with
 * `SUBJECT_ROUTE_UNAVAILABLE`, they are never re-homed on a generic model.
 *
 * Server-to-server only: 404 when the Teaching Package API is not configured,
 * service-key authenticated otherwise.
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { isTeachingPackageApiConfigured } from '@/lib/config/feature-flags';
import {
  POLICY_VERSION,
  SUBJECT_CODES,
  SUBJECT_MODEL_POLICY,
} from '@/lib/server/teaching-model/subject-policy';
import { teachingPackageErrorResponse } from '@/lib/server/teaching-package/route-helpers';
import { authenticateServiceRequest } from '@/lib/server/teaching-package/service-auth';

export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  if (!isTeachingPackageApiConfigured()) return new Response('Not found', { status: 404 });
  try {
    authenticateServiceRequest(req);
    return NextResponse.json({
      policyVersion: POLICY_VERSION,
      subjects: SUBJECT_CODES.map((code) => ({
        code,
        primary: SUBJECT_MODEL_POLICY[code].primary.model,
        fallback: SUBJECT_MODEL_POLICY[code].fallback.model,
      })),
    });
  } catch (error) {
    const mapped = teachingPackageErrorResponse(error);
    if (mapped) return mapped;
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: 'failed to read the subject routing table' } },
      { status: 500 },
    );
  }
}
