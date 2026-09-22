/**
 * Route-level enforcement of the generation contracts shared by every
 * client-driven generation path (`/api/generate/scene-content`,
 * `/api/generate/scene-actions`):
 *
 * - a client-supplied slide outline must be validly classified — the same
 *   strict rule the outline generator applies to its own output;
 * - a runtime scene that cannot be delivered is a typed conflict, never a
 *   silently converted slide.
 */
import type { NextResponse } from 'next/server';
import {
  OutlineSceneConfigError,
  SceneCapConflictError,
  SceneRuntimeUnavailableError,
  formatOutlineSemanticsIssues,
  validateOutlineSlideSemantics,
} from '@openmaic/generation';
import { apiError, type ApiErrorBody } from '@/lib/server/api-response';
import type { SceneOutline } from '@/lib/types/generation';

/**
 * 400 `OUTLINE_SLIDE_SEMANTICS_INVALID` when a client-supplied slide outline
 * is not validly classified; `null` when it may proceed. Non-slide outlines are
 * not judged. Nothing is defaulted or repaired on the client's behalf.
 */
export function rejectInvalidSlideOutline(
  outline: SceneOutline,
): NextResponse<ApiErrorBody> | null {
  const issues = validateOutlineSlideSemantics([outline]);
  if (issues.length === 0) return null;
  return apiError(
    'OUTLINE_SLIDE_SEMANTICS_INVALID',
    400,
    'The slide outline is not validly classified',
    formatOutlineSemanticsIssues(issues),
  );
}

/** The typed planning-conflict response for `error`, or `null` if it is not one. */
export function sceneConflictResponse(error: unknown): NextResponse<ApiErrorBody> | null {
  if (
    error instanceof OutlineSceneConfigError ||
    error instanceof SceneRuntimeUnavailableError ||
    error instanceof SceneCapConflictError
  ) {
    return apiError(error.code, 409, error.message);
  }
  return null;
}
