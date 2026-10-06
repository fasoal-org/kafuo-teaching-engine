/**
 * POST /api/teaching-packages/[id]/editor-handoff — mint a handoff token for
 * one package version (§11). `edit` requires draft|rejected; `preview` works
 * for any status; `learner` (Kafuo question-flow closure B2) is read-only
 * playback for a learner session and requires approved|superseded. The token is bound to `{ versionId, stageId, capability }`,
 * lives ≤ 5 minutes, and is redeemed by the browser at
 * `/api/teaching-packages/editor-handoff?token=…`.
 *
 * Kafuo R1 learner extension (contracts §3.2): for `mode: "learner"` the body
 * may add `studentRef`, `academic`, `subject`, `localeHint`, `entitlements`.
 * When the complete set is present it is embedded in the handoff as `student`
 * and carried onto the grant at redeem — that block is what Help acts on.
 * Wholly absent → the handoff is minted without it (Help then refuses with
 * `HELP_GROUNDING_UNAVAILABLE`); partially present → `INVALID_REQUEST`, so a
 * Backend that meant to send the context learns immediately.
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { isTeachingPackageApiConfigured } from '@/lib/config/feature-flags';
import { getTeachingPackageVersion } from '@/lib/server/teaching-package/resolve';
import {
  LEARNER_HANDOFF_STATUSES,
  mintEditorHandoffToken,
} from '@/lib/server/teaching-package/editor-grant';
import {
  parseTenantContext,
  readJsonObject,
  teachingPackageErrorResponse,
} from '@/lib/server/teaching-package/route-helpers';
import { authenticateServiceRequest } from '@/lib/server/teaching-package/service-auth';
import { describeErrorSafely } from '@/lib/server/teaching-package/safe-error';
import { TeachingPackageError } from '@/lib/server/teaching-package/errors';
import {
  parseAcademic,
  parseHelpEntitlements,
  parseLearnerSubject,
  parseLocaleHint,
  parseStudentRef,
  type LearnerStudentContext,
} from '@/lib/server/tutor/student-context';

const LEARNER_STUDENT_FIELDS = ['studentRef', 'academic', 'subject', 'entitlements'] as const;

/**
 * The learner student block from the mint body: `undefined` when none of its
 * fields were sent, the parsed block when all required ones were, and an
 * `INVALID_REQUEST` naming the missing ones in between.
 */
function parseLearnerStudent(body: Record<string, unknown>): LearnerStudentContext | undefined {
  const present = LEARNER_STUDENT_FIELDS.filter((field) => body[field] !== undefined);
  if (present.length === 0 && body.localeHint === undefined) return undefined;
  const missing = LEARNER_STUDENT_FIELDS.filter((field) => body[field] === undefined);
  if (missing.length > 0) {
    throw new TeachingPackageError(
      'INVALID_REQUEST',
      `learner student context is incomplete: missing ${missing.join(', ')}`,
      { missing },
    );
  }
  const localeHint = parseLocaleHint(body.localeHint);
  return {
    studentRef: parseStudentRef(body.studentRef),
    academic: parseAcademic(body.academic, { requireCurriculumId: false }),
    subject: parseLearnerSubject(body.subject),
    ...(localeHint ? { localeHint } : {}),
    entitlements: parseHelpEntitlements(body.entitlements),
  };
}

export const runtime = 'nodejs';

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!isTeachingPackageApiConfigured()) return new Response('Not found', { status: 404 });
  try {
    authenticateServiceRequest(req);
    const { id } = await params;
    const body = await readJsonObject(req);
    if (!body) {
      throw new TeachingPackageError('INVALID_REQUEST', 'request body must be a JSON object');
    }
    if (typeof body.actorRef !== 'string') {
      throw new TeachingPackageError('ACTOR_REQUIRED', 'actorRef must be a string');
    }
    const mode = body.mode;
    if (mode !== 'edit' && mode !== 'preview' && mode !== 'learner') {
      throw new TeachingPackageError(
        'INVALID_REQUEST',
        'mode must be "edit", "preview" or "learner"',
      );
    }
    const learnerRef = body.learnerRef;
    if (
      learnerRef !== undefined &&
      (typeof learnerRef !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(learnerRef))
    ) {
      throw new TeachingPackageError(
        'INVALID_REQUEST',
        'learnerRef must be an opaque 16..128 character url-safe token',
      );
    }

    // Parsed before any lookup so a malformed learner context is refused
    // without touching the database; only learner mode may carry it.
    const student = mode === 'learner' ? parseLearnerStudent(body) : undefined;

    const tenantId = parseTenantContext(body);
    const version = await getTeachingPackageVersion(id, { tenantId });
    if (version.tenantId !== tenantId) {
      throw new TeachingPackageError('NOT_FOUND', `teaching package ${id} not found`);
    }
    if (mode === 'edit' && version.status !== 'draft' && version.status !== 'rejected') {
      throw new TeachingPackageError(
        'INVALID_TRANSITION',
        `an editor handoff for edit requires a draft or rejected version, not ${version.status}`,
      );
    }
    if (
      mode === 'learner' &&
      !(LEARNER_HANDOFF_STATUSES as readonly string[]).includes(version.status)
    ) {
      // A learner only ever opens the approved version or pinned history — never a
      // draft, review copy or discarded successor.
      throw new TeachingPackageError(
        'INVALID_TRANSITION',
        `a learner handoff requires an approved or superseded version, not ${version.status}`,
      );
    }
    const capability = mode === 'edit' ? 'write' : 'read';
    const { token, expiresAt } = mintEditorHandoffToken({
      tenantId: version.tenantId,
      versionId: version.id,
      stageId: version.currentStageId,
      capability,
      purpose: mode,
      ...(mode === 'learner' && typeof learnerRef === 'string' ? { learnerRef } : {}),
      ...(student ? { student } : {}),
    });
    return NextResponse.json({
      url: `/api/teaching-packages/editor-handoff?token=${encodeURIComponent(token)}`,
      expiresAt,
      stageId: version.currentStageId,
      capability,
    });
  } catch (error) {
    const mapped = teachingPackageErrorResponse(error);
    if (mapped) return mapped;
    console.error('TeachingPackages internal error', JSON.stringify(describeErrorSafely(error)));
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: 'failed to mint editor handoff' } },
      { status: 500 },
    );
  }
}
