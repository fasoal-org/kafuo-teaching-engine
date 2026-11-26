/**
 * "Regenerate as the original" (teaching-generation-model-admin-config-plan-
 * 2026-11-18 D-18; s6-s7-readiness §1.4 G1(b)): the version's producing attempt
 * decides the route of a pinned regeneration, and a pin that cannot be honoured
 * is refused before any attempt — never replaced by today's route.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { KafuoGenerationContext } from '@/lib/server/teaching-package/kafuo-request';
import { SUBJECT_MODEL_POLICY } from '@/lib/server/teaching-model/subject-policy';
import type { GenerationModelRoute } from '@/lib/types/teaching-package';

const mocks = vi.hoisted(() => ({ retained: vi.fn(), assertAvailable: vi.fn() }));

vi.mock('@/lib/persistence/teaching-package', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/persistence/teaching-package')>()),
  readRetainedVersionContext: (...args: unknown[]) => mocks.retained(...args),
}));
vi.mock('@/lib/server/teaching-package/kafuo-request', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/server/teaching-package/kafuo-request')>()),
  assertConfiguredGenerationRouteAvailable: (kafuo: unknown) => mocks.assertAvailable(kafuo),
}));

import { resolveOriginalRoutePin } from '@/lib/server/teaching-package/original-route-pin';

const ROUTE: GenerationModelRoute = {
  primary: { model: 'openai:gpt-6.1-terra', thinking: 'medium' },
  fallback: { model: 'qwen:qwen3.7-flash', thinking: 'off' },
  settingKey: 'teaching_generation.route.MATH',
};
const PLAN: GenerationModelRoute = {
  primary: { model: 'anthropic:claude-opus-5-5', thinking: 'high' },
  fallback: { model: 'openai:gpt-6.1-terra', thinking: 'medium' },
  settingKey: 'teaching_generation.plan_route.MATH',
};
const POOL = { query: vi.fn() } as never;

function context(overrides: Partial<KafuoGenerationContext> = {}): KafuoGenerationContext {
  return {
    aggregate: { tenantId: 'tenant-1', learningItem: { type: 'lesson', id: '901' } },
    teachingSkillsContract: null,
    teachingFlow: [],
    teachingModel: { key: 'g5', version: 'g5.v11' },
    learningObjectives: [],
    requirement: 'r',
    language: 'ar',
    contentResource: { id: 'cs-1', url: 'https://r2/pdf', mimeType: 'application/pdf' },
    generation: {},
    versionId: 'tpv-1',
    subjectCode: 'MATH',
    subjectOffering: null,
    routePin: 'original',
    ...overrides,
  } as KafuoGenerationContext;
}

function producing(snapshot: Record<string, unknown>) {
  return {
    attemptId: 'tpa-original',
    inputSnapshot: snapshot,
    sourceText: null,
    sourceTruncated: false,
  };
}

const TABLE = SUBJECT_MODEL_POLICY.MATH;

beforeEach(() => {
  mocks.retained.mockReset();
  mocks.assertAvailable.mockReset();
  vi.unstubAllEnvs();
  vi.stubEnv('TEACHING_SUBJECT_ROUTING', 'enforced');
});

describe('resolveOriginalRoutePin', () => {
  it('no pin: null, and nothing is read', async () => {
    const { routePin: _pin, ...unpinned } = context();
    expect(await resolveOriginalRoutePin(POOL, unpinned as KafuoGenerationContext)).toBeNull();
    expect(mocks.retained).not.toHaveBeenCalled();
  });

  it('a configured original: its frozen generation and planning routes, checked for keys', async () => {
    mocks.retained.mockResolvedValue(
      producing({
        subjectCode: 'MATH',
        policyVersion: 'configured-2026-11',
        primaryModel: ROUTE.primary.model,
        fallbackModel: ROUTE.fallback.model,
        generationRoute: ROUTE,
        planRoute: PLAN,
      }),
    );
    const result = await resolveOriginalRoutePin(POOL, context());
    expect(mocks.retained).toHaveBeenCalledWith(POOL, 'tpv-1', { tenantId: 'tenant-1' });
    expect(result?.routePin).toEqual({ mode: 'original', sourceAttemptId: 'tpa-original' });
    expect(result?.kafuo.modelRoute).toEqual(ROUTE);
    expect(result?.kafuo.planRoute).toEqual(PLAN);
    expect(mocks.assertAvailable).toHaveBeenCalledWith(result?.kafuo);
  });

  it('an original on the code table: no route at all, while today’s table is the same', async () => {
    mocks.retained.mockResolvedValue(
      producing({
        subjectCode: 'MATH',
        policyVersion: 'r1-2026-09',
        primaryModel: TABLE.primary.model,
        fallbackModel: TABLE.fallback.model,
      }),
    );
    const result = await resolveOriginalRoutePin(POOL, context());
    expect(result?.kafuo).not.toHaveProperty('modelRoute');
    expect(result?.kafuo).not.toHaveProperty('planRoute');
    expect(result?.routePin.sourceAttemptId).toBe('tpa-original');
  });

  it('an original planned on its own route over the table keeps that planning route', async () => {
    mocks.retained.mockResolvedValue(
      producing({
        subjectCode: 'MATH',
        policyVersion: 'r1-2026-09',
        primaryModel: TABLE.primary.model,
        fallbackModel: TABLE.fallback.model,
        planRoute: PLAN,
      }),
    );
    const result = await resolveOriginalRoutePin(POOL, context());
    expect(result?.kafuo).not.toHaveProperty('modelRoute');
    expect(result?.kafuo.planRoute).toEqual(PLAN);
  });

  it.each([
    [
      'the table changed models under the same label',
      {
        subjectCode: 'MATH',
        policyVersion: 'r1-2026-09',
        primaryModel: 'openai:gpt-5.6-luna',
        fallbackModel: TABLE.fallback.model,
      },
    ],
    [
      'the table version changed',
      {
        subjectCode: 'MATH',
        policyVersion: 'r1-2026-08',
        primaryModel: TABLE.primary.model,
        fallbackModel: TABLE.fallback.model,
      },
    ],
    ['no subject route was recorded', { subjectCode: 'MATH' }],
    [
      'the frozen route left the catalogue',
      {
        subjectCode: 'MATH',
        policyVersion: 'configured-2026-11',
        generationRoute: { ...ROUTE, primary: { model: 'openai:gpt-5-nano', thinking: 'low' } },
      },
    ],
    [
      'the frozen route names another subject',
      {
        subjectCode: 'MATH',
        policyVersion: 'configured-2026-11',
        generationRoute: { ...ROUTE, settingKey: 'teaching_generation.route.PHYSICS' },
      },
    ],
    [
      'the original ran under another subject',
      {
        subjectCode: 'PHYSICS',
        policyVersion: 'r1-2026-09',
        primaryModel: TABLE.primary.model,
        fallbackModel: TABLE.fallback.model,
      },
    ],
  ])('refuses when %s (ORIGINAL_ROUTE_UNAVAILABLE, 409)', async (_label, snapshot) => {
    mocks.retained.mockResolvedValue(producing(snapshot));
    await expect(resolveOriginalRoutePin(POOL, context())).rejects.toMatchObject({
      code: 'ORIGINAL_ROUTE_UNAVAILABLE',
      status: 409,
      details: expect.objectContaining({ versionId: 'tpv-1', sourceAttemptId: 'tpa-original' }),
    });
    expect(mocks.assertAvailable).not.toHaveBeenCalled();
  });

  it('refuses a version with no producing attempt', async () => {
    mocks.retained.mockResolvedValue(null);
    await expect(resolveOriginalRoutePin(POOL, context())).rejects.toMatchObject({
      code: 'ORIGINAL_ROUTE_UNAVAILABLE',
    });
  });

  it('refuses while subject routing is off, before any read', async () => {
    vi.stubEnv('TEACHING_SUBJECT_ROUTING', 'off');
    await expect(resolveOriginalRoutePin(POOL, context())).rejects.toMatchObject({
      code: 'ORIGINAL_ROUTE_UNAVAILABLE',
    });
    expect(mocks.retained).not.toHaveBeenCalled();
  });

  it('a pinned route whose model has no server key is refused by the key check, as a sent route', async () => {
    mocks.retained.mockResolvedValue(
      producing({
        subjectCode: 'MATH',
        policyVersion: 'configured-2026-11',
        generationRoute: ROUTE,
      }),
    );
    mocks.assertAvailable.mockImplementation(() => {
      throw Object.assign(new Error('no key'), { code: 'GENERATION_ROUTE_UNAVAILABLE' });
    });
    await expect(resolveOriginalRoutePin(POOL, context())).rejects.toMatchObject({
      code: 'GENERATION_ROUTE_UNAVAILABLE',
    });
  });
});
