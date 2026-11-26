import { describe, expect, it, vi } from 'vitest';
import type { GeneratedSceneContent, SceneOutline } from '@openmaic/generation';
import type { StageAPI } from '@/lib/api/stage-api';
import type { CreateSceneParams } from '@/lib/api/stage-api-types';
import type { SceneTeachingSkills } from '@/lib/types/teaching-package';
import { createSceneWithActions } from '@/lib/server/scene-generation';

function outline(type: SceneOutline['type']): SceneOutline {
  return {
    id: `outline-${type}`,
    type,
    // A newly generated slide must be classified; other families carry none.
    ...(type === 'slide' && { slideType: 'content', contentRole: 'example' }),
    title: `${type} title`,
    description: `${type} description`,
    order: 2,
  } as SceneOutline;
}

function stageApi(result: { success: boolean; data?: string }) {
  const create = vi.fn((_params: CreateSceneParams) => result);
  return {
    create,
    api: { scene: { create } } as unknown as StageAPI,
  };
}

describe('createSceneWithActions app adapter', () => {
  it.each([
    ['slide', { elements: [], background: '#fff' }, { type: 'slide' }],
    ['quiz', { questions: [] }, { type: 'quiz', questions: [] }],
    [
      'interactive',
      { html: '<main>Interactive</main>', widgetType: 'diagram', widgetConfig: { nodes: [] } },
      {
        type: 'interactive',
        url: '',
        html: '<main>Interactive</main>',
        widgetType: 'diagram',
        widgetConfig: { nodes: [] },
      },
    ],
    ['pbl', { projectV2: { title: 'Project' } }, { type: 'pbl', projectV2: { title: 'Project' } }],
  ] as const)('persists package-built %s scenes through StageAPI', (type, content, expected) => {
    const { api, create } = stageApi({ success: true, data: `scene-${type}` });
    const sceneOutline = outline(type);

    expect(
      createSceneWithActions(sceneOutline, content as unknown as GeneratedSceneContent, [], api),
    ).toBe(`scene-${type}`);
    expect(create).toHaveBeenCalledOnce();
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        type,
        title: sceneOutline.title,
        order: sceneOutline.order,
        outlineId: sceneOutline.id,
        actions: [],
        content: expect.objectContaining(expected),
      }),
    );
  });

  it('creates the scene under a pre-minted id (S8-O1); absent, no id is sent', () => {
    const minted = stageApi({ success: true, data: 'scene_minted1' });
    const content = { questions: [] } as unknown as GeneratedSceneContent;
    expect(createSceneWithActions(outline('quiz'), content, [], minted.api, 'scene_minted1')).toBe(
      'scene_minted1',
    );
    expect(minted.create.mock.calls[0]![0].id).toBe('scene_minted1');
    const fresh = stageApi({ success: true, data: 'scene-fresh' });
    createSceneWithActions(outline('quiz'), content, [], fresh.api);
    expect(fresh.create.mock.calls[0]![0]).not.toHaveProperty('id');
  });

  it('the stage API keeps a supplied scene id and refuses a duplicate or empty one', async () => {
    const { createStageAPI } = await import('@/lib/api/stage-api');
    let state = {
      stage: { id: 'stage-1', name: 'S', createdAt: 1, updatedAt: 1 },
      scenes: [] as unknown[],
      currentSceneId: null,
      mode: 'autonomous',
    };
    const store = {
      getState: () => state,
      setState: (patch: Partial<typeof state>) => {
        state = { ...state, ...patch };
      },
    } as unknown as Parameters<typeof createStageAPI>[0];
    const api = createStageAPI(store);
    const first = api.scene.create({ id: 'scene_planned', type: 'quiz', title: 'Q' });
    expect(first).toEqual({ success: true, data: 'scene_planned' });
    expect(api.scene.create({ id: 'scene_planned', type: 'quiz', title: 'Q2' }).success).toBe(
      false,
    );
    expect(api.scene.create({ id: '  ', type: 'quiz', title: 'Q3' }).success).toBe(false);
    const generated = api.scene.create({ type: 'quiz', title: 'Q4' });
    expect(generated.success && generated.data).toMatch(/^scene_/);
    expect(state.scenes).toHaveLength(2);
  });

  it('returns null when the store rejects the package-built scene', () => {
    const { api } = stageApi({ success: false });
    expect(
      createSceneWithActions(
        outline('quiz'),
        { questions: [] } as unknown as GeneratedSceneContent,
        [],
        api,
      ),
    ).toBeNull();
  });
});

describe('createSceneWithActions — Teaching Skills carrier reaches api.scene.create', () => {
  // The Module 2 P0 defect this guards: buildCompleteScene emitted the carrier
  // on all four branches, but this projection dropped it before the store, so
  // no governed Scene was ever stamped or submittable. The assertions below
  // are exact-shape ON PURPOSE — `expect.objectContaining` cannot see an
  // omitted field and passed with the defect present.
  const carrier: SceneTeachingSkills = {
    primary: { skillId: 'feynman-learning', version: 'v1' },
    classification: 'instructional',
  };
  const teachingStage = { key: 'lesson_introduction', flowIndex: 0 };
  const quizContent = { questions: [] } as unknown as GeneratedSceneContent;

  it('forwards the carrier byte-equal on a carrier-bearing outline', () => {
    const { api, create } = stageApi({ success: true, data: 'scene-carrier' });
    const governedOutline = {
      ...outline('quiz'),
      teachingStage,
      teachingSkills: carrier,
    } as SceneOutline;

    expect(createSceneWithActions(governedOutline, quizContent, [], api)).toBe('scene-carrier');
    expect(create).toHaveBeenCalledOnce();

    const params = create.mock.calls[0]![0];
    // Exact key set: a future omission (or a present-but-undefined key) fails.
    expect(Object.keys(params).sort()).toEqual([
      'actions',
      'content',
      'order',
      'outlineId',
      'teachingSkills',
      'teachingStage',
      'title',
      'type',
    ]);
    expect(params.teachingSkills).toEqual(carrier);
    expect(params.teachingStage).toEqual(teachingStage);
  });

  it('omits the key entirely on a carrier-free outline — absence stays absence (AC-TS-034)', () => {
    const { api, create } = stageApi({ success: true, data: 'scene-bare' });

    expect(createSceneWithActions(outline('quiz'), quizContent, [], api)).toBe('scene-bare');
    expect(create).toHaveBeenCalledOnce();

    const params = create.mock.calls[0]![0];
    // The `in` idiom (scene-builder.test.ts), not toBeUndefined(): a key set to
    // undefined would fabricate lineage state on legacy/non-governed data.
    expect('teachingSkills' in params).toBe(false);
    expect(Object.keys(params).sort()).toEqual([
      'actions',
      'content',
      'order',
      'outlineId',
      'title',
      'type',
    ]);
  });
});
