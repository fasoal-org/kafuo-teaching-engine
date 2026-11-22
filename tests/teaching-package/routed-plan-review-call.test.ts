/**
 * The model call of the plan review run on a paused attempt (P3,
 * package-plan-review-p3-contract-2026-11-22): the planning route frozen on the
 * attempt, resolved by the first call (a route failure is a failed call, so the rule
 * fixes survive), metered like the run's own outline calls; the stage route when
 * subject routing is off.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { GenerationAttempt } from '@/lib/types/teaching-package';

const mocks = vi.hoisted(() => ({
  resolveFrozenPlanRoute: vi.fn(),
  createGenerationAiCallFactory: vi.fn(),
  executeTeachingCall: vi.fn(),
  routedCallOptions: vi.fn(),
}));

vi.mock('@/lib/server/teaching-model/frozen-generation-route', () => ({
  resolveFrozenPlanRoute: mocks.resolveFrozenPlanRoute,
}));
vi.mock('@/lib/server/agent-runtime/generation-ai-call', () => ({
  createGenerationAiCallFactory: mocks.createGenerationAiCallFactory,
}));
vi.mock('@/lib/server/teaching-model/execute', () => ({
  executeTeachingCall: mocks.executeTeachingCall,
}));
vi.mock('@/lib/server/classroom-generation', () => ({
  routedCallOptions: mocks.routedCallOptions,
}));

import { createPlanReviewAiCall } from '@/lib/server/teaching-package/routed-plan-review-call';

const PLAN_ROUTE = { model: 'qwen-plan', thinking: 'on' };
const GENERATION_ROUTE = { model: 'qwen-gen' };

function pausedAttempt(): GenerationAttempt {
  return {
    id: 'tpa-paused-1',
    tenantId: 'tenant-9',
    learningItem: { type: 'lesson', id: '412' },
    inputSnapshot: {
      subjectCode: 'MATH',
      planRoute: PLAN_ROUTE,
      generationRoute: GENERATION_ROUTE,
    },
  } as unknown as GenerationAttempt;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  mocks.routedCallOptions.mockReturnValue({ timeoutMs: 1234 });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('createPlanReviewAiCall', () => {
  it('runs on the frozen planning route, resolved by the first call, metered as the paused run', async () => {
    const policy = { route: 'frozen-plan-policy' };
    mocks.resolveFrozenPlanRoute.mockResolvedValue({ policy });
    mocks.executeTeachingCall.mockResolvedValue({ text: '{"ops": []}' });

    const call = createPlanReviewAiCall({ attempt: pausedAttempt(), generationRun: 3 });
    // Making the call resolves nothing: a route failure must surface as a failed call.
    expect(mocks.resolveFrozenPlanRoute).not.toHaveBeenCalled();

    await expect(call('system prompt', 'user prompt')).resolves.toBe('{"ops": []}');
    expect(mocks.resolveFrozenPlanRoute).toHaveBeenCalledWith({
      subjectCode: 'MATH',
      frozenPlanRoute: PLAN_ROUTE,
      frozenGenerationRoute: GENERATION_ROUTE,
      step: expect.stringContaining('tpa-paused-1'),
    });
    expect(mocks.executeTeachingCall).toHaveBeenCalledWith(
      policy,
      {
        tenantId: 'tenant-9',
        capability: 'package_generation',
        stage: 'scene-outlines-stream',
        origin: 'openmaic_runtime',
        association: {
          kind: 'generation',
          generationAttemptId: 'tpa-paused-1',
          generationRun: 3,
          versionId: null,
          learningItemType: 'lesson',
          learningItemId: '412',
        },
      },
      {
        messages: [
          { role: 'system', content: 'system prompt' },
          { role: 'user', content: 'user prompt' },
        ],
      },
      { timeoutMs: 1234 },
    );
    expect(mocks.routedCallOptions).toHaveBeenCalledWith('scene-outlines-stream', undefined);

    // The second round reuses the route it resolved.
    await call('system prompt', 'round 2');
    expect(mocks.resolveFrozenPlanRoute).toHaveBeenCalledTimes(1);
    expect(mocks.executeTeachingCall).toHaveBeenCalledTimes(2);
  });

  it('uses an injected executor', async () => {
    mocks.resolveFrozenPlanRoute.mockResolvedValue({ policy: { route: 'p' } });
    const execute = vi.fn(async () => ({ text: 'answer' }));
    const call = createPlanReviewAiCall({
      attempt: pausedAttempt(),
      generationRun: 1,
      execute: execute as never,
    });
    await expect(call('s', 'u')).resolves.toBe('answer');
    expect(execute).toHaveBeenCalledTimes(1);
    expect(mocks.executeTeachingCall).not.toHaveBeenCalled();
  });

  it('a route that cannot be resolved fails the call itself, never the making of it', async () => {
    const spent = new Error('route unavailable');
    mocks.resolveFrozenPlanRoute.mockRejectedValue(spent);

    const call = createPlanReviewAiCall({ attempt: pausedAttempt(), generationRun: 2 });
    await expect(call('s', 'u')).rejects.toBe(spent);
    expect(mocks.executeTeachingCall).not.toHaveBeenCalled();
  });

  it('uses the stage route when subject routing is off, and never the frozen route', async () => {
    vi.stubEnv('TEACHING_SUBJECT_ROUTING', 'off');
    const stageCall = vi.fn(async () => 'stage answer');
    const factory = vi.fn(() => stageCall);
    mocks.createGenerationAiCallFactory.mockReturnValue(factory);

    const call = createPlanReviewAiCall({ attempt: pausedAttempt(), generationRun: 1 });
    expect(factory).toHaveBeenCalledWith('scene-outlines-stream');
    await expect(call('s', 'u')).resolves.toBe('stage answer');
    expect(mocks.resolveFrozenPlanRoute).not.toHaveBeenCalled();
    expect(mocks.executeTeachingCall).not.toHaveBeenCalled();
  });
});
