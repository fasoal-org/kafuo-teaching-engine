/**
 * POST /api/teaching-packages/[id]/question-reviews — ask the AI reviewer to
 * check a saved question set (ai-reviewer-layer plan §4.7, contract §4.3).
 *
 * Service-to-service only (Kafuo Backend), signed like `question-sets`.
 * Answers `202` at once with the queued review; the in-process sweep runs it
 * and `teaching_question_set.review_completed` reports the verdicts. A replay
 * of the same `requestId` answers the same review and never pays twice. The
 * question-set request itself is unchanged and stays synchronous.
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { isTeachingPackageApiConfigured } from '@/lib/config/feature-flags';
import { getServerPersistenceProvider } from '@/lib/persistence/server-provider';
import { TeachingPackageError } from '@/lib/server/teaching-package/errors';
import { parseReviewedQuestions } from '@/lib/server/teaching-package/question-review';
import {
  newQuestionReviewId,
  queueQuestionReview,
} from '@/lib/server/teaching-package/question-review-store';
import { getTeachingPackageVersion } from '@/lib/server/teaching-package/resolve';
import {
  parseTenantContext,
  readJsonObject,
  teachingPackageErrorResponse,
} from '@/lib/server/teaching-package/route-helpers';
import { authenticateServiceRequest } from '@/lib/server/teaching-package/service-auth';
import { describeErrorSafely } from '@/lib/server/teaching-package/safe-error';

export const runtime = 'nodejs';

function invalid(message: string): never {
  throw new TeachingPackageError('INVALID_REQUEST', message);
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!isTeachingPackageApiConfigured()) return new Response('Not found', { status: 404 });
  try {
    authenticateServiceRequest(req);
    const { id } = await params;
    const body = await readJsonObject(req);
    if (!body) invalid('request body must be a JSON object');
    const tenantId = parseTenantContext(body);
    const learningItem = body.learningItem as Record<string, unknown> | undefined;
    if (
      !learningItem ||
      (learningItem.type !== 'lesson' && learningItem.type !== 'section') ||
      typeof learningItem.id !== 'string' ||
      learningItem.id.trim() === ''
    ) {
      invalid('learningItem must be { type: lesson|section, id: string }');
    }
    const requestId = body.requestId;
    if (typeof requestId !== 'string' || requestId.trim() === '' || requestId.length > 512) {
      invalid('requestId must be a non-empty string');
    }
    if (typeof body.language !== 'string' || !body.language.trim()) {
      invalid('language must be a non-empty string');
    }
    const objective = body.objective as Record<string, unknown> | undefined;
    if (!objective || typeof objective.objectiveRef !== 'string' || !objective.objectiveRef) {
      invalid('objective.objectiveRef must be a non-empty string');
    }
    let questions: ReturnType<typeof parseReviewedQuestions>;
    try {
      questions = parseReviewedQuestions(body.questions);
    } catch (error) {
      invalid(error instanceof Error ? error.message : 'questions are invalid');
    }

    const version = await getTeachingPackageVersion(id, { tenantId });
    if (
      version.learningItem.type !== learningItem!.type ||
      version.learningItem.id !== learningItem!.id
    ) {
      throw new TeachingPackageError('NOT_FOUND', `teaching package ${id} not found`);
    }
    const { pool } = await getServerPersistenceProvider(process.env.DATABASE_URL ?? '');
    const { review } = await queueQuestionReview(pool as never, {
      id: newQuestionReviewId(),
      tenantId,
      learningItem: version.learningItem,
      versionId: version.id,
      requestId: requestId as string,
      language: (body.language as string).slice(0, 20),
      objectiveRef: (objective!.objectiveRef as string).slice(0, 512),
      objectiveText:
        typeof objective!.text === 'string' && objective!.text.trim()
          ? objective!.text.slice(0, 4_000)
          : null,
      questions: questions!,
      now: Date.now(),
    });
    return NextResponse.json(
      { questionReview: { id: review.id, status: review.status } },
      { status: 202 },
    );
  } catch (error) {
    const mapped = teachingPackageErrorResponse(error);
    if (mapped) return mapped;
    console.error(
      'TeachingPackages question review internal error',
      JSON.stringify(describeErrorSafely(error)),
    );
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: 'failed to queue the question review' } },
      { status: 500 },
    );
  }
}
