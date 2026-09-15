/**
 * Route helpers for the Teaching Package API (plan §11).
 *
 * Package routes use the folders-route response envelope:
 * errors are `{ error: { code, message, details? } }`. This module maps the
 * teaching package error vocabulary (and the PostgreSQL 23505 backstop, the
 * same shape as `lib/server/folder-name-errors.ts`) onto that envelope.
 */
import { NextResponse } from 'next/server';

import {
  isPgUniqueViolation,
  isTeachingPackageStageLockedError,
  TeachingPackageError,
} from '@/lib/server/teaching-package/errors';
import type { LearningItemRef } from '@/lib/types/teaching-package';

/**
 * Map a teaching package failure onto the API's error envelope. Returns `null`
 * when the error is not a teaching package refusal (caller falls through to
 * its generic 500 path), mirroring `folderNameErrorResponse`.
 */
export function teachingPackageErrorResponse(error: unknown): NextResponse | null {
  if (error instanceof TeachingPackageError) {
    return NextResponse.json(
      {
        error: {
          code: error.code,
          message: error.message,
          ...(error.details === undefined ? {} : { details: error.details }),
        },
      },
      { status: error.status },
    );
  }
  if (isTeachingPackageStageLockedError(error)) {
    return NextResponse.json(
      { error: { code: 'STAGE_LOCKED', message: error.message } },
      { status: 423 },
    );
  }
  if (isPgUniqueViolation(error)) {
    // Backstop behind the partial unique indexes; the services map the
    // index-specific conflicts (approval, active successor, in-flight
    // generation) to their own codes before the request ever reaches here.
    return NextResponse.json(
      { error: { code: 'CONFLICT', message: 'the request conflicts with existing state' } },
      { status: 409 },
    );
  }
  return null;
}

/**
 * Read a JSON object body. Returns `null` when the body is absent, not JSON,
 * or not an object — every package route treats bodies as JSON objects and
 * validates before any service call.
 */
export async function readJsonObject(req: Request): Promise<Record<string, unknown> | null> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return null;
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  return body as Record<string, unknown>;
}

/** Parse and validate the `(learningItemType, learningItemId)` query pair. */
export function parseLearningItemRef(type: unknown, id: unknown): LearningItemRef {
  if (type !== 'lesson' && type !== 'section') {
    throw new TeachingPackageError(
      'UNSUPPORTED_LEARNING_ITEM_TYPE',
      'learningItemType must be "lesson" or "section"',
    );
  }
  if (typeof id !== 'string' || id.trim() === '') {
    throw new TeachingPackageError('INVALID_REQUEST', 'learningItemId must be a non-empty string');
  }
  return { type, id };
}
