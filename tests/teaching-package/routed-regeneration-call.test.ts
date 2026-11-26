import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createRegenerationRoute } from '@/lib/server/teaching-package/routed-regeneration-call';
import {
  TeachingCallAbortedError,
  TeachingModelUnavailableError,
} from '@/lib/server/teaching-model/execute';
import { TeachingPackageError } from '@/lib/server/teaching-package/errors';
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
  primary: { model: 'openai:gpt-6.1-terra', thinking: 'medium' },
  fallback: { model: 'qwen:qwen3.7-flash', thinking: 'off' },
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
    // No Scene named: the association carries none.
    expect((context.association as Record<string, unknown>).sceneId).toBeUndefined();
  });

  it('S8-O1: names the regenerated Scene on every call', async () => {
    const execute = vi.fn(async () => ({ text: 'ok' }));
    const route = await createRegenerationRoute({
      ...base,
      sceneId: 'scene_target',
      execute: execute as never,
    });
    await route.aiCallFor('scene-actions')('system', 'user');
    const context = (execute.mock.calls[0] as unknown as [unknown, { association: object }])[1];
    expect(context.association).toMatchObject({
      sceneRegenerationId: 'tsr-1',
      sceneId: 'scene_target',
    });
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

  it('LOW-1: a reviewer run signal reaches every call; an aborted call is remembered as ABORTED (no signal: as before)', async () => {
    const controller = new AbortController();
    const execute = vi.fn(async () => {
      controller.abort(); // the executor throws this only once the caller aborted
      throw new TeachingCallAbortedError(['a']);
    });
    const route = await createRegenerationRoute({
      ...base,
      execute: execute as never,
      signal: controller.signal,
    });
    await expect(route.aiCallFor('scene-content:slide')('s', 'u')).rejects.toThrow('aborted');
    const [, , , options] = execute.mock.calls[0] as unknown as [
      unknown,
      unknown,
      unknown,
      { signal?: AbortSignal },
    ];
    expect(options.signal).toBe(controller.signal);
    expect(() => route.assertAvailable()).toThrow(expect.objectContaining({ code: 'ABORTED' }));
    // The editor's regeneration passes no signal.
    const plainExecute = vi.fn(async () => ({ text: 'ok' }));
    const plain = await createRegenerationRoute({ ...base, execute: plainExecute as never });
    await plain.aiCallFor('scene-actions')('s', 'u');
    const [, , , plainOptions] = plainExecute.mock.calls[0] as unknown as [
      unknown,
      unknown,
      unknown,
      Record<string, unknown>,
    ];
    expect(plainOptions).not.toHaveProperty('signal');
  });

  it('nit: a signal that was not aborted keeps the old mapping for an abort error too', async () => {
    const execute = vi.fn(async () => {
      throw new TeachingCallAbortedError(['a']);
    });
    const route = await createRegenerationRoute({
      ...base,
      execute: execute as never,
      signal: new AbortController().signal,
    });
    await expect(route.aiCallFor('scene-content:slide')('s', 'u')).rejects.toThrow('aborted');
    expect(() => route.assertAvailable()).not.toThrow();
  });

  it('LOW-2: without a caller signal an abort error keeps the old mapping (not remembered, not ABORTED)', async () => {
    const execute = vi.fn(async () => {
      throw new TeachingCallAbortedError(['a']);
    });
    const route = await createRegenerationRoute({ ...base, execute: execute as never });
    const thrown = await route
      .aiCallFor('scene-content:slide')('s', 'u')
      .catch((error: unknown) => error);
    expect(thrown).toBeInstanceOf(TeachingCallAbortedError);
    expect(thrown).not.toHaveProperty('isRetryable');
    expect(() => route.assertAvailable()).not.toThrow();
  });

  describe('the package’s frozen generation route (teaching-generation-model plan D-6, D-7)', () => {
    it('runs on the frozen route when the producing attempt recorded one', async () => {
      const execute = vi.fn(async () => ({ text: 'ok' }));
      const route = await createRegenerationRoute({
        ...base,
        snapshotGenerationRoute: FROZEN,
        execute: execute as never,
      });
      await route.aiCallFor('scene-content:slide')('s', 'u');
      expect(policyMocks.configured).toHaveBeenCalledWith('MATH', FROZEN);
      const [policy] = execute.mock.calls[0] as unknown as [{ policyVersion: string }];
      expect(policy.policyVersion).toBe('configured-test');
      expect(route.description).toEqual({
        mode: 'enforced',
        subjectCode: 'MATH',
        policyVersion: 'configured-test',
        primary: 'openai:gpt-6.1-terra',
        fallback: 'qwen:qwen3.7-flash',
      });
    });

    it('D-7: a frozen route that can no longer resolve runs on today’s table, and the switch is recorded', async () => {
      policyMocks.configured.mockRejectedValue(
        new TeachingPackageError(
          'SUBJECT_ROUTE_UNAVAILABLE',
          'subject MATH: primary model openai:gpt-6.1-terra cannot be resolved (no API key)',
        ),
      );
      const execute = vi.fn(async () => ({ text: 'ok' }));
      const route = await createRegenerationRoute({
        ...base,
        snapshotGenerationRoute: FROZEN,
        execute: execute as never,
      });
      await route.aiCallFor('scene-actions')('s', 'u');
      const [policy] = execute.mock.calls[0] as unknown as [{ policyVersion: string }];
      expect(policy.policyVersion).toBe('r1-test');
      expect(route.description).toEqual({
        mode: 'enforced',
        subjectCode: 'MATH',
        policyVersion: 'r1-test',
        primary: 'qwen:primary',
        fallback: 'openai:fallback',
        routeReplaced: {
          from: FROZEN,
          reason:
            'subject MATH: primary model openai:gpt-6.1-terra cannot be resolved (no API key)',
        },
      });
    });

    it('no frozen route, or a malformed one: today’s table, nothing recorded', async () => {
      for (const snapshotGenerationRoute of [undefined, { primary: 'openai:gpt-6-sol' }]) {
        const route = await createRegenerationRoute({ ...base, snapshotGenerationRoute });
        expect(route.description).toEqual({
          mode: 'enforced',
          subjectCode: 'MATH',
          policyVersion: 'r1-test',
          primary: 'qwen:primary',
          fallback: 'openai:fallback',
        });
      }
      expect(policyMocks.configured).not.toHaveBeenCalled();
    });

    it('any other failure is not replaced', async () => {
      policyMocks.configured.mockRejectedValue(new Error('registry exploded'));
      await expect(
        createRegenerationRoute({ ...base, snapshotGenerationRoute: FROZEN }),
      ).rejects.toThrow('registry exploded');
    });
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
