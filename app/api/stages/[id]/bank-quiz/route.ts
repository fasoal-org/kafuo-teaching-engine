/**
 * W6 one question source — a bank quiz Scene's questions and grading, for the
 * grant of the path's Stage (status doc "W6 contract" items 3–4).
 *
 * - `GET  ?sceneId=…` → `{ status, questions }` (`ready` | `pending_approval` |
 *   `not_bank`); the questions are the learner-safe projection, never a key.
 * - `POST { sceneId, answers }` → Kafuo's grade (`results`, `earned`, `possible`).
 *
 * Every grant purpose may read (edit / preview / learner): the scope — tenant,
 * version, learning item and, for a learner, `studentRef` — comes from the
 * verified grant and the server's rows, never the body. A learner grant is
 * re-validated with Kafuo first. Never writes TE state.
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { readVersionById } from '@/lib/persistence/teaching-package';
import {
  gradeBankQuiz,
  parseBankQuizAnswers,
  parseBankQuizSceneId,
  readBankQuizQuestions,
  type BankQuizDeps,
} from '@/lib/server/teaching-package/bank-quiz-service';
import {
  regenerationErrorResponse,
  resolveRegenerationGrant,
  type ResolvedRegenerationGrant,
} from '@/lib/server/teaching-package/regeneration-grant';
import { readLiveScene } from '@/lib/server/teaching-package/scene-regeneration-store';
import { TeachingPackageError } from '@/lib/server/teaching-package/errors';
import { getKafuoIntegrationClient } from '@/lib/server/tutor/kafuo-integration-client';
import {
  evaluateLearnerGrantAccess,
  learnerDeliveryError,
} from '@/lib/server/tutor/learner-access';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type Params = { params: Promise<{ id: string }> };

const NO_STORE = { 'Cache-Control': 'private, no-store' };

function depsFor({ pool }: ResolvedRegenerationGrant): BankQuizDeps {
  return {
    learningItemIdOf: async (tenantId, versionId) => {
      const version = await readVersionById(pool, versionId);
      return version && version.tenantId === tenantId ? version.learningItem.id : null;
    },
    readScene: async (stageId, sceneId) =>
      (await readLiveScene(pool, stageId, sceneId))?.scene ?? null,
    checkLearnerAccess: async (grant) =>
      learnerDeliveryError(await evaluateLearnerGrantAccess(grant, { pool })),
    client: getKafuoIntegrationClient(),
  };
}

export async function GET(req: NextRequest, { params }: Params) {
  try {
    const { id: stageId } = await params;
    const resolved = await resolveRegenerationGrant(req.headers, stageId, { requireWrite: false });
    if (!resolved.ok) return resolved.response;
    const sceneId = parseBankQuizSceneId(req.nextUrl.searchParams.get('sceneId'));
    const body = await readBankQuizQuestions(
      resolved.value.grant,
      sceneId,
      depsFor(resolved.value),
    );
    return NextResponse.json(body, { headers: NO_STORE });
  } catch (error) {
    return regenerationErrorResponse(error, 'bank quiz questions');
  }
}

export async function POST(req: NextRequest, { params }: Params) {
  try {
    const { id: stageId } = await params;
    const resolved = await resolveRegenerationGrant(req.headers, stageId, { requireWrite: false });
    if (!resolved.ok) return resolved.response;
    let payload: unknown;
    try {
      payload = await req.json();
    } catch {
      throw new TeachingPackageError('INVALID_REQUEST', 'the body must be JSON');
    }
    const record = (typeof payload === 'object' && payload !== null ? payload : {}) as Record<
      string,
      unknown
    >;
    const sceneId = parseBankQuizSceneId(record.sceneId);
    const answers = parseBankQuizAnswers(record.answers);
    const body = await gradeBankQuiz(
      resolved.value.grant,
      sceneId,
      answers,
      depsFor(resolved.value),
    );
    return NextResponse.json(body, { headers: NO_STORE });
  } catch (error) {
    return regenerationErrorResponse(error, 'bank quiz grading');
  }
}
