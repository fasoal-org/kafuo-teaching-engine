/**
 * POST /api/teaching-packages/[id]/quiz-grades — grade one learner quiz
 * submission against the stored quiz scene of EXACTLY this version.
 *
 * Service-to-service only (Kafuo Backend). Kafuo authorizes the student, their
 * own teaching session and its PINNED version, then forwards only identifiers
 * and answers. TE grades against its own stored scene — answer keys never
 * leave this process unless `reveal` (Kafuo's product policy) asks for them.
 * Stateless and idempotent: the same submission always yields the same result.
 *
 * Body: `{ tenantContext: { tenantId }, sceneId, answers: { [questionId]: string[] },
 *   reveal?: boolean }`
 * `200 LearnerQuizGrade` · `404 NOT_FOUND | QUIZ_SCENE_NOT_FOUND` ·
 * `409 TEACHING_PACKAGE_NOT_APPROVED` · `422 INVALID_REQUEST |
 * QUIZ_QUESTION_NOT_IN_SCENE | STAGE_NOT_LIVE`.
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { isTeachingPackageApiConfigured } from '@/lib/config/feature-flags';
import { getServerPersistenceProvider } from '@/lib/persistence/server-provider';
import { TeachingPackageError } from '@/lib/server/teaching-package/errors';
import {
  gradeLearnerQuiz,
  parseLearnerAnswers,
} from '@/lib/server/teaching-package/learner-quiz';
import {
  parseTenantContext,
  readJsonObject,
  teachingPackageErrorResponse,
} from '@/lib/server/teaching-package/route-helpers';
import { authenticateServiceRequest } from '@/lib/server/teaching-package/service-auth';
import { describeErrorSafely } from '@/lib/server/teaching-package/safe-error';

export const runtime = 'nodejs';

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!isTeachingPackageApiConfigured()) return new Response('Not found', { status: 404 });
  try {
    authenticateServiceRequest(req);
    const { id } = await params;
    const body = await readJsonObject(req);
    if (!body) throw new TeachingPackageError('INVALID_REQUEST', 'request body must be a JSON object');
    const tenantId = parseTenantContext(body);
    if (typeof body.sceneId !== 'string' || body.sceneId.trim() === '') {
      throw new TeachingPackageError('INVALID_REQUEST', 'sceneId must be a non-empty string');
    }
    const { pool } = await getServerPersistenceProvider(process.env.DATABASE_URL ?? '');
    const result = await gradeLearnerQuiz(pool, {
      versionId: id,
      tenantId,
      sceneId: body.sceneId,
      answers: parseLearnerAnswers(body.answers),
      reveal: body.reveal === true,
    });
    return NextResponse.json(result, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    const mapped = teachingPackageErrorResponse(error);
    if (mapped) return mapped;
    // Never log the body: it carries the learner's answers.
    console.error('TeachingPackages internal error', JSON.stringify(describeErrorSafely(error)));
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: 'failed to grade the quiz' } },
      { status: 500 },
    );
  }
}
