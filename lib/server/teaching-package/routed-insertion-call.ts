/**
 * The model route of a reviewer-generated slide insertion (reviewer-generated-
 * slide-for-lesson-part-plan §14.2). Same structure and rules as
 * `createRegenerationRoute` (which is not modified, D-18):
 *
 * - `enforced` routing (the default): the subject recorded on the version's
 *   producing attempt picks the Primary → Fallback pair. No recorded subject —
 *   or a Stage subject that disagrees with it — refuses with
 *   `SUBJECT_ROUTE_UNAVAILABLE`; `DEFAULT_MODEL` is never a substitute. EVERY
 *   provider attempt (planner and re-ask, content, native-visual correction,
 *   assistance authoring and re-author, leak regeneration, every register
 *   re-roll, and each provider fallback inside `execute`) is a ledger row with
 *   `capability = 'scene_insertion'`, attributed to the producing attempt AND
 *   to this insertion (`scene_insertion_id`).
 * - `off`: the server's stage routes, no ledger rows.
 *
 * The generators swallow call errors into `null` / fallback Actions, so a
 * failed route is remembered and re-raised by `assertAvailable`.
 */
import { buildVisionUserContent, type AICallFn } from '@openmaic/generation';
import type { Queryable } from '@openmaic/storage/document/pg';

import { createGenerationAiCallFactory } from '@/lib/server/agent-runtime/generation-ai-call';
import type { LlmStage } from '@/lib/server/model-routes';
import {
  AccountingUnavailableError,
  executeTeachingCall,
  TeachingModelUnavailableError,
} from '@/lib/server/teaching-model/execute';
import { resolveSubjectModelPolicy } from '@/lib/server/teaching-model/resolve-policy';
import { readRoutingMode } from '@/lib/server/teaching-model/subject-policy';
import { TeachingPackageError } from '@/lib/server/teaching-package/errors';

export interface InsertionRoute {
  /** The provider-bound call for one ledger stage label. */
  aiCallFor(stage: string): AICallFn;
  /** Re-raise a route failure the generators swallowed. */
  assertAvailable(): void;
  /** Diagnostic description stored on the insertion row. */
  description: Record<string, unknown>;
}

export interface InsertionRouteInput {
  tenantId: string;
  versionId: string;
  insertionId: string;
  /** The producing generation attempt (ledger association). */
  generationAttemptId: string | null;
  learningItem: { type: string; id: string } | null;
  snapshotSubjectCode: string | undefined;
  stageSubjectCode: string | undefined;
  queryable?: Queryable;
  /** Test seams. */
  mode?: 'enforced' | 'off';
  execute?: typeof executeTeachingCall;
}

/** The planner's ledger stage label (labels do not select models, F28b). */
export const INSERTION_PLANNER_STAGE = 'scene-outlines-stream';

export async function createInsertionRoute(input: InsertionRouteInput): Promise<InsertionRoute> {
  const mode = input.mode ?? readRoutingMode();
  if (mode === 'off') {
    const routed = createGenerationAiCallFactory();
    return {
      aiCallFor: (stage) => routed(stage as LlmStage),
      assertAvailable: () => {},
      description: { mode: 'off' },
    };
  }
  const subject = input.snapshotSubjectCode?.trim();
  if (!subject || !input.generationAttemptId) {
    throw new TeachingPackageError(
      'SUBJECT_ROUTE_UNAVAILABLE',
      'this package records no routed subject (it was generated before subject routing); a slide cannot be generated for it',
      { versionId: input.versionId },
    );
  }
  if (
    input.stageSubjectCode !== undefined &&
    input.stageSubjectCode.trim().toUpperCase() !== subject.toUpperCase()
  ) {
    throw new TeachingPackageError(
      'SUBJECT_ROUTE_UNAVAILABLE',
      'the stage subject disagrees with the subject the package was generated under',
      { versionId: input.versionId },
    );
  }
  const policy = await resolveSubjectModelPolicy(subject);
  const execute = input.execute ?? executeTeachingCall;
  let failure: TeachingPackageError | null = null;
  const generationAttemptId = input.generationAttemptId;

  const aiCallFor =
    (stage: string): AICallFn =>
    async (systemPrompt, userPrompt, images) => {
      const withImages = images !== undefined && images.length > 0;
      try {
        const result = await execute(
          policy,
          {
            tenantId: input.tenantId,
            capability: 'scene_insertion',
            stage,
            origin: 'openmaic_runtime',
            association: {
              kind: 'generation',
              generationAttemptId,
              generationRun: null,
              versionId: input.versionId,
              learningItemType: input.learningItem?.type ?? null,
              learningItemId: input.learningItem?.id ?? null,
              sceneInsertionId: input.insertionId,
            },
          },
          {
            messages: [
              { role: 'system', content: systemPrompt },
              {
                role: 'user',
                content: withImages
                  ? (buildVisionUserContent(userPrompt, images) as never)
                  : userPrompt,
              },
            ],
          },
          {
            ...(withImages ? { images } : {}),
            ...(input.queryable ? { queryable: input.queryable } : {}),
          },
        );
        return result.text;
      } catch (error) {
        if (error instanceof TeachingModelUnavailableError) {
          failure ??= new TeachingPackageError('TEACHING_MODEL_UNAVAILABLE', error.message, {
            subjectCode: policy.subjectCode,
            attemptIds: error.attemptIds,
            retryable: error.retryable,
          });
          // The route was already spent: no per-call retry.
          Object.assign(error, { isRetryable: false });
        } else if (error instanceof AccountingUnavailableError) {
          failure ??= new TeachingPackageError('ACCOUNTING_UNAVAILABLE', error.message);
          Object.assign(error, { isRetryable: false });
        }
        throw error;
      }
    };

  return {
    aiCallFor,
    assertAvailable: () => {
      if (failure) throw failure;
    },
    description: {
      mode: 'enforced',
      subjectCode: policy.subjectCode,
      policyVersion: policy.policyVersion,
      primary: policy.primary.modelString,
      fallback: policy.fallback.modelString,
    },
  };
}
