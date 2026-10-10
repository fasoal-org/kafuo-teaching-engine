import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { VerifiedLearnerGrant } from '@/lib/server/tutor/guards';
import type { TutorRuntimeDeps } from '@/lib/server/tutor/runtime-deps';

/**
 * W2-C3 on the Stage Help path:
 *
 * - ET-17: the learner grant carries the Package's `help` feature (contracts §3.2).
 *   A grant that says no is refused before any read, session or model call, as
 *   `ALLOWANCE_EXHAUSTED` with `details.reason: feature_not_in_package` — the same
 *   envelope the meter reserve's refusal gets, so the app shows the same sheet.
 * - ET-34: the meter scope names the learning item (`learningItemId`,
 *   `learningItemType`); `lessonId` stays as the deprecated alias of the same id.
 */

const mocks = vi.hoisted(() => ({
  readLearnerScene: vi.fn(),
  readContentUnitsForVersion: vi.fn(),
  upsertHelpSession: vi.fn(),
  runTutorTurn: vi.fn(),
}));

vi.mock('@/lib/server/teaching-package/learner-scene', () => ({
  readLearnerScene: mocks.readLearnerScene,
}));

vi.mock('@/lib/persistence/teaching-package', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/persistence/teaching-package')>()),
  readContentUnitsForVersion: mocks.readContentUnitsForVersion,
}));

vi.mock('@/lib/persistence/tutor-runtime', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/persistence/tutor-runtime')>()),
  upsertHelpSession: mocks.upsertHelpSession,
}));

vi.mock('@/lib/server/tutor/turn-runner', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/server/tutor/turn-runner')>()),
  runTutorTurn: mocks.runTutorTurn,
}));

vi.mock('@/lib/server/resolve-model', async () => {
  const providers = await import('@/lib/ai/providers');
  return {
    resolveModel: async ({ modelString }: { modelString: string }) => {
      const { providerId, modelId } = providers.parseModelString(modelString);
      return {
        model: { provider: providerId, modelId },
        modelInfo: providers.getModelInfo(providerId, modelId),
        modelString,
        providerId,
        modelId,
        apiKey: 'k',
      };
    },
  };
});

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

function grant(help: boolean): VerifiedLearnerGrant {
  return {
    tenantId: '1',
    versionId: 'v-1',
    stageId: 'stage-1',
    capability: 'read',
    learnerKey: 'tp:learner',
    exp: Date.now() + 60_000,
    purpose: 'learner',
    student: {
      studentRef: 'abcdefghijklmnopqrstuvwx',
      academic: { curriculumName: 'N', curriculumVersionLabel: '2026', gradeLabel: 'G9' },
      subject: { code: 'MATH', nameAr: 'الرياضيات', nameEn: 'Math', academicLanguage: 'ar' },
      entitlements: { help },
    },
  } as VerifiedLearnerGrant;
}

const deps = {
  pool: {
    query: async () => {
      throw new Error('no database read is expected here');
    },
  },
  kafuo: {},
  now: () => 1_800_000_000_000,
  idFactory: () => 'id-1',
} as unknown as TutorRuntimeDeps;

const INPUT = {
  versionId: 'v-1',
  stageId: 'stage-1',
  sceneId: 'scene-1',
  clientMessageId: 'cm-1',
  text: 'لماذا يكون الناتج سالبًا؟',
};

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.readLearnerScene.mockResolvedValue({
    version: { id: 'v-1', currentStageId: 'stage-1', learningItem: { type: 'lesson', id: '123' } },
    document: { stage: { name: 'الدرس' }, outline: {} },
    scene: { id: 'scene-1', sourceContentUnitIds: ['u-1'] },
    sceneTitle: 'المشهد',
    sceneText: 'نص المشهد عن الأعداد السالبة',
  });
  mocks.readContentUnitsForVersion.mockResolvedValue({
    lineageStatus: 'own_attempt',
    resolvedAttemptId: null,
    units: [{ unitId: 'u-1', title: 'الأعداد', normalizedText: 'الأعداد السالبة أقل من الصفر' }],
  });
  mocks.upsertHelpSession.mockResolvedValue({
    id: 'hs-1',
    tenantId: '1',
    studentRef: 'abcdefghijklmnopqrstuvwx',
  });
  mocks.runTutorTurn.mockResolvedValue(new Response('ok'));
});

describe('Stage Help and the Help entitlement (ET-17)', () => {
  it('refuses a grant without Help before any read, session or model call', async () => {
    const { runHelpTurn } = await import('@/lib/server/tutor/help-service');
    await expect(runHelpTurn(deps, { ...INPUT, grant: grant(false) })).rejects.toMatchObject({
      code: 'ALLOWANCE_EXHAUSTED',
      status: 429,
      details: { reason: 'feature_not_in_package', window: null, resetAt: null },
    });
    expect(mocks.readLearnerScene).not.toHaveBeenCalled();
    expect(mocks.upsertHelpSession).not.toHaveBeenCalled();
    expect(mocks.runTutorTurn).not.toHaveBeenCalled();
  });

  it('the anchor still answers first for a wrong version (non-enumerating 404)', async () => {
    const { runHelpTurn } = await import('@/lib/server/tutor/help-service');
    await expect(
      runHelpTurn(deps, { ...INPUT, versionId: 'other', grant: grant(false) }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('Stage Help meter scope (ET-34)', () => {
  it('names the learning item, keeping lessonId as its alias', async () => {
    const { runHelpTurn } = await import('@/lib/server/tutor/help-service');
    await runHelpTurn(deps, { ...INPUT, grant: grant(true) });
    expect(mocks.runTutorTurn).toHaveBeenCalledTimes(1);
    const plan = mocks.runTutorTurn.mock.calls[0]![0] as {
      meterScope: unknown;
      capability: string;
    };
    expect(plan.capability).toBe('help');
    expect(plan.meterScope).toEqual({
      helpSessionId: 'hs-1',
      lessonId: '123',
      learningItemId: '123',
      learningItemType: 'lesson',
    });
  });
});
