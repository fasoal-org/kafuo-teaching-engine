/**
 * POST /api/teaching-packages/[id]/transitions — one route, one service switch
 * for every lifecycle transition (submit | start_edit | reject | approve |
 * discard). Body: `{ action, actorRef, expectedStatus?, reason?, comment? }`.
 * The response is the updated version row; transition logic lives entirely in
 * `lib/server/teaching-package/lifecycle.ts`.
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { isTeachingPackageApiConfigured } from '@/lib/config/feature-flags';
import { getServerPersistenceProvider } from '@/lib/persistence/server-provider';
import { TeachingPackageError } from '@/lib/server/teaching-package/errors';
import {
  approve,
  discardSuccessor,
  reject,
  startReviewEdit,
  submitForReview,
} from '@/lib/server/teaching-package/lifecycle';
import {
  parseTenantContext,
  readJsonObject,
  teachingPackageErrorResponse,
} from '@/lib/server/teaching-package/route-helpers';
import { authenticateServiceRequest } from '@/lib/server/teaching-package/service-auth';
import { describeErrorSafely } from '@/lib/server/teaching-package/safe-error';
import type { TeachingPackageStatus } from '@/lib/types/teaching-package';

export const runtime = 'nodejs';

const ACTIONS = ['submit', 'start_edit', 'reject', 'approve', 'discard'] as const;
type TransitionAction = (typeof ACTIONS)[number];

const STATUSES: TeachingPackageStatus[] = [
  'draft',
  'in_review',
  'rejected',
  'approved',
  'superseded',
  'discarded',
];

function isStatus(value: unknown): value is TeachingPackageStatus {
  return typeof value === 'string' && (STATUSES as string[]).includes(value);
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!isTeachingPackageApiConfigured()) return new Response('Not found', { status: 404 });
  try {
    authenticateServiceRequest(req);
    const { id } = await params;
    const body = await readJsonObject(req);
    if (!body) {
      throw new TeachingPackageError('INVALID_REQUEST', 'request body must be a JSON object');
    }
    const action = body.action;
    if (typeof action !== 'string' || !(ACTIONS as readonly string[]).includes(action)) {
      throw new TeachingPackageError(
        'INVALID_REQUEST',
        `action must be one of ${ACTIONS.join(' | ')}`,
      );
    }
    const actorRef = body.actorRef;
    if (typeof actorRef !== 'string') {
      throw new TeachingPackageError('ACTOR_REQUIRED', 'actorRef must be a string');
    }
    if (body.expectedStatus !== undefined && !isStatus(body.expectedStatus)) {
      throw new TeachingPackageError('INVALID_REQUEST', 'expectedStatus must be a known status');
    }
    const expectedStatus = body.expectedStatus as TeachingPackageStatus | undefined;
    const comment = typeof body.comment === 'string' ? body.comment : undefined;
    const context = {
      versionId: id,
      tenantId: parseTenantContext(body),
      actorRef,
      ...(expectedStatus === undefined ? {} : { expectedStatus }),
      ...(comment === undefined ? {} : { comment }),
    };

    const { pool } = await getServerPersistenceProvider(process.env.DATABASE_URL ?? '');
    const version = await (async () => {
      switch (action as TransitionAction) {
        case 'submit':
          return submitForReview(pool, context);
        case 'start_edit':
          return startReviewEdit(pool, context);
        case 'reject': {
          const reason = body.reason;
          if (typeof reason !== 'string') {
            throw new TeachingPackageError(
              'REASON_REQUIRED',
              'a rejection requires a non-empty reason (1..4000 characters)',
            );
          }
          return reject(pool, { ...context, reason });
        }
        case 'approve':
          return approve(pool, context);
        case 'discard':
          return discardSuccessor(pool, context);
      }
    })();
    return NextResponse.json({ version });
  } catch (error) {
    const mapped = teachingPackageErrorResponse(error);
    if (mapped) return mapped;
    console.error('TeachingPackages internal error', JSON.stringify(describeErrorSafely(error)));
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: 'failed to run transition' } },
      { status: 500 },
    );
  }
}
