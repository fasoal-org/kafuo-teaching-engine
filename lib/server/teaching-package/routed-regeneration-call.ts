/**
 * The model route of a reviewer-driven slide regeneration
 * (single-slide-regeneration-plan §8).
 *
 * - `enforced` routing (the default): the subject recorded on the version's
 *   producing attempt picks the Primary → Fallback pair, exactly as question
 *   generation does. No recorded subject — or a Stage subject that disagrees
 *   with it — refuses with `SUBJECT_ROUTE_UNAVAILABLE`; `DEFAULT_MODEL` is
 *   never a substitute. Every provider attempt is a ledger row with
 *   `capability = 'scene_regeneration'`, attributed to the producing attempt
 *   AND to this regeneration (`scene_regeneration_id`), so it is reported on
 *   its own and never folds into the attempt's generation cost.
 * - `off`: the server's stage routes, no ledger rows (the runner's off-mode
 *   behaviour).
 *
 * The generators swallow call errors into `null` / fallback Actions, so a
 * route that failed (`TEACHING_MODEL_UNAVAILABLE` / `ACCOUNTING_UNAVAILABLE`)
 * is remembered here and re-raised by {@link RegenerationRoute.assertAvailable}
 * at the service's checkpoints — the classroom pipeline's own pattern.
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

export interface RegenerationRoute {
  /** The provider-bound call for one ledger stage (`scene-content:slide`, `scene-actions`). */
  aiCallFor(stage: string): AICallFn;
  /** Re-raise a route failure the generators swallowed. */
  assertAvailable(): void;
  /** Diagnostic description stored on the regeneration row. */
  description: Record<string, unknown>;
}

export interface RegenerationRouteInput {
  tenantId: string;
  versionId: string;
  regenerationId: string;
  /** The producing generation attempt (ledger association). */
  generationAttemptId: string | null;
  learningItem: { type: string; id: string } | null;
  /** The producing attempt's snapshot subject. */
  snapshotSubjectCode: string | undefined;
  /** The Stage's recorded subject, when it records one. */
  stageSubjectCode: string | undefined;
  queryable?: Queryable;
  /** Test seams. */
  mode?: 'enforced' | 'off';
  execute?: typeof executeTeachingCall;
}

export async function createRegenerationRoute(
  input: RegenerationRouteInput,
): Promise<RegenerationRoute> {
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
      'this package records no routed subject (it was generated before subject routing); slide regeneration cannot choose a model for it',
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
            capability: 'scene_regeneration',
            stage,
            origin: 'openmaic_runtime',
            association: {
              kind: 'generation',
              generationAttemptId,
              generationRun: null,
              versionId: input.versionId,
              learningItemType: input.learningItem?.type ?? null,
              learningItemId: input.learningItem?.id ?? null,
              sceneRegenerationId: input.regenerationId,
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
