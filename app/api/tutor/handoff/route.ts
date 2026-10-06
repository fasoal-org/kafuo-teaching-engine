/**
 * POST /api/tutor/handoff — mint a Free Chat student handoff (Kafuo R1
 * contracts §3.1; plan §6.3, P5). Server-to-server: service key, 404 when the
 * Teaching Package API is not configured.
 *
 * Kafuo has already authorised the student (JWT + profile scope, §4.1) and
 * sends the routed subject set it believes the student may open; OpenMAIC
 * does not re-derive scope, it signs what it was told. Codes outside the
 * policy table are NOT refused here — they are dropped at redeem and the
 * redeem response reports the intersection (§3.1), so a Backend whose copy of
 * the routing table drifted still gets a working handoff for the rest.
 *
 * `expiresAt` is epoch SECONDS on this wire (contracts §3.1 example); the
 * editor handoff route predates that convention and keeps its milliseconds.
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { isTeachingPackageApiConfigured } from '@/lib/config/feature-flags';
import { TeachingPackageError } from '@/lib/server/teaching-package/errors';
import {
  parseTenantContext,
  readJsonObject,
  teachingPackageErrorResponse,
} from '@/lib/server/teaching-package/route-helpers';
import { describeErrorSafely } from '@/lib/server/teaching-package/safe-error';
import { authenticateServiceRequest } from '@/lib/server/teaching-package/service-auth';
import {
  parseAcademic,
  parseLocaleHint,
  parseStudentEntitlements,
  parseStudentRef,
  parseStudentSubject,
} from '@/lib/server/tutor/student-context';
import { mintStudentHandoff } from '@/lib/server/tutor/student-grant';

export const runtime = 'nodejs';

const MAX_ALLOWED_SUBJECTS = 64;

function parsePurposes(value: unknown): void {
  if (!Array.isArray(value) || value.length === 0 || !value.every((p) => typeof p === 'string')) {
    throw new TeachingPackageError('INVALID_REQUEST', 'purposes must be a non-empty string array');
  }
  // R1 mints one purpose. Anything else is a contract drift, not a silent no-op.
  const unknown = value.filter((p) => p !== 'free_chat');
  if (unknown.length > 0) {
    throw new TeachingPackageError(
      'INVALID_REQUEST',
      `unsupported handoff purpose(s): ${unknown.join(', ')}`,
    );
  }
}

export async function POST(req: NextRequest) {
  if (!isTeachingPackageApiConfigured()) return new Response('Not found', { status: 404 });
  try {
    authenticateServiceRequest(req);
    const body = await readJsonObject(req);
    if (!body) {
      throw new TeachingPackageError('INVALID_REQUEST', 'request body must be a JSON object');
    }
    if (typeof body.actorRef !== 'string') {
      throw new TeachingPackageError('ACTOR_REQUIRED', 'actorRef must be a string');
    }
    const tenantId = parseTenantContext(body);
    const studentRef = parseStudentRef(body.studentRef);
    parsePurposes(body.purposes);
    const academic = parseAcademic(body.academic, { requireCurriculumId: true });
    if (!Array.isArray(body.allowedSubjects) || body.allowedSubjects.length > MAX_ALLOWED_SUBJECTS) {
      throw new TeachingPackageError(
        'INVALID_REQUEST',
        `allowedSubjects must be an array of at most ${MAX_ALLOWED_SUBJECTS} subjects`,
      );
    }
    const allowedSubjects = body.allowedSubjects.map((entry, index) =>
      parseStudentSubject(entry, `allowedSubjects[${index}]`),
    );
    const localeHint = parseLocaleHint(body.localeHint);
    const entitlements = parseStudentEntitlements(body.entitlements);

    const { token, expiresAt } = mintStudentHandoff({
      tenantId,
      studentRef,
      academic,
      allowedSubjects,
      ...(localeHint ? { localeHint } : {}),
      entitlements,
    });
    return NextResponse.json(
      { token, expiresAt: Math.floor(expiresAt / 1000) },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (error) {
    const mapped = teachingPackageErrorResponse(error);
    if (mapped) return mapped;
    console.error('Tutor handoff internal error', JSON.stringify(describeErrorSafely(error)));
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: 'failed to mint student handoff' } },
      { status: 500 },
    );
  }
}
