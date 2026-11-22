/**
 * The planning and review route of a later step on the same package
 * (package-planner-issue-resolve-plan-2026-11-22 §3c, D-5): the frozen
 * `input_snapshot.planRoute`, else the frozen generation route, else today's
 * table; an unresolvable frozen plan route is replaced by the table and the
 * switch is recorded, exactly like the generation route (D-7).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { TeachingPackageError } from '@/lib/server/teaching-package/errors';
import type { GenerationModelRoute } from '@/lib/types/teaching-package';

const mocks = vi.hoisted(() => ({ configured: vi.fn(), warn: vi.fn() }));

vi.mock('@/lib/server/teaching-model/resolve-policy', () => ({
  resolveSubjectModelPolicy: async (code: string) => ({
    subjectCode: code,
    policyVersion: 'r1-test',
    primary: { modelString: 'qwen:primary' },
    fallback: { modelString: 'openai:fallback' },
  }),
  resolveConfiguredGenerationPolicy: (code: string, route: GenerationModelRoute, field?: string) =>
    mocks.configured(code, route, field),
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: mocks.warn, error: vi.fn(), debug: vi.fn() }),
}));

const PLAN: GenerationModelRoute = {
  primary: { model: 'anthropic:claude-opus-5-5', thinking: 'high' },
  fallback: { model: 'openai:gpt-6.1-terra', thinking: 'medium' },
  settingKey: 'teaching_generation.plan_route.MATH',
};
const GENERATION: GenerationModelRoute = {
  primary: { model: 'openai:gpt-6.1-terra', thinking: 'medium' },
  fallback: { model: 'qwen:qwen3.7-flash', thinking: 'off' },
  settingKey: 'teaching_generation.route.MATH',
};

beforeEach(() => {
  mocks.warn.mockReset();
  mocks.configured.mockReset();
  mocks.configured.mockImplementation(async (code: string, route: GenerationModelRoute) => ({
    subjectCode: code,
    policyVersion: 'configured-test',
    primary: { modelString: route.primary.model },
    fallback: { modelString: route.fallback.model },
  }));
});

async function resolve(frozenPlanRoute: unknown, frozenGenerationRoute: unknown) {
  const { resolveFrozenPlanRoute } =
    await import('@/lib/server/teaching-model/frozen-generation-route');
  return resolveFrozenPlanRoute({
    subjectCode: 'MATH',
    frozenPlanRoute,
    frozenGenerationRoute,
    step: 'plan review tpa-1',
  });
}

describe('resolveFrozenPlanRoute', () => {
  it('a frozen planning route runs as configured', async () => {
    const result = await resolve(PLAN, GENERATION);
    expect(mocks.configured).toHaveBeenCalledTimes(1);
    // Resolved under its own key family, never by trusting the stored key.
    expect(mocks.configured).toHaveBeenCalledWith('MATH', PLAN, 'planRoute');
    expect(result.policy.primary.modelString).toBe('anthropic:claude-opus-5-5');
    expect(result).not.toHaveProperty('routeReplaced');
  });

  it('no frozen planning route: planning follows the frozen generation route (D-5 default)', async () => {
    const result = await resolve(undefined, GENERATION);
    expect(mocks.configured).toHaveBeenCalledWith('MATH', GENERATION, 'modelRoute');
    expect(result.policy.primary.modelString).toBe('openai:gpt-6.1-terra');
  });

  it('neither route frozen: today’s table', async () => {
    const result = await resolve(undefined, undefined);
    expect(mocks.configured).not.toHaveBeenCalled();
    expect(result.policy.policyVersion).toBe('r1-test');
  });

  it('a malformed frozen planning route reads as absent, with a warning, and follows the generation route', async () => {
    const result = await resolve({ primary: 'anthropic:claude-opus-5-5' }, GENERATION);
    expect(mocks.configured).toHaveBeenCalledWith('MATH', GENERATION, 'modelRoute');
    expect(result.policy.primary.modelString).toBe('openai:gpt-6.1-terra');
    expect(mocks.warn).toHaveBeenCalledWith(expect.stringContaining('planRoute is malformed'));
  });

  it('D-7: a frozen planning route that can no longer resolve runs on today’s table, and the switch is recorded', async () => {
    mocks.configured.mockRejectedValue(
      new TeachingPackageError(
        'SUBJECT_ROUTE_UNAVAILABLE',
        'subject MATH: primary model anthropic:claude-opus-5-5 cannot be resolved (no API key)',
      ),
    );
    const result = await resolve(PLAN, GENERATION);
    expect(result.policy.policyVersion).toBe('r1-test');
    expect(result.routeReplaced).toEqual({
      from: PLAN,
      reason:
        'subject MATH: primary model anthropic:claude-opus-5-5 cannot be resolved (no API key)',
    });
    expect(mocks.warn).toHaveBeenCalledWith(
      expect.stringContaining('the frozen planning route teaching_generation.plan_route.MATH'),
    );
  });

  it('any other failure is not replaced', async () => {
    mocks.configured.mockRejectedValue(new Error('registry exploded'));
    await expect(resolve(PLAN, GENERATION)).rejects.toThrow('registry exploded');
  });
});
