import { beforeEach, describe, expect, it, vi } from 'vitest';

import { TeachingModelUnavailableError } from '@/lib/server/teaching-model/execute';
import { TeachingPackageError } from '@/lib/server/teaching-package/errors';
import {
  createInsertionRoute,
  INSERTION_PLANNER_STAGE,
} from '@/lib/server/teaching-package/routed-insertion-call';
import type { GenerationModelRoute } from '@/lib/types/teaching-package';

const policyMocks = vi.hoisted(() => ({ configured: vi.fn() }));

vi.mock('@/lib/server/teaching-model/resolve-policy', () => ({
  resolveSubjectModelPolicy: async (code: string) => ({
    subjectCode: code,
    policyVersion: 'r1-test',
    primary: { modelString: 'qwen:primary' },
    fallback: { modelString: 'openai:fallback' },
  }),
  resolveConfiguredGenerationPolicy: (code: string, route: GenerationModelRoute) =>
    policyMocks.configured(code, route),
}));

/** A route frozen on the producing attempt (teaching-generation-model plan D-10). */
const FROZEN: GenerationModelRoute = {
  primary: { model: 'anthropic:claude-sonnet-5-5', thinking: 'high' },
  fallback: { model: 'qwen:qwen4-max', thinking: 'on' },
  settingKey: 'teaching_generation.route.MATH',
};

beforeEach(() => {
  policyMocks.configured.mockReset();
  policyMocks.configured.mockImplementation(async (code: string, route: GenerationModelRoute) => ({
    subjectCode: code,
    policyVersion: 'configured-test',
    primary: { modelString: route.primary.model },
    fallback: { modelString: route.fallback.model },
  }));
});

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

  describe('the package’s frozen generation route (teaching-generation-model plan D-6, D-7)', () => {
    it('runs on the frozen route when the producing attempt recorded one', async () => {
      const execute = vi.fn(async () => ({ text: 'ok' }));
      const route = await createInsertionRoute({
        ...base,
        snapshotGenerationRoute: FROZEN,
        execute: execute as never,
      });
      await route.aiCallFor(INSERTION_PLANNER_STAGE)('s', 'u');
      expect(policyMocks.configured).toHaveBeenCalledWith('MATH', FROZEN);
      const [policy] = execute.mock.calls[0] as unknown as [{ policyVersion: string }];
      expect(policy.policyVersion).toBe('configured-test');
      expect(route.description).toEqual({
        mode: 'enforced',
        subjectCode: 'MATH',
        policyVersion: 'configured-test',
        primary: 'anthropic:claude-sonnet-5-5',
        fallback: 'qwen:qwen4-max',
      });
    });

    it('D-7: a frozen route that can no longer resolve runs on today’s table, and the switch is recorded', async () => {
      policyMocks.configured.mockRejectedValue(
        new TeachingPackageError(
          'SUBJECT_ROUTE_UNAVAILABLE',
          'subject MATH: fallback model qwen:qwen4-max cannot be resolved (no API key)',
        ),
      );
      const route = await createInsertionRoute({ ...base, snapshotGenerationRoute: FROZEN });
      expect(route.description).toEqual({
        mode: 'enforced',
        subjectCode: 'MATH',
        policyVersion: 'r1-test',
        primary: 'qwen:primary',
        fallback: 'openai:fallback',
        routeReplaced: {
          from: FROZEN,
          reason: 'subject MATH: fallback model qwen:qwen4-max cannot be resolved (no API key)',
        },
      });
    });

    it('no frozen route: today’s table, nothing recorded', async () => {
      const route = await createInsertionRoute(base);
      expect(route.description).not.toHaveProperty('routeReplaced');
      expect(route.description).toMatchObject({ policyVersion: 'r1-test' });
      expect(policyMocks.configured).not.toHaveBeenCalled();
    });
  });
});
