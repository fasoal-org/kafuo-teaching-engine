/**
 * The model call of a plan review run on a PAUSED attempt (P3,
 * package-plan-review-p3-contract-2026-11-22): an attempt that paused before the
 * plan review existed is reviewed once, in the background, outside any generation
 * run. It runs on the package's planning route as frozen on its producing attempt
 * (`resolveFrozenPlanRoute`: the frozen `planRoute`, else the frozen generation
 * route, else today's table), metered like the run's own outline calls (capability
 * `package_generation`, stage `scene-outlines-stream`, the paused run's number).
 *
 * With `TEACHING_SUBJECT_ROUTING=off` the stage route is used, as in every other
 * unrouted outline call. A call whose route is spent throws; the review ends on it
 * and records nothing (the review never rethrows a failed call).
 */
import type { AICallFn } from '@openmaic/generation';

import { createGenerationAiCallFactory } from '@/lib/server/agent-runtime/generation-ai-call';
import { executeTeachingCall } from '@/lib/server/teaching-model/execute';
import { resolveFrozenPlanRoute } from '@/lib/server/teaching-model/frozen-generation-route';
import { readRoutingMode } from '@/lib/server/teaching-model/subject-policy';
import { routedCallOptions } from '@/lib/server/classroom-generation';
import type { GenerationAttempt } from '@/lib/types/teaching-package';

const OUTLINE_STAGE = 'scene-outlines-stream';

export async function createPlanReviewAiCall(input: {
  attempt: GenerationAttempt;
  /** The paused run (its ledger rows keep that run's number). */
  generationRun: number;
  execute?: typeof executeTeachingCall;
}): Promise<AICallFn> {
  if (readRoutingMode() === 'off') {
    const routed = createGenerationAiCallFactory();
    return routed(OUTLINE_STAGE);
  }
  const snapshot = input.attempt.inputSnapshot;
  const subjectCode = (snapshot.subjectCode as string | undefined) ?? '';
  const { policy } = await resolveFrozenPlanRoute({
    subjectCode,
    frozenPlanRoute: snapshot.planRoute,
    frozenGenerationRoute: snapshot.generationRoute,
    step: `plan review of paused attempt ${input.attempt.id}`,
  });
  const execute = input.execute ?? executeTeachingCall;
  return async (systemPrompt, userPrompt) => {
    const result = await execute(
      policy,
      {
        tenantId: input.attempt.tenantId,
        capability: 'package_generation',
        stage: OUTLINE_STAGE,
        origin: 'openmaic_runtime',
        association: {
          kind: 'generation',
          generationAttemptId: input.attempt.id,
          generationRun: input.generationRun,
          versionId: null,
          learningItemType: input.attempt.learningItem.type,
          learningItemId: input.attempt.learningItem.id,
        },
      },
      {
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
      },
      routedCallOptions(OUTLINE_STAGE, undefined),
    );
    return result.text;
  };
}
