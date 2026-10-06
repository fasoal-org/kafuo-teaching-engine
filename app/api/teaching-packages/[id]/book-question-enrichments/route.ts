/**
 * POST /api/teaching-packages/[id]/book-question-enrichments — add the teaching
 * metadata an approved Book Question's source did not print, from an APPROVED
 * Teaching Package version (Kafuo plan D1).
 *
 * Service-to-service only (Kafuo Backend). Kafuo sends identity, its policy
 * inputs and the book's question read-only; TE resolves its own retained
 * package context and routed model. Stateless: Kafuo validates and persists.
 *
 * Body: `{ tenantContext, learningItem:{type,id}, requestId,
 *   objective:{objectiveRef}, policy:{ envelopeVersion, language, findings?,
 *   siblingMeasurements? }, bookQuestion:{ questionId, questionText,
 *   choices:[{choiceId,text}], correctChoiceId, bookExplanation } }`
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { isTeachingPackageApiConfigured } from '@/lib/config/feature-flags';
import { getServerPersistenceProvider } from '@/lib/persistence/server-provider';
import { TeachingPackageError } from '@/lib/server/teaching-package/errors';
import {
  enrichBookQuestion,
  type BookQuestionForEnrichment,
} from '@/lib/server/teaching-package/book-question-enrichment';
import { BOOK_ENRICHMENT_ENVELOPE_VERSION } from '@/lib/server/teaching-package/book-question-enrichment-prompt';
import {
  parseTenantContext,
  readJsonObject,
  teachingPackageErrorResponse,
} from '@/lib/server/teaching-package/route-helpers';
import { authenticateServiceRequest } from '@/lib/server/teaching-package/service-auth';
import { describeErrorSafely } from '@/lib/server/teaching-package/safe-error';

export const runtime = 'nodejs';
export const maxDuration = 300;

function invalid(message: string): never {
  throw new TeachingPackageError('INVALID_REQUEST', message);
}

function stringList(value: unknown, field: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    invalid(`${field} must be an array of strings`);
  }
  return (value as string[]).slice(0, 20).map((entry) => entry.slice(0, 500));
}

function parseBookQuestion(value: unknown): BookQuestionForEnrichment {
  const question = value as Record<string, unknown> | null;
  const choices = question?.choices;
  if (
    !question ||
    typeof question.questionId !== 'string' ||
    !question.questionId ||
    typeof question.questionText !== 'string' ||
    !question.questionText.trim() ||
    question.questionText.length > 4_000 ||
    !Array.isArray(choices) ||
    choices.length < 2 ||
    choices.length > 5 ||
    choices.some(
      (choice) =>
        !choice ||
        typeof choice !== 'object' ||
        typeof (choice as Record<string, unknown>).choiceId !== 'string' ||
        typeof (choice as Record<string, unknown>).text !== 'string',
    ) ||
    typeof question.correctChoiceId !== 'string' ||
    !(choices as Array<Record<string, unknown>>).some(
      (choice) => choice.choiceId === question.correctChoiceId,
    )
  ) {
    invalid('bookQuestion must carry 2-5 choices and a correctChoiceId among them');
  }
  const explanation = question!.bookExplanation;
  if (explanation !== undefined && explanation !== null && typeof explanation !== 'string') {
    invalid('bookQuestion.bookExplanation must be a string or null');
  }
  return {
    questionId: question!.questionId as string,
    questionText: question!.questionText as string,
    choices: (choices as Array<Record<string, unknown>>).map((choice) => ({
      choiceId: String(choice.choiceId),
      text: String(choice.text).slice(0, 1_000),
    })),
    correctChoiceId: question!.correctChoiceId as string,
    bookExplanation: typeof explanation === 'string' ? explanation.slice(0, 4_000) : null,
  };
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
    const objective = body.objective as Record<string, unknown> | undefined;
    if (!objective || typeof objective.objectiveRef !== 'string' || !objective.objectiveRef) {
      invalid('objective.objectiveRef must be a non-empty string');
    }
    const policy = (body.policy ?? {}) as Record<string, unknown>;
    if (policy.envelopeVersion !== BOOK_ENRICHMENT_ENVELOPE_VERSION) {
      invalid(`policy.envelopeVersion must be ${BOOK_ENRICHMENT_ENVELOPE_VERSION}`);
    }
    if (typeof policy.language !== 'string' || !policy.language) {
      invalid('policy.language must be a non-empty string');
    }

    const { pool } = await getServerPersistenceProvider(process.env.DATABASE_URL ?? '');
    const result = await enrichBookQuestion(pool, {
      versionId: id,
      tenantId,
      learningItem: {
        type: learningItem!.type as 'lesson' | 'section',
        id: learningItem!.id as string,
      },
      requestId: requestId as string,
      objectiveRef: objective!.objectiveRef as string,
      language: policy.language as string,
      findings: stringList(policy.findings, 'policy.findings'),
      siblingMeasurements: stringList(policy.siblingMeasurements, 'policy.siblingMeasurements'),
      bookQuestion: parseBookQuestion(body.bookQuestion),
    });
    return NextResponse.json(result);
  } catch (error) {
    const mapped = teachingPackageErrorResponse(error);
    if (mapped) return mapped;
    console.error(
      'TeachingPackages book question enrichment internal error',
      JSON.stringify(describeErrorSafely(error)),
    );
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: 'failed to enrich the book question' } },
      { status: 500 },
    );
  }
}
