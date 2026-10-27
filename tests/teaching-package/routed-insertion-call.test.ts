import { describe, expect, it, vi } from 'vitest';

import { TeachingModelUnavailableError } from '@/lib/server/teaching-model/execute';
import {
  createInsertionRoute,
  INSERTION_PLANNER_STAGE,
} from '@/lib/server/teaching-package/routed-insertion-call';

vi.mock('@/lib/server/teaching-model/resolve-policy', () => ({
  resolveSubjectModelPolicy: async (code: string) => ({
    subjectCode: code,
    policyVersion: 'r1-test',
    primary: { modelString: 'qwen:primary' },
    fallback: { modelString: 'openai:fallback' },
  }),
}));

/**
 * Reviewer-generated slide plan §14.2 (R9): every provider call of an
 * insertion — whichever generator callback makes it — is routed by the
 * producing attempt's subject and attributed to `scene_insertion`, the
 * producing attempt AND the insertion row. The provider fallback runs inside
 * `execute` with this same context (its ledger row carries it, covered by
 * `tests/usage/reporting-queries.test.ts`).
 */
const base = {
  tenantId: 't1',
  versionId: 'tpv-1',
  insertionId: 'tpsi-1',
  generationAttemptId: 'tpa-1',
  learningItem: { type: 'lesson', id: 'li-1' },
  snapshotSubjectCode: 'MATH',
  stageSubjectCode: 'MATH',
  mode: 'enforced' as const,
};

describe('createInsertionRoute', () => {
  it('attributes EVERY callback stage to scene_insertion + the producing attempt + the insertion', async () => {
    const execute = vi.fn(async () => ({ text: 'ok' }));
    const route = await createInsertionRoute({ ...base, execute: execute as never });
    // planner + re-ask, content (initial, native-visual correction, leak
    // regeneration), assistance (authoring + re-author), actions + re-rolls.
    const stages = [
      INSERTION_PLANNER_STAGE,
      INSERTION_PLANNER_STAGE,
      'scene-content:slide',
      'scene-content:slide',
      'scene-content:slide',
      'slide-assistance',
      'slide-assistance',
      'scene-actions',
      'scene-actions',
      'scene-actions',
    ];
    for (const stage of stages) {
      await expect(route.aiCallFor(stage)('system', 'user')).resolves.toBe('ok');
    }
    expect(execute).toHaveBeenCalledTimes(stages.length);
    for (const [index, call] of execute.mock.calls.entries()) {
      const context = (call as unknown as [unknown, Record<string, unknown>])[1];
      expect(context).toMatchObject({
        tenantId: 't1',
        capability: 'scene_insertion',
        stage: stages[index],
        origin: 'openmaic_runtime',
        association: {
          kind: 'generation',
          generationAttemptId: 'tpa-1',
          versionId: 'tpv-1',
          sceneInsertionId: 'tpsi-1',
          learningItemType: 'lesson',
          learningItemId: 'li-1',
        },
      });
      expect((context.association as Record<string, unknown>).sceneRegenerationId).toBeUndefined();
    }
  });

  it('refuses without a recorded subject, or when the Stage subject disagrees', async () => {
    await expect(
      createInsertionRoute({ ...base, snapshotSubjectCode: undefined }),
    ).rejects.toMatchObject({ code: 'SUBJECT_ROUTE_UNAVAILABLE' });
    await expect(
      createInsertionRoute({ ...base, generationAttemptId: null }),
    ).rejects.toMatchObject({ code: 'SUBJECT_ROUTE_UNAVAILABLE' });
    await expect(
      createInsertionRoute({ ...base, stageSubjectCode: 'PHYSICS' }),
    ).rejects.toMatchObject({ code: 'SUBJECT_ROUTE_UNAVAILABLE' });
  });

  it('remembers a spent route and re-raises it as TEACHING_MODEL_UNAVAILABLE', async () => {
    const execute = vi.fn(async () => {
      throw new TeachingModelUnavailableError('both failed', {
        attemptIds: ['a', 'b'],
        outcomes: [],
        retryable: true,
      } as never);
    });
    const route = await createInsertionRoute({ ...base, execute: execute as never });
    await expect(route.aiCallFor('scene-actions')('s', 'u')).rejects.toBeInstanceOf(
      TeachingModelUnavailableError,
    );
    expect(() => route.assertAvailable()).toThrow(
      expect.objectContaining({ code: 'TEACHING_MODEL_UNAVAILABLE' }),
    );
  });
});
