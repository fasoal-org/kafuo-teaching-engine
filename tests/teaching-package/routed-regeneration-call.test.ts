import { describe, expect, it, vi } from 'vitest';

import { createRegenerationRoute } from '@/lib/server/teaching-package/routed-regeneration-call';
import { TeachingModelUnavailableError } from '@/lib/server/teaching-model/execute';

vi.mock('@/lib/server/teaching-model/resolve-policy', () => ({
  resolveSubjectModelPolicy: async (code: string) => ({
    subjectCode: code,
    policyVersion: 'r1-test',
    primary: { modelString: 'qwen:primary' },
    fallback: { modelString: 'openai:fallback' },
  }),
}));

/**
 * §8 (single-slide-regeneration-plan): the regeneration's provider calls are
 * routed by the producing attempt's subject and attributed to BOTH the
 * producing attempt and the regeneration, under their own capability.
 */
const base = {
  tenantId: 't1',
  versionId: 'tpv-1',
  regenerationId: 'tsr-1',
  generationAttemptId: 'tpa-1',
  learningItem: { type: 'lesson', id: 'li-1' },
  snapshotSubjectCode: 'MATH',
  stageSubjectCode: 'MATH',
  mode: 'enforced' as const,
};

describe('createRegenerationRoute', () => {
  it('attributes every call to scene_regeneration, the producing attempt and the regeneration', async () => {
    const execute = vi.fn(async () => ({ text: 'ok' }));
    const route = await createRegenerationRoute({ ...base, execute: execute as never });
    await expect(route.aiCallFor('scene-content:slide')('system', 'user')).resolves.toBe('ok');
    const [policy, context, params] = execute.mock.calls[0] as unknown as [
      { subjectCode: string },
      Record<string, unknown>,
      { messages: Array<{ role: string; content: string }> },
    ];
    expect(policy.subjectCode).toBe('MATH');
    expect(context).toMatchObject({
      tenantId: 't1',
      capability: 'scene_regeneration',
      stage: 'scene-content:slide',
      origin: 'openmaic_runtime',
      association: {
        kind: 'generation',
        generationAttemptId: 'tpa-1',
        versionId: 'tpv-1',
        sceneRegenerationId: 'tsr-1',
        learningItemType: 'lesson',
        learningItemId: 'li-1',
      },
    });
    expect(params.messages).toEqual([
      { role: 'system', content: 'system' },
      { role: 'user', content: 'user' },
    ]);
    expect(route.description).toMatchObject({ mode: 'enforced', subjectCode: 'MATH' });
  });

  it('refuses without a recorded subject, or when the Stage subject disagrees', async () => {
    await expect(
      createRegenerationRoute({ ...base, snapshotSubjectCode: undefined }),
    ).rejects.toMatchObject({ code: 'SUBJECT_ROUTE_UNAVAILABLE' });
    await expect(
      createRegenerationRoute({ ...base, generationAttemptId: null }),
    ).rejects.toMatchObject({ code: 'SUBJECT_ROUTE_UNAVAILABLE' });
    await expect(
      createRegenerationRoute({ ...base, stageSubjectCode: 'PHYSICS' }),
    ).rejects.toMatchObject({ code: 'SUBJECT_ROUTE_UNAVAILABLE' });
  });

  it('remembers a spent route and re-raises it as TEACHING_MODEL_UNAVAILABLE', async () => {
    const execute = vi.fn(async () => {
      throw new TeachingModelUnavailableError('both failed', {
        attemptIds: ['a', 'b'],
        outcomes: [],
        retryable: true,
      });
    });
    const route = await createRegenerationRoute({ ...base, execute: execute as never });
    await expect(route.aiCallFor('scene-actions')('s', 'u')).rejects.toThrow('both failed');
    expect(() => route.assertAvailable()).toThrow(
      expect.objectContaining({ code: 'TEACHING_MODEL_UNAVAILABLE' }),
    );
  });

  it('routing off uses the stage routes and records no subject', async () => {
    const route = await createRegenerationRoute({
      ...base,
      mode: 'off',
      snapshotSubjectCode: undefined,
    });
    expect(route.description).toEqual({ mode: 'off' });
    expect(() => route.assertAvailable()).not.toThrow();
  });
});
