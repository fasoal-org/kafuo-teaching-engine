/**
 * POST /api/teaching-packages/generate — start an initial or regeneration
 * attempt (§11). `generation` is exactly `GenerateClassroomInput`: parsed with
 * the same field list `app/api/generate-classroom/route.ts` accepts and handed
 * field-for-field to `generateClassroom` IN MEMORY. Never persisted: the
 * attempt row stores only the lightweight `GenerationInputSnapshot` derived
 * from the request. `versionId` supplied ⇒ regeneration. Answers `202
 * { attempt }`; the runner is scheduled with `after()`.
 */
import { after, type NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { isTeachingPackageApiConfigured } from '@/lib/config/feature-flags';
import { getServerPersistenceProvider } from '@/lib/persistence/server-provider';
import type { GenerateClassroomInput } from '@/lib/server/classroom-generation';
import {
  startGenerationAttempt,
  type StartGenerationAttemptRequest,
} from '@/lib/server/teaching-package/generation';
import {
  buildKafuoStartRequest,
  parseKafuoGenerationRequest,
} from '@/lib/server/teaching-package/kafuo-request';
import { runGenerationAttempt } from '@/lib/server/teaching-package/generation-runner';
import {
  readJsonObject,
  teachingPackageErrorResponse,
} from '@/lib/server/teaching-package/route-helpers';
import { authenticateServiceRequest } from '@/lib/server/teaching-package/service-auth';
import { describeErrorSafely } from '@/lib/server/teaching-package/safe-error';
import { TeachingPackageError } from '@/lib/server/teaching-package/errors';
import { LEGACY_TENANT_ID, type GenerationExecutionInput } from '@/lib/types/teaching-package';

export const runtime = 'nodejs';
export const maxDuration = 30;

/** The same field list /api/generate-classroom accepts — nothing whitelisted away. */
function parseGenerationInput(raw: Record<string, unknown>): GenerationExecutionInput {
  const body = raw as Partial<GenerateClassroomInput>;
  const generation: GenerateClassroomInput = {
    requirement: body.requirement || '',
    ...(body.pdfContent ? { pdfContent: body.pdfContent } : {}),
    ...(body.enableWebSearch != null ? { enableWebSearch: body.enableWebSearch } : {}),
    ...(body.webSearchProviderId ? { webSearchProviderId: body.webSearchProviderId } : {}),
    ...(body.webSearchApiKey ? { webSearchApiKey: body.webSearchApiKey } : {}),
    ...(body.webSearchModelId ? { webSearchModelId: body.webSearchModelId } : {}),
    ...(body.baiduSubSources ? { baiduSubSources: body.baiduSubSources } : {}),
    ...(body.enableImageGeneration != null
      ? { enableImageGeneration: body.enableImageGeneration }
      : {}),
    ...(body.enableVideoGeneration != null
      ? { enableVideoGeneration: body.enableVideoGeneration }
      : {}),
    ...(body.enableTTS != null ? { enableTTS: body.enableTTS } : {}),
    ...(body.agentMode ? { agentMode: body.agentMode } : {}),
  };
  return generation;
}

export async function POST(req: NextRequest) {
  if (!isTeachingPackageApiConfigured()) return new Response('Not found', { status: 404 });
  try {
    authenticateServiceRequest(req);
    const body = await readJsonObject(req);
    if (!body) {
      throw new TeachingPackageError('INVALID_REQUEST', 'request body must be a JSON object');
    }
    const learningItem = body.learningItem as Record<string, unknown> | undefined;
    const teachingModel = body.teachingModel as Record<string, unknown> | undefined;
    if (!learningItem || typeof learningItem !== 'object') {
      throw new TeachingPackageError('INVALID_REQUEST', 'learningItem must be an object');
    }
    if (!teachingModel || typeof teachingModel !== 'object') {
      throw new TeachingPackageError('INVALID_REQUEST', 'teachingModel must be an object');
    }
    if (typeof body.actorRef !== 'string') {
      throw new TeachingPackageError('ACTOR_REQUIRED', 'actorRef must be a string');
    }
    if (!body.generation || typeof body.generation !== 'object') {
      throw new TeachingPackageError('INVALID_REQUEST', 'generation must be an object');
    }

    // Tenant resolution (plan §4.1.3): a Kafuo-shaped body (carrying
    // `contentResource`) MUST carry `tenantContext.tenantId`; the legacy body
    // shape maps explicitly to the `__legacy__` namespace. There is no env
    // toggle and no tenant-less path.
    const isKafuoShaped =
      body.contentResource !== undefined && typeof body.contentResource === 'object';

    if (isKafuoShaped) {
      // The structured Kafuo path (FRD §9.2): parse/validate fully, compute
      // the semantic digest, snapshot the secret-free lineage, and hand the
      // runner the Kafuo context — whose `contentResource.url` lives in
      // memory only from here on.
      const { request, aggregate } = parseKafuoGenerationRequest(body);
      const { start, kafuo } = buildKafuoStartRequest(request, aggregate);
      const { pool } = await getServerPersistenceProvider(process.env.DATABASE_URL ?? '');
      const { attempt, execution, created } = await startGenerationAttempt(pool, start);
      // Only a newly inserted attempt is executed. An idempotency replay
      // returns the existing attempt untouched — scheduling the runner for one
      // would restart a terminal attempt (the ATTEMPT_RECLAIMED_STALE loop).
      if (created) after(() => runGenerationAttempt(attempt.id, execution, kafuo));
      return NextResponse.json({ attempt }, { status: 202 });
    }

    const tenantId = LEGACY_TENANT_ID;

    const request: StartGenerationAttemptRequest = {
      tenantId,
      // Types are `unknown` here on purpose: startGenerationAttempt validates
      // every field and answers with the exact error codes.
      learningItem: {
        type: learningItem.type,
        id: learningItem.id,
      } as StartGenerationAttemptRequest['learningItem'],
      teachingModel: {
        key: teachingModel.key,
        version: teachingModel.version,
      } as StartGenerationAttemptRequest['teachingModel'],
      ...(Array.isArray(body.learningObjectives)
        ? { learningObjectives: body.learningObjectives }
        : {}),
      ...(Array.isArray(body.contentUnitRefs) ? { contentUnitRefs: body.contentUnitRefs } : {}),
      ...(Array.isArray(body.sourceRefs) ? { sourceRefs: body.sourceRefs } : {}),
      ...(body.generationContext && typeof body.generationContext === 'object'
        ? { generationContext: body.generationContext as Record<string, unknown> }
        : {}),
      generation: parseGenerationInput(body.generation as Record<string, unknown>),
      ...(typeof body.versionId === 'string' ? { versionId: body.versionId } : {}),
      actorRef: body.actorRef,
      ...(typeof body.requestId === 'string' ? { requestId: body.requestId } : {}),
    };

    const { pool } = await getServerPersistenceProvider(process.env.DATABASE_URL ?? '');
    const { attempt, execution, created } = await startGenerationAttempt(pool, request);

    // Same rule on the legacy path: replays are returned, never re-executed.
    if (created) after(() => runGenerationAttempt(attempt.id, execution));

    // The 202 body echoes the attempt (snapshot) — never the execution input.
    return NextResponse.json({ attempt }, { status: 202 });
  } catch (error) {
    const mapped = teachingPackageErrorResponse(error);
    if (mapped) return mapped;
    console.error('TeachingPackages internal error', JSON.stringify(describeErrorSafely(error)));
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: 'failed to start generation' } },
      { status: 500 },
    );
  }
}
