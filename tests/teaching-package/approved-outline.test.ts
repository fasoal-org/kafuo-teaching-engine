/**
 * The scene outline of an APPROVED Teaching Package version, read by Kafuo's runner:
 * approved-only, tenant/item scoped, structure only, scenes in order.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  projectOutlineScenes,
  readApprovedOutline,
} from '@/lib/server/teaching-package/approved-outline';
import type { AppScene } from '@/lib/types/stage';
import type { TeachingPackageVersion } from '@/lib/types/teaching-package';
import { makeSlideScene } from '../agent-runtime/_stage-fixtures';

const mocks = vi.hoisted(() => ({
  readVersion: vi.fn(),
  readRetainedVersionContext: vi.fn(),
  loadDocument: vi.fn(),
}));

vi.mock('@/lib/persistence/teaching-package', () => ({
  readVersion: mocks.readVersion,
  readRetainedVersionContext: mocks.readRetainedVersionContext,
}));
vi.mock('@/lib/server/agent-runtime/owner-scoped-documents', () => ({
  getOwnerScopedDocumentStore: async () => ({ loadDocument: mocks.loadDocument }),
}));

const G5_V3 = { key: 'g5', version: 'g5.v3' };

function slide(id: string, order: number, key: string, flowIndex: number, role?: string) {
  const base = makeSlideScene(id, 'stage-1', order, `title ${id}`) as AppScene;
  const content = base.content as Record<string, unknown>;
  if (role) content.contentRole = role;
  return {
    ...base,
    teachingStage: { key, flowIndex },
    actions: [{ id: `${id}-a`, type: 'speech', text: 'hi' }],
  } as unknown as AppScene;
}

function scenes(): AppScene[] {
  const quiz = {
    ...(makeSlideScene('q1', 'stage-1', 4, 'check') as AppScene),
    content: { type: 'quiz', questions: [{ id: 'x', answer: ['A'] }] },
    teachingStage: { key: 'outcome_check_understanding', flowIndex: 4 },
    actions: [],
  } as unknown as AppScene;
  return [
    quiz,
    slide('s2', 2, 'outcome_visual_explanations', 2, 'explanation'),
    slide('s1', 1, 'lesson_opener', 0),
    slide('s3', 3, 'outcome_worked_examples', 3, 'worked_example'),
  ];
}

function version(overrides: Partial<TeachingPackageVersion> = {}): TeachingPackageVersion {
  return {
    id: 'tpv-approved0001',
    tenantId: '7',
    learningItem: { type: 'lesson', id: '123' },
    version: 1,
    status: 'approved',
    currentStageId: 'stage-1',
    currentAttemptId: null,
    teachingModel: G5_V3,
    predecessorVersionId: null,
    supersededByVersionId: null,
    submittedStageRev: 1,
    createdAt: 0,
    updatedAt: 0,
    submittedAt: 0,
    approvedAt: 0,
    supersededAt: null,
    discardedAt: null,
    ...overrides,
  };
}

const REQUEST = {
  versionId: 'tpv-approved0001',
  tenantId: '7',
  learningItem: { type: 'lesson' as const, id: '123' },
};

describe('projectOutlineScenes', () => {
  it('sorts by order and projects structure only', () => {
    const outline = projectOutlineScenes(scenes());
    expect(outline.map((s) => s.sceneId)).toEqual(['s1', 's2', 's3', 'q1']);
    expect(outline[1]).toEqual({
      sceneId: 's2',
      order: 2,
      type: 'slide',
      title: 'title s2',
      stageKey: 'outcome_visual_explanations',
      flowIndex: 2,
      contentRole: 'explanation',
      hasNarration: true,
    });
    expect(outline[3]).toMatchObject({ type: 'quiz', contentRole: null, hasNarration: false });
    expect(JSON.stringify(outline)).not.toContain('answer');
  });
});

describe('readApprovedOutline', () => {
  beforeEach(() => {
    mocks.readVersion.mockReset();
    mocks.loadDocument.mockReset();
    mocks.readRetainedVersionContext.mockReset();
    mocks.loadDocument.mockResolvedValue({ scenes: scenes() });
    mocks.readRetainedVersionContext.mockResolvedValue({
      inputSnapshot: {
        learningObjectives: [{ objectiveRef: '67' }, { objectiveRef: '68' }],
        teachingFlow: [{ stage: 'lesson_opener' }, { stage: 'lesson_learning_map' }],
      },
    });
  });

  it('returns the retained objectives and flow with the ordered scenes', async () => {
    mocks.readVersion.mockResolvedValue(version());
    const result = await readApprovedOutline({} as never, REQUEST);
    expect(mocks.readVersion).toHaveBeenCalledWith({}, 'tpv-approved0001', { tenantId: '7' });
    expect(result.stageId).toBe('stage-1');
    expect(result.objectiveRefs).toEqual(['67', '68']);
    expect(result.flowStages).toEqual(['lesson_opener', 'lesson_learning_map']);
    expect(result.scenes).toHaveLength(4);
  });

  it.each(['draft', 'in_review', 'rejected', 'superseded', 'discarded'] as const)(
    'refuses a %s version and never reads its stage',
    async (status) => {
      mocks.readVersion.mockResolvedValue(version({ status }));
      await expect(readApprovedOutline({} as never, REQUEST)).rejects.toMatchObject({
        code: 'TEACHING_PACKAGE_NOT_APPROVED',
      });
      expect(mocks.loadDocument).not.toHaveBeenCalled();
    },
  );

  it('refuses another learning item', async () => {
    mocks.readVersion.mockResolvedValue(version({ learningItem: { type: 'lesson', id: '999' } }));
    await expect(readApprovedOutline({} as never, REQUEST)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('refuses a stage that is not live', async () => {
    mocks.readVersion.mockResolvedValue(version());
    mocks.loadDocument.mockResolvedValue(null);
    await expect(readApprovedOutline({} as never, REQUEST)).rejects.toMatchObject({
      code: 'STAGE_NOT_LIVE',
    });
  });
});
