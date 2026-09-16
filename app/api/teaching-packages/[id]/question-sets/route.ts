/**
 * POST /api/teaching-packages/[id]/question-sets — generate one Teaching
 * Question role set for one Learning Objective from an APPROVED Teaching
 * Package version (Kafuo question-flow closure, B1).
 *
 * Service-to-service only (Kafuo Backend). Kafuo sends identity and the
 * generation-policy inputs it owns; it never resends Stage, Scenes, the
 * package document or the lesson PDF. TE resolves its own retained context.
 * Stateless: no question persistence and no webhook — Kafuo's Question Bank is
 * the authority for the generated questions; the caller's `requestId` (its
 * generation-run dedup key) is echoed for traceability.
 *
 * Body: `{ tenantContext, learningItem:{type,id}, requestId,
 *   objective:{objectiveRef}, flowStages:[{key, scope:item|outcome}],
 *   policy:{ envelopeVersion, language, targetRole?, findings?, siblingMeasurements? } }`
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { isTeachingPackageApiConfigured } from '@/lib/config/feature-flags';
import { getServerPersistenceProvider } from '@/lib/persistence/server-provider';
import { TeachingPackageError } from '@/lib/server/teaching-package/errors';
import {
  generateTeachingQuestionSet,
  isTeachingRole,
  type FlowStageScope,
} from '@/lib/server/teaching-package/question-generation';
import { QUESTION_ENVELOPE_VERSION } from '@/lib/server/teaching-package/question-generation-prompt';
import {
  parseTenantContext,
  readJsonObject,
  teachingPackageErrorResponse,
} from '@/lib/server/teaching-package/route-helpers';
import { authenticateServiceRequest } from '@/lib/server/teaching-package/service-auth';
import { describeErrorSafely } from '@/lib/server/teaching-package/safe-error';

export const runtime = 'nodejs';
// One role-set model call (with one validation retry) per request.
export const maxDuration = 300;

function invalid(message: string): never {
  throw new TeachingPackageError('INVALID_REQUEST', message);
}

function flowStages(value: unknown): FlowStageScope[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 50) {
    invalid('flowStages must be a non-empty array of { key, scope }');
  }
  return (value as unknown[]).map((entry) => {
    const stage = entry as Record<string, unknown> | null;
    if (
      !stage ||
      typeof stage.key !== 'string' ||
      stage.key.trim() === '' ||
      (stage.scope !== 'item' && stage.scope !== 'outcome')
    ) {
      invalid('flowStages entries must be { key: string, scope: item|outcome }');
    }
    return { key: stage!.key as string, scope: stage!.scope as 'item' | 'outcome' };
  });
}

function stringList(value: unknown, field: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    invalid(`${field} must be an array of strings`);
  }
  return (value as string[]).slice(0, 20).map((entry) => entry.slice(0, 500));
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
    if (policy.envelopeVersion !== QUESTION_ENVELOPE_VERSION) {
      invalid(`policy.envelopeVersion must be ${QUESTION_ENVELOPE_VERSION}`);
    }
    if (typeof policy.language !== 'string' || !policy.language) {
      invalid('policy.language must be a non-empty string');
    }
    if (policy.targetRole !== undefined && policy.targetRole !== null && !isTeachingRole(policy.targetRole)) {
      invalid('policy.targetRole must be a known teaching role');
    }

    const { pool } = await getServerPersistenceProvider(process.env.DATABASE_URL ?? '');
    const result = await generateTeachingQuestionSet(pool, {
      versionId: id,
      tenantId,
      learningItem: { type: learningItem!.type as 'lesson' | 'section', id: learningItem!.id as string },
      requestId: requestId as string,
      objectiveRef: objective!.objectiveRef as string,
      flowStages: flowStages(body.flowStages),
      language: policy.language as string,
      targetRole: isTeachingRole(policy.targetRole) ? policy.targetRole : null,
      findings: stringList(policy.findings, 'policy.findings'),
      siblingMeasurements: stringList(policy.siblingMeasurements, 'policy.siblingMeasurements'),
    });
    return NextResponse.json(result);
  } catch (error) {
    const mapped = teachingPackageErrorResponse(error);
    if (mapped) return mapped;
    console.error(
      'TeachingPackages question generation internal error',
      JSON.stringify(describeErrorSafely(error)),
    );
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: 'failed to generate teaching questions' } },
      { status: 500 },
    );
  }
}
